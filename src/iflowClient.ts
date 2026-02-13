import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StreamChunk, ConversationMode, ModelType, AttachedFile } from './protocol';
import { ChunkMapper } from './chunkMapper';
import { ProcessManager, ManualStartInfo } from './processManager';

/**
 * Plan mode workflow instructions that the CLI normally injects via a
 * PLAN_MODE_ACTIVATED system-reminder into every user message.  The ACP path
 * never emits this event, so we compensate by appending it to the system prompt.
 */
const PLAN_MODE_INSTRUCTIONS = `
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.

## Enhanced Planning Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions.

1. Focus on understanding the user's request and the code associated with their request
2. Use read-only tools (read_file, glob, list_directory, search_file_content) to explore the codebase
3. If you need clarification, ask the user directly in your text response

### Phase 2: Planning
Goal: Come up with an approach to solve the problem identified in phase 1.
- Provide any background context that may help with the task
- Create a detailed plan using todo_write

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Ask the user any remaining questions directly in your text response

### Phase 4: Final Plan
Once you have all the information you need, provide your synthesized recommendation including:
- Recommended approach with rationale
- Key insights from different perspectives

### Phase 5: Call exit_plan_mode
CRITICAL: At the very end of your turn, once you are happy with your final plan, you MUST call the exit_plan_mode tool. This is mandatory.
Your turn should ONLY end by calling exit_plan_mode. Do NOT end your turn with just text - always call exit_plan_mode as the final action.

NOTE:
- At any point in time through this workflow you should feel free to ask the user questions or clarifications in your text response. Don't make large assumptions about user intent.
- The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
- IMPORTANT: You MUST call exit_plan_mode when your plan is ready. Never end your turn without calling this tool.
`.trim();

// SDK types (loaded dynamically)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SDKModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SDKClientType = any;

// Cache the dynamically imported SDK module
let sdkModule: SDKModule | null = null;

async function getSDK(): Promise<SDKModule> {
  if (!sdkModule) {
    sdkModule = await import('@iflow-ai/iflow-cli-sdk');
  }
  return sdkModule;
}

/** @internal Test-only helper to inject a mock SDK module. */
export function __setSDKModuleForTests(mod: SDKModule | null): void {
  sdkModule = mod;
}

export interface RunOptions {
  prompt: string;
  attachedFiles: AttachedFile[];
  mode: ConversationMode;
  think: boolean;
  model: ModelType;
  workspaceFiles?: string[];
  sessionId?: string;
}

export class IFlowClient {
  private client: SDKClientType | null = null;
  private outputChannel: vscode.OutputChannel | null = null;
  private isConnected = false;
  private isCancelled = false;
  private chunkMapper = new ChunkMapper(getSDK, (msg) => this.log(msg));
  private processManager = new ProcessManager(
    (msg) => this.log(msg),
    (msg) => this.logInfo(msg),
    () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  );
  // Pending permission requests: requestId -> resolve callback
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pendingPermissions = new Map<number, (response: any) => void>();

  private log(message: string): void {
    const debugLogging = vscode.workspace.getConfiguration('iflow').get<boolean>('debugLogging', false);
    if (debugLogging) {
      this.logInfo(message);
    }
  }

