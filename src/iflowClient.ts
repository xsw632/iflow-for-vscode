import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StreamChunk, ConversationMode, ModelType, AttachedFile, IDEContext } from './protocol';
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
3. If you need clarification, use the ask_user_question tool to ask structured questions with predefined options

### Phase 2: Planning
Goal: Come up with an approach to solve the problem identified in phase 1.
- Provide any background context that may help with the task
- Create a detailed plan using todo_write

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use the ask_user_question tool to ask the user any remaining questions

### Phase 4: Final Plan
Once you have all the information you need, provide your synthesized recommendation including:
- Recommended approach with rationale
- Key insights from different perspectives

### Phase 5: Call exit_plan_mode
CRITICAL: At the very end of your turn, once you are happy with your final plan, you MUST call the exit_plan_mode tool. This is mandatory.
Your turn should ONLY end by calling exit_plan_mode. Do NOT end your turn with just text - always call exit_plan_mode as the final action.

NOTE:
- At any point in time through this workflow you should feel free to ask the user questions or clarifications using the ask_user_question tool. Don't make large assumptions about user intent.
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

interface RunOptions {
  prompt: string;
  attachedFiles: AttachedFile[];
  mode: ConversationMode;
  think: boolean;
  model: ModelType;
  workspaceFiles?: string[];
  sessionId?: string;
  ideContext?: IDEContext;
  cwd?: string;
  fileAllowedDirs?: string[];
}

