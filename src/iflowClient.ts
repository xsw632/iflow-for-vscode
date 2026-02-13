import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StreamChunk, ConversationMode, ModelType, AttachedFile } from './protocol';
import { ChunkMapper } from './chunkMapper';
import { ProcessManager, ManualStartInfo } from './processManager';

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

      const sdkOptions: Record<string, unknown> = {
        ...this.getSDKOptions(manualStart),
        sessionSettings: {
          permission_mode: options.mode,
        },
      };

      const sdk = await getSDK();
      this.client = new sdk.IFlowClient(sdkOptions);
      await this.client.connect();
      this.patchTransport(this.client);
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
      this.log(`Sending message: ${prompt.substring(0, 100)}...`);
      await this.client.sendMessage(prompt);

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