  /** Always log to Output channel (not gated by debugLogging). */
  private logInfo(message: string): void {
    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel('IFlow');
    }
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
    console.log('[IFlow]', message);
  }

  private getConfig() {
    const config = vscode.workspace.getConfiguration('iflow');
    return {
      nodePath: config.get<string | null>('nodePath', null),
      baseUrl: config.get<string | null>('baseUrl', null),
      port: config.get<number>('port', 8090),
      timeout: config.get<number>('timeout', 60000),
      debugLogging: config.get<boolean>('debugLogging', false),
    };
  }

  clearAutoDetectCache(): void {
    this.processManager.clearAutoDetectCache();
  }

  private getIFlowSettingsPath(): string {
    return path.join(os.homedir(), '.iflow', 'settings.json');
  }

  private updateIFlowCliModel(model: ModelType): void {
    try {
      const settingsPath = this.getIFlowSettingsPath();
      const content = fs.readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      if (settings.modelName !== model) {
        settings.modelName = model;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
        this.log(`Updated ~/.iflow/settings.json modelName to: ${model}`);
      }
    } catch (err) {
      this.log(`Failed to update iFlow CLI model: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private getSDKOptions(manualStart: ManualStartInfo | null): Record<string, unknown> {
    const config = this.getConfig();

    const options: Record<string, unknown> = {
      timeout: config.timeout,
      logLevel: config.debugLogging ? 'DEBUG' : 'WARN',
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      fileAccess: true,
    };

    if (manualStart) {
      // Connect to our manually started process
      options.autoStartProcess = false;
      options.url = `ws://localhost:${manualStart.port}/acp`;
    } else {
      // Let SDK manage the process
      options.autoStartProcess = true;
      options.processStartPort = config.port;
    }

    return options;
  }

  async checkAvailability(): Promise<{ version: string | null; diagnostics: string }> {
    const diag: string[] = [];
    diag.push(`platform: ${process.platform} (${process.arch})`);
    diag.push(`PATH (first 500): ${(process.env.PATH || '').substring(0, 500)}`);

    this.logInfo('=== Checking iFlow CLI availability ===');
    this.logInfo(`Platform: ${process.platform}, arch: ${process.arch}`);

    try {
      const config = this.getConfig();
      const manualStart = await this.processManager.resolveStartMode(config);

      if (manualStart) {
        diag.push(`nodePath: ${manualStart.nodePath}`);
        diag.push(`iflowScript: ${manualStart.iflowScript}`);
        diag.push(`port: ${manualStart.port}`);
        this.logInfo(`Resolved: node=${manualStart.nodePath}, script=${manualStart.iflowScript}, port=${manualStart.port}`);
        await this.processManager.startManagedProcess(manualStart.nodePath, manualStart.port, manualStart.iflowScript);
      } else {
        diag.push('mode: SDK auto-start (no manual node path resolved)');
        this.logInfo('No manual node path resolved, falling back to SDK auto-start');
      }

      const sdk = await getSDK();
      const testClient = new sdk.IFlowClient(this.getSDKOptions(manualStart));
      await testClient.connect();
      await testClient.disconnect();

      this.logInfo('iFlow CLI is available (SDK connected)');
      return { version: 'SDK Connected', diagnostics: diag.join('\n') };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      diag.push(`error: ${errorMsg}`);
      this.logInfo(`iFlow CLI not available: ${errorMsg}`);
      this.logInfo(`--- Diagnostics ---\n${diag.join('\n')}\n-------------------`);
      // Show output channel so user can see diagnostics
      this.outputChannel?.show(true);
      return { version: null, diagnostics: diag.join('\n') };
    } finally {
      // Don't stop the managed process here - keep it running for future connections
    }
  }

  async run(
    options: RunOptions,
    onChunk: (chunk: StreamChunk) => void,
    onEnd: () => void,
    onError: (error: string) => void
  ): Promise<string | undefined> {
    this.isCancelled = false;
    this.chunkMapper.reset();
    let returnSessionId: string | undefined;

    // Update model in CLI settings so all internal code paths use it
    this.updateIFlowCliModel(options.model);

    this.log(`Starting run with options: ${JSON.stringify({ mode: options.mode, model: options.model, think: options.think, sessionId: options.sessionId })}`);

    try {
      const config = this.getConfig();
      const manualStart = await this.processManager.resolveStartMode(config);

      // If using manual start and process isn't running, start it
      if (manualStart && !this.processManager.hasProcess) {
        await this.processManager.startManagedProcess(manualStart.nodePath, manualStart.port, manualStart.iflowScript);
      }

      const sessionSettings: Record<string, unknown> = {
        permission_mode: options.mode,
      };

      // In the ACP path the server never emits the PLAN_MODE_ACTIVATED reminder
      // that the CLI injects into every user message.  Compensate by appending the
      // critical plan-mode workflow instructions via append_system_prompt so the AI
      // reliably calls exit_plan_mode instead of ending the turn early.
      if (options.mode === 'plan') {
        sessionSettings.append_system_prompt = PLAN_MODE_INSTRUCTIONS;
      }

      const sdkOptions: Record<string, unknown> = {
        ...this.getSDKOptions(manualStart),
        sessionSettings,
      };

      const sdk = await getSDK();
      this.client = new sdk.IFlowClient(sdkOptions);
      await this.client.connect();
      this.patchTransport(this.client);
      this.patchQuestions(this.client);
      if (options.mode === 'default') {
        this.patchPermission(this.client);
      }
      this.isConnected = true;
      this.log('Connected to iFlow');

      // Load existing session to restore context from previous turns
      if (options.sessionId) {
        try {
          await this.client.loadSession(options.sessionId);
          this.log(`Loaded existing session: ${options.sessionId}`);
        } catch (err) {
          this.log(`Failed to load session ${options.sessionId}, continuing with new session: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Enable/disable thinking via ACP protocol
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sessionId = (this.client as any).sessionId;
      returnSessionId = sessionId;
      if (sessionId) {
        await this.sendSetThink(this.client, sessionId, options.think);
      }

      const prompt = this.chunkMapper.buildPrompt(options);

      // In plan mode, inject the plan-mode workflow as a <system-reminder> into
      // the user message itself — mirroring what the CLI does on every turn via
      // reminderManager.injectIntoUserMessage().  The ACP path skips that
      // injection, so we compensate here.
      const finalPrompt = options.mode === 'plan'
        ? `<system-reminder>\n${PLAN_MODE_INSTRUCTIONS}\n</system-reminder>\n\n${prompt}`
        : prompt;

      this.log(`Sending message: ${finalPrompt.substring(0, 100)}...`);
      await this.client.sendMessage(finalPrompt);

      for await (const message of this.client.receiveMessages()) {
        if (this.isCancelled) {
          this.log('Run cancelled');
          break;
        }

        const chunks = await this.chunkMapper.mapMessageToChunks(message);
        for (const chunk of chunks) {
          onChunk(chunk);
        }

        if (message.type === sdk.MessageType.TASK_FINISH) {
          this.log(`Task finished with reason: ${message.stopReason}`);
          break;
        }
      }

      onEnd();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(`Run error: ${errorMessage}`);
      onError(errorMessage);
    } finally {
      await this.disconnect();
    }
    return returnSessionId;
  }

  async cancel(): Promise<void> {
    this.log('Cancelling current operation');
    this.isCancelled = true;
    await this.disconnect();
  }

  private async disconnect(): Promise<void> {
    if (this.client && this.isConnected) {
      try {
        await this.client.disconnect();
        this.log('Disconnected from iFlow');
      } catch (error) {
        this.log(`Disconnect error: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.isConnected = false;
    }
    this.client = null;
  }

  /**
   * Full cleanup - disconnect SDK, stop managed process, clear caches
   */
  async dispose(): Promise<void> {
    await this.disconnect();
    this.processManager.stopManagedProcess();
    this.processManager.clearAutoDetectCache();
  }

  isRunning(): boolean {
    return this.isConnected && !this.isCancelled;
  }

  /**
   * Send session/set_think via the ACP protocol to enable/disable native thinking.
   */
  private async sendSetThink(client: SDKClientType, sessionId: string, enabled: boolean): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transport = (client as any).transport;
    if (!transport) {
      this.log('sendSetThink: transport not available, skipping');
      return;
    }
    const msg = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'session/set_think',
      params: { sessionId, thinkEnabled: enabled, thinkConfig: 'think' }
    };
    this.log(`Sending session/set_think: thinkEnabled=${enabled}`);
    await transport.send(msg);
  }

  /**
   * Monkey-patch SDK transport to prevent WebSocket message loss.
   *
   * The SDK's Transport.receiveRawData() registers a one-shot 'message' listener
   * per call. When multiple messages arrive in the same TCP segment, only the
   * first is received — subsequent message events fire with no listener attached.
   *
   * This patch adds a persistent listener that buffers messages, and overrides
   * receiveRawData() to consume from that buffer.
   */
  private patchTransport(client: SDKClientType): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transport = (client as any).transport;
    if (!transport?.ws) {
      this.log('patchTransport: transport or ws not available, skipping');
      return;
    }

    const ws = transport.ws;
    const queue: string[] = [];
    const waiters: Array<{ resolve: (msg: string) => void; reject: (err: Error) => void }> = [];

    // After connect(), the SDK has already called receiveRawData() once,
    // registering an old handler. The first message will be caught by BOTH
    // the old handler and our new listener. Skip it in our listener to
    // avoid duplicates.
    let skipNext = true;

    ws.on('message', (data: { toString(): string }) => {
      const msg = data.toString();
      if (skipNext) {
        skipNext = false;
        return; // Old handler also catches this one
      }
      if (waiters.length > 0) {
        waiters.shift()!.resolve(msg);
      } else {
        queue.push(msg);
      }
    });

    const rejectAll = (err: Error) => {
      while (waiters.length > 0) {
        waiters.shift()!.reject(err);
      }
    };

    ws.on('close', () => rejectAll(new Error('Connection closed')));
    ws.on('error', (err: Error) => rejectAll(err));

    transport.receiveRawData = function (): Promise<string> {
      if (!transport.isConnected) {
        return Promise.reject(new Error('Not connected'));
      }
      if (queue.length > 0) {
        return Promise.resolve(queue.shift()!);
      }
      return new Promise<string>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    };

    this.log('patchTransport: WebSocket message buffering installed');
  }

  /**
   * Monkey-patch SDK protocol to intercept _iflow/user/questions and _iflow/plan/exit
   * JSON-RPC methods. Without this patch, the SDK's handleUnknownMessage() returns
   * a -32601 error which causes the server to disconnect.
   */
  private patchQuestions(client: SDKClientType): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const protocol = (client as any).protocol;
    if (!protocol) {
      this.log('patchQuestions: protocol not available, skipping');
      return;
    }

    const self = this;
    const sendResult = protocol.sendResult.bind(protocol);
    const originalHandleClientMessage = protocol.handleClientMessage.bind(protocol);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messageQueue: any[] = (client as any).messageQueue;

    self.log(`patchQuestions: messageQueue exists=${!!messageQueue}, protocol.handleClientMessage exists=${typeof protocol.handleClientMessage}`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protocol.handleClientMessage = async function (message: any) {
      const { id, method, params } = message;

      // Log ALL incoming methods for debugging
      self.log(`patchQuestions: handleClientMessage method=${method}, id=${id}`);

      try {
        if (method === '_iflow/user/questions') {
          const questions = params?.questions || [];
          self.log(`patchQuestions: intercepted _iflow/user/questions id=${id}, questions=${JSON.stringify(questions).substring(0, 200)}`);

          // Push a marker message into messageQueue for the run() loop to forward to webview
          messageQueue.push({
            type: 'tool_call',
            id: String(id),
            label: 'Ask Question',
            icon: { type: 'emoji', value: '?' },
            status: 'pending',
            toolName: 'ask_user_question',
            _questionRequest: true,
            _requestId: id,
            _questions: questions,
          });

          // Block until user responds
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const response = await new Promise<any>((resolve) => {
            self.pendingPermissions.set(id, resolve);
          });

          // Send user's answers back to server
          if (id !== undefined) {
            await sendResult(id, response);
          }

          self.log(`patchQuestions: responded to questions id=${id}`);
          return { type: 'unknown', method, params };
        }

        if (method === '_iflow/plan/exit') {
          const plan = params?.plan || '';
          self.log(`patchQuestions: intercepted _iflow/plan/exit id=${id}, plan length=${plan.length}`);

          // Push a marker message into messageQueue
          messageQueue.push({
            type: 'tool_call',
            id: String(id),
            label: 'Exit Plan Mode',
            icon: { type: 'emoji', value: 'P' },
            status: 'pending',
            toolName: 'exit_plan_mode',
            _planApproval: true,
            _requestId: id,
            _plan: plan,
          });

          // Block until user responds
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const response = await new Promise<any>((resolve) => {
            self.pendingPermissions.set(id, resolve);
          });

          // Send approval result back to server
          if (id !== undefined) {
            await sendResult(id, response);
          }

          self.log(`patchQuestions: responded to plan approval id=${id}, approved=${response.approved}`);
          return { type: 'unknown', method, params };
        }
      } catch (err) {
        self.log(`patchQuestions: ERROR in handler for method=${method}: ${err instanceof Error ? err.message : String(err)}`);
        // Re-throw so the SDK can handle it
        throw err;
      }

      // All other methods: delegate to original handler
      return await originalHandleClientMessage(message);
    };

    this.log('patchQuestions: Question/plan interception installed');
  }

  /**
   * Answer pending user questions from _iflow/user/questions.
   */
  async answerQuestions(requestId: number, answers: Record<string, string | string[]>): Promise<void> {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) {
      this.log(`answerQuestions: no pending request for id ${requestId}`);
      return;
    }

    resolve({ answers });
    this.pendingPermissions.delete(requestId);
    this.log(`answerQuestions: responded id=${requestId}`);
  }

  /**
   * Approve or reject a pending plan from _iflow/plan/exit.
   */
  async approvePlan(requestId: number, approved: boolean): Promise<void> {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) {
      this.log(`approvePlan: no pending request for id ${requestId}`);
      return;
    }

    resolve({ approved });
    this.pendingPermissions.delete(requestId);
    this.log(`approvePlan: responded id=${requestId}, approved=${approved}`);
  }

  /**
   * Monkey-patch SDK protocol to enable interactive tool call approval.
   *
   * The SDK's Protocol.handleRequestPermission() auto-responds to permission
   * requests (approve in AUTO mode, cancel in MANUAL mode) without exposing
   * them to the client. This patch replaces that handler to:
   *  1. Push a confirmation message to the client's messageQueue
   *  2. Block until the user approves/rejects via approveToolCall/rejectToolCall
   *  3. Send the user's decision back to the iFlow CLI server
   */
  private patchPermission(client: SDKClientType): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const protocol = (client as any).protocol;
    if (!protocol) {
      this.log('patchPermission: protocol not available, skipping');
      return;
    }

    const self = this;
    const sendResult = protocol.sendResult.bind(protocol);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messageQueue: any[] = (client as any).messageQueue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protocol.handleRequestPermission = async function (message: any) {
      const { id, params } = message;
      const toolCall = params.toolCall || {};
      const options = params.options || [];

      self.log(`patchPermission: permission request id=${id}, tool=${toolCall.title}, type=${toolCall.type}, options=${JSON.stringify(options)}`);

      // Push a confirmation message into messageQueue so the run() loop can
      // forward it to the webview via onChunk.
      messageQueue.push({
        type: 'tool_call',
        id: String(id),
        label: toolCall.title || 'Tool Call',
        icon: { type: 'emoji', value: '🔧' },
        status: 'pending',
        toolName: toolCall.title,
        confirmation: {
          type: toolCall.type || 'other',
          description: toolCall.title || '',
        },
        _requestId: id,
      });

      // Block until user responds
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await new Promise<any>((resolve) => {
        self.pendingPermissions.set(id, resolve);
      });

      // Send user's decision to iFlow CLI
      if (id !== undefined) {
        await sendResult(id, response);
      }

      self.log(`patchPermission: responded id=${id}, outcome=${response.outcome?.outcome}`);
      return { type: 'tool_confirmation', params, response };
    };

    this.log('patchPermission: Interactive permission handling installed');
  }

  /**
   * Approve a pending tool call permission request.
   */
  async approveToolCall(requestId: number, outcome: string): Promise<void> {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) {
      this.log(`approveToolCall: no pending permission for id ${requestId}`);
      return;
    }

    const optionId = outcome === 'alwaysAllow' ? 'proceed_always' : 'proceed_once';
    resolve({
      outcome: {
        outcome: 'selected',
        optionId,
      }
    });
    this.pendingPermissions.delete(requestId);
    this.log(`approveToolCall: approved id=${requestId}, optionId=${optionId}`);
  }

  /**
   * Reject a pending tool call permission request.
   */
  async rejectToolCall(requestId: number): Promise<void> {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) {
      this.log(`rejectToolCall: no pending permission for id ${requestId}`);
      return;
    }

    resolve({
      outcome: {
        outcome: 'cancelled',
      }
    });
    this.pendingPermissions.delete(requestId);
    this.log(`rejectToolCall: rejected id=${requestId}`);
  }
}