export class IFlowClient {
  private client: SDKClientType | null = null;
  private outputChannel: vscode.OutputChannel | null = null;
  private isConnected = false;
  private isCancelled = false;
  /** The conversation mode for which the current connection was established. */
  private connectedMode: ConversationMode | null = null;
  /** The cwd for which the current connection was established. */
  private connectedCwd: string | null = null;
  /** The session ID currently loaded on the persistent connection. */
  private loadedSessionId: string | null = null;
  /** Cached manualStart info to avoid re-resolving on every run. */
  private cachedManualStart: ManualStartInfo | null | undefined = undefined;
  private chunkMapper = new ChunkMapper(getSDK, (msg) => this.log(msg));
  private processManager = new ProcessManager(
    (msg) => this.log(msg),
    (msg) => this.logInfo(msg)
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

  /**
   * Read iFlow CLI settings from ~/.iflow/settings.json.
   * Creates default settings if file doesn't exist.
   */
  private readSettings(): { settings: Record<string, unknown>; path: string } | null {
    try {
      const settingsPath = this.getIFlowSettingsPath();
      const settingsDir = path.dirname(settingsPath);

      // Ensure the .iflow directory exists
      if (!fs.existsSync(settingsDir)) {
        fs.mkdirSync(settingsDir, { recursive: true });
        this.log(`Created iFlow settings directory: ${settingsDir}`);
      }

      // Read existing settings or return default
      if (fs.existsSync(settingsPath)) {
        try {
          const content = fs.readFileSync(settingsPath, 'utf-8');
          return { settings: JSON.parse(content), path: settingsPath };
        } catch (readErr) {
          this.log(`Failed to read existing settings, using defaults: ${readErr instanceof Error ? readErr.message : String(readErr)}`);
        }
      }

      return { settings: {}, path: settingsPath };
    } catch (err) {
      this.log(`Failed to read iFlow settings: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Write iFlow CLI settings to ~/.iflow/settings.json.
   * Uses platform-appropriate file permissions.
   */
  private writeSettings(settings: Record<string, unknown>, settingsPath: string): boolean {
    try {
      const content = JSON.stringify(settings, null, 2);

      // Windows doesn't support Unix-style permissions, use default
      // Unix-like systems use 0o600 (read/write for owner only)
      if (process.platform === 'win32') {
        fs.writeFileSync(settingsPath, content, 'utf-8');
      } else {
        fs.writeFileSync(settingsPath, content, { encoding: 'utf-8', mode: 0o600 });
      }
      return true;
    } catch (err) {
      this.log(`Failed to write iFlow settings: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private updateIFlowCliModel(model: ModelType): void {
    const result = this.readSettings();
    if (!result) return;

    const { settings, path: settingsPath } = result;

    if (settings.modelName !== model) {
      settings.modelName = model;
      if (this.writeSettings(settings, settingsPath)) {
        this.log(`Updated ~/.iflow/settings.json modelName to: ${model}`);
      }
    }
  }

  private updateIFlowCliApiConfig(): void {
    const result = this.readSettings();
    if (!result) return;

    const { settings, path: settingsPath } = result;
    const config = this.getConfig();
    let updated = false;

    if (config.baseUrl && settings.baseUrl !== config.baseUrl) {
      settings.baseUrl = config.baseUrl;
      updated = true;
      this.log(`Updated ~/.iflow/settings.json baseUrl to: ${config.baseUrl}`);
    }

    // Only override apiKey from VS Code config if not using OAuth authentication.
    // When OAuth is active, the apiKey in settings.json is managed by AuthService.
    if (settings.selectedAuthType !== 'oauth-iflow') {
      const apiKey = vscode.workspace.getConfiguration('iflow').get<string | null>('apiKey', null);
      if (apiKey && settings.apiKey !== apiKey) {
        settings.apiKey = apiKey;
        updated = true;
        this.log(`Updated ~/.iflow/settings.json apiKey`);
      }
    }

    if (updated) {
      if (this.writeSettings(settings, settingsPath)) {
        this.log(`Saved iFlow settings with secure permissions`);
      }
    }
  }

  private getSDKOptions(
    manualStart: ManualStartInfo | null,
    cwd?: string,
    fileAllowedDirs?: string[]
  ): Record<string, unknown> {
    const config = this.getConfig();
    const resolvedCwd = cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    const options: Record<string, unknown> = {
      timeout: config.timeout,
      logLevel: config.debugLogging ? 'DEBUG' : 'WARN',
      cwd: resolvedCwd,
      fileAccess: true,
    };

    if (fileAllowedDirs && fileAllowedDirs.length > 1) {
      options.fileAllowedDirs = fileAllowedDirs;
    }

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

  /**
   * Ensure a persistent SDK connection exists for the given mode.
   * Reuses the existing connection when possible; reconnects only when the
   * mode changes or the previous connection was lost.
   */
  private async ensureConnected(
    mode: ConversationMode,
    cwd?: string,
    fileAllowedDirs?: string[]
  ): Promise<void> {
    // Already connected with matching mode and cwd → reuse
    if (this.isConnected && this.client && this.connectedMode === mode && this.connectedCwd === (cwd ?? null)) {
      this.log(`Reusing existing connection (mode=${mode}, cwd=${cwd})`);
      return;
    }

    // Mode or cwd changed, or not connected → tear down stale connection first
    if (this.isConnected && this.client) {
      this.log(`Connection params changed (mode: ${this.connectedMode} → ${mode}, cwd: ${this.connectedCwd} → ${cwd}), reconnecting`);
      await this.disconnect();
    }

    const config = this.getConfig();

    // Resolve how to start the process (cached across the instance lifetime)
    if (this.cachedManualStart === undefined) {
      this.cachedManualStart = await this.processManager.resolveStartMode(config);
    }

    // Start the managed process if needed
    if (this.cachedManualStart && !this.processManager.hasProcess) {
      await this.processManager.startManagedProcess(
        this.cachedManualStart.nodePath,
        this.cachedManualStart.port,
        this.cachedManualStart.iflowScript,
        cwd
      );
    }

    // Build session settings for this mode
    const sessionSettings: Record<string, unknown> = {
      permission_mode: mode,
    };
    if (mode === 'plan') {
      sessionSettings.append_system_prompt = PLAN_MODE_INSTRUCTIONS;
    }

    const sdkOptions: Record<string, unknown> = {
      ...this.getSDKOptions(this.cachedManualStart, cwd, fileAllowedDirs),
      sessionSettings,
    };

    const sdk = await getSDK();
    this.client = new sdk.IFlowClient(sdkOptions);
    await this.client.connect();

    // Install all monkey-patches once per connection.
    // patchQuestions and patchPermission are orthogonal and safe to
    // install together regardless of mode.
    this.patchTransport(this.client);
    this.patchQuestions(this.client);
    this.patchPermission(this.client);

    this.isConnected = true;
    this.connectedMode = mode;
    this.connectedCwd = cwd ?? null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.loadedSessionId = (this.client as any).sessionId ?? null;
    this.log(`Connected to iFlow (mode=${mode}, cwd=${cwd}, sessionId=${this.loadedSessionId})`);
  }

  async checkAvailability(): Promise<{ version: string | null; diagnostics: string }> {
    const diag: string[] = [];
    diag.push(`platform: ${process.platform} (${process.arch})`);
    diag.push(`PATH (first 500): ${(process.env.PATH || '').substring(0, 500)}`);

    this.logInfo('=== Checking iFlow CLI availability ===');
    this.logInfo(`Platform: ${process.platform}, arch: ${process.arch}`);

    // Declare outside try so they're accessible in catch
    let iflowScriptPath: string | undefined;
    let config: ReturnType<typeof this.getConfig> | undefined;

    try {
      config = this.getConfig();

      // Update API configuration in CLI settings before starting
      this.updateIFlowCliApiConfig();

      const manualStart = await this.processManager.resolveStartMode(config);

      if (manualStart) {
        diag.push(`nodePath: ${manualStart.nodePath}`);
        diag.push(`iflowScript: ${manualStart.iflowScript}`);
        diag.push(`port: ${manualStart.port}`);
        iflowScriptPath = manualStart.iflowScript;
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

      // Add troubleshooting suggestions based on error type
      const suggestions: string[] = [];
      if (errorMsg.includes('Failed to connect') || errorMsg.includes('WebSocket')) {
        suggestions.push('建议排查步骤：');
        suggestions.push('1. 检查端口是否被占用: netstat -ano | findstr 8090');
        // Use the actual script path if available, otherwise show generic message
        if (iflowScriptPath && config) {
          suggestions.push(`2. 手动启动 CLI 查看输出: node "${iflowScriptPath}" --experimental-acp --port ${config.port}`);
        } else {
          suggestions.push('2. 手动启动 CLI 查看输出: node <iflow-cli-path> --experimental-acp --port 8090');
        }
        suggestions.push('3. 检查 CLI 版本是否支持 --experimental-acp 参数');
        suggestions.push('4. 检查 Windows 防火墙是否阻止 localhost 连接');
      }
      if (errorMsg.includes('iFlow CLI not found')) {
        suggestions.push('建议排查步骤：');
        suggestions.push('1. 确认 iFlow CLI 已安装: npm install -g @iflow-ai/iflow-cli');
        suggestions.push('2. 检查 PATH 环境变量是否包含 npm 全局目录');
      }

      this.logInfo(`iFlow CLI not available: ${errorMsg}`);
      this.logInfo(`--- Diagnostics ---\n${diag.join('\n')}\n-------------------`);
      if (suggestions.length > 0) {
        this.logInfo(`--- Troubleshooting ---\n${suggestions.join('\n')}\n---------------------`);
      }

      // Show output channel so user can see diagnostics
      this.outputChannel?.show(true);
      return { version: null, diagnostics: diag.join('\n') + (suggestions.length > 0 ? '\n\n' + suggestions.join('\n') : '') };
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

    // Update API configuration in CLI settings
    this.updateIFlowCliApiConfig();

    this.log(`Starting run with options: ${JSON.stringify({ mode: options.mode, model: options.model, think: options.think, sessionId: options.sessionId })}`);

    try {
      // Establish or reuse a persistent connection
      await this.ensureConnected(options.mode, options.cwd, options.fileAllowedDirs);

      // Drain any stale messages from a previous run
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messageQueue: any[] = (this.client as any).messageQueue;
      if (messageQueue && messageQueue.length > 0) {
        this.log(`Draining ${messageQueue.length} stale message(s) from previous run`);
        messageQueue.length = 0;
      }

      // Load existing session to restore context from previous turns
      // (only when the requested session differs from the one already loaded)
      if (options.sessionId && options.sessionId !== this.loadedSessionId) {
        try {
          await this.client!.loadSession(options.sessionId);
          this.loadedSessionId = options.sessionId;
          this.log(`Loaded existing session: ${options.sessionId}`);
        } catch (err) {
          this.log(`Failed to load session ${options.sessionId}, continuing with current session: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Enable/disable thinking via ACP protocol
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sessionId = (this.client as any).sessionId;
      returnSessionId = sessionId;
      if (sessionId) {
        await this.sendSetThink(this.client!, sessionId, options.think);
      }

      const sdk = await getSDK();
      const prompt = this.chunkMapper.buildPrompt(options);

      // In plan mode, inject the plan-mode workflow as a <system-reminder> into
      // the user message itself — mirroring what the CLI does on every turn via
      // reminderManager.injectIntoUserMessage().  The ACP path skips that
      // injection, so we compensate here.
      const finalPrompt = options.mode === 'plan'
        ? `<system-reminder>\n${PLAN_MODE_INSTRUCTIONS}\n</system-reminder>\n\n${prompt}`
        : prompt;

      this.log(`Sending message: ${finalPrompt.substring(0, 100)}...`);
      await this.client!.sendMessage(finalPrompt);

      for await (const message of this.client!.receiveMessages()) {
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
      // Mark connection as broken so next run reconnects
      this.isConnected = false;
      this.client = null;
      this.connectedMode = null;
      this.loadedSessionId = null;
      onError(errorMessage);
    }
    return returnSessionId;
  }

  async cancel(): Promise<void> {
    this.log('Cancelling current operation');
    this.isCancelled = true;
    if (this.client && this.isConnected) {
      try {
        await this.client.interrupt();
      } catch {
        // If interrupt fails, disconnect to ensure clean state
        await this.disconnect();
      }
    }
  }

  private async disconnect(): Promise<void> {
    if (this.client && this.isConnected) {
      try {
        await this.client.disconnect();
        this.log('Disconnected from iFlow');
      } catch (error) {
        this.log(`Disconnect error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.isConnected = false;
    this.client = null;
    this.connectedMode = null;
    this.connectedCwd = null;
    this.loadedSessionId = null;
  }

  /**
   * Full cleanup - disconnect SDK, stop managed process, clear caches
   */
  async dispose(): Promise<void> {
    await this.disconnect();
    this.processManager.stopManagedProcess();
    this.processManager.clearAutoDetectCache();
    this.cachedManualStart = undefined;
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
