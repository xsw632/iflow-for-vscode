import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StreamChunk, ConversationMode, ModelType, AttachedFile } from './protocol';
import { ThinkingParser } from './thinkingParser';
import { findIFlowPathCrossPlatform, resolveIFlowScriptCrossPlatform, deriveNodePathFromIFlow } from './cliDiscovery';

export { ThinkingParser } from './thinkingParser';

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

interface ManualStartInfo {
  nodePath: string;
  iflowScript: string;
  port: number;
}

export class IFlowClient {
  private client: SDKClientType | null = null;
  private outputChannel: vscode.OutputChannel | null = null;
  private isConnected = false;
  private isCancelled = false;
  private managedProcess: cp.ChildProcess | null = null;
  private parser: ThinkingParser | null = null;
  private inNativeThinking = false;
  // Auto-detection cache: undefined = not attempted, null = attempted & failed, object = success
  private _cachedAutoDetect: { nodePath: string; iflowScript: string } | null | undefined = undefined;
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

  // ── Auto-detection orchestration ────────────────────────────────
  // CLI discovery logic (findIFlowPath, resolveIFlowScript, deriveNodePath)
  // lives in ./cliDiscovery.ts

  /**
   * Auto-detect Node.js and iFlow script paths from the iFlow CLI location.
   * Results are cached per client instance.
   */
  private async autoDetectNodePath(): Promise<{ nodePath: string; iflowScript: string } | null> {
    // undefined = not yet attempted; null = attempted and failed
    if (this._cachedAutoDetect !== undefined) {
      return this._cachedAutoDetect;
    }

    const log = this.logInfo.bind(this);
    this.logInfo('Attempting auto-detection of Node.js path from iflow CLI location');

    const iflowPath = await findIFlowPathCrossPlatform(log);
    if (!iflowPath) {
      this.logInfo('Auto-detection: iflow CLI not found in PATH or APPDATA');
      this._cachedAutoDetect = null;
      return null;
    }

    this.logInfo(`Auto-detection: found iflow at ${iflowPath}`);

    const nodePath = await deriveNodePathFromIFlow(iflowPath, log);
    if (!nodePath) {
      this.logInfo('Auto-detection: could not derive node path from iflow location');
      this._cachedAutoDetect = null;
      return null;
    }

    const iflowScript = resolveIFlowScriptCrossPlatform(iflowPath, log);
    this.logInfo(`Auto-detection successful: node=${nodePath}, script=${iflowScript}`);

    this._cachedAutoDetect = { nodePath, iflowScript };
    return this._cachedAutoDetect;
  }

  /**
   * Determine how to start the iFlow process.
   * Tier 1: User-configured nodePath
   * Tier 2: Auto-detected from iflow CLI location
   * Tier 3: null (fall back to SDK auto-start)
   */
  private async resolveStartMode(): Promise<ManualStartInfo | null> {
    const config = this.getConfig();
    const log = this.logInfo.bind(this);

    // Tier 1: User-configured nodePath
    if (config.nodePath) {
      this.log(`Using user-configured nodePath: ${config.nodePath}`);
      const iflowPath = await findIFlowPathCrossPlatform(log);
      if (!iflowPath) {
        throw new Error('iFlow CLI not found. Please install iFlow CLI first.');
      }
      const iflowScript = resolveIFlowScriptCrossPlatform(iflowPath, log);
      return { nodePath: config.nodePath, iflowScript, port: config.port };
    }

    // Tier 2: Auto-detect from iflow CLI location
    const autoDetected = await this.autoDetectNodePath();
    if (autoDetected) {
      this.log(`Using auto-detected node: ${autoDetected.nodePath}`);
      return {
        nodePath: autoDetected.nodePath,
        iflowScript: autoDetected.iflowScript,
        port: config.port,
      };
    }

    // Tier 3: Let SDK auto-start handle it
    this.log('No manual node path available, falling back to SDK auto-start');
    return null;
  }

  clearAutoDetectCache(): void {
    this._cachedAutoDetect = undefined;
  }

  // ── Process management ──────────────────────────────────────────────

  /**
   * Start iFlow process manually with a specific Node path.
   * If iflowScript is provided, uses it directly; otherwise discovers it.
   */
  private async startManagedProcess(nodePath: string, port: number, iflowScript?: string): Promise<void> {
    if (!iflowScript) {
      const log = this.logInfo.bind(this);
      const iflowPath = await findIFlowPathCrossPlatform(log);
      if (!iflowPath) {
        throw new Error('iFlow CLI not found in PATH. Please install iFlow CLI first.');
      }
      iflowScript = resolveIFlowScriptCrossPlatform(iflowPath, log);
    }

    this.log(`Starting iFlow with Node: ${nodePath}, script: ${iflowScript}, port: ${port}`);

    return new Promise((resolve, reject) => {
      const args = [iflowScript!, '--experimental-acp', '--port', String(port)];

      this.managedProcess = cp.spawn(nodePath, args, {
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let started = false;
      const timeout = setTimeout(() => {
        if (!started) {
          reject(new Error('iFlow process startup timeout'));
        }
      }, 30000);

      this.managedProcess.stdout?.on('data', (data: Buffer) => {
        const output = data.toString();
        this.log(`[iFlow stdout] ${output}`);
        // Look for ready signal
        if (output.includes('listening') || output.includes('ready') || output.includes('port')) {
          if (!started) {
            started = true;
            clearTimeout(timeout);
            // Give it a moment to fully initialize
            setTimeout(() => resolve(), 500);
          }
        }
      });

      this.managedProcess.stderr?.on('data', (data: Buffer) => {
        const output = data.toString();
        this.log(`[iFlow stderr] ${output}`);
        // Some CLIs output ready messages to stderr
        if (output.includes('listening') || output.includes('ready') || output.includes('Started')) {
          if (!started) {
            started = true;
            clearTimeout(timeout);
            setTimeout(() => resolve(), 500);
          }
        }
      });

      this.managedProcess.on('error', (err) => {
        clearTimeout(timeout);
        this.log(`iFlow process error: ${err.message}`);
        reject(new Error(`Failed to start iFlow: ${err.message}`));
      });

      this.managedProcess.on('exit', (code) => {
        this.log(`iFlow process exited with code: ${code}`);
        if (!started) {
          clearTimeout(timeout);
          reject(new Error(`iFlow process exited immediately with code ${code}`));
        }
        this.managedProcess = null;
      });

      // If no ready signal after 2 seconds, assume it's ready anyway
      setTimeout(() => {
        if (!started && this.managedProcess && !this.managedProcess.killed) {
          started = true;
          clearTimeout(timeout);
          resolve();
        }
      }, 2000);
    });
  }

  /**
   * Stop the managed iFlow process
   */
  private stopManagedProcess(): void {
    if (this.managedProcess) {
      this.log('Stopping managed iFlow process');
      this.managedProcess.kill('SIGTERM');
      this.managedProcess = null;
    }
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
      const manualStart = await this.resolveStartMode();

      if (manualStart) {
        diag.push(`nodePath: ${manualStart.nodePath}`);
        diag.push(`iflowScript: ${manualStart.iflowScript}`);
        diag.push(`port: ${manualStart.port}`);
        this.logInfo(`Resolved: node=${manualStart.nodePath}, script=${manualStart.iflowScript}, port=${manualStart.port}`);
        await this.startManagedProcess(manualStart.nodePath, manualStart.port, manualStart.iflowScript);
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
    this.inNativeThinking = false;
    this.parser = new ThinkingParser();
    let returnSessionId: string | undefined;

    // Update model in CLI settings so all internal code paths use it
    this.updateIFlowCliModel(options.model);

    this.log(`Starting run with options: ${JSON.stringify({ mode: options.mode, model: options.model, think: options.think, sessionId: options.sessionId })}`);

    try {
      const manualStart = await this.resolveStartMode();

      // If using manual start and process isn't running, start it
      if (manualStart && !this.managedProcess) {
        await this.startManagedProcess(manualStart.nodePath, manualStart.port, manualStart.iflowScript);
      }

      const sdkOptions: Record<string, unknown> = {
        ...this.getSDKOptions(manualStart),
        sessionSettings: {
          permission_mode: this.mapMode(options.mode),
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

      const prompt = this.buildPrompt(options);
      this.log(`Sending message: ${prompt.substring(0, 100)}...`);
      await this.client.sendMessage(prompt);

      for await (const message of this.client.receiveMessages()) {
        if (this.isCancelled) {
          this.log('Run cancelled');
          break;
        }

        const chunks = await this.mapMessageToChunks(message);
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
    this.stopManagedProcess();
    this._cachedAutoDetect = undefined;
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

  private mapMode(mode: ConversationMode): 'default' | 'smart' | 'yolo' | 'plan' {
    switch (mode) {
      case 'default':
        return 'default';
      case 'yolo':
        return 'yolo';
      case 'plan':
        return 'plan';
      case 'smart':
        return 'smart';
      default:
        return 'default';
    }
  }

  private buildPrompt(options: RunOptions): string {
    let prompt = '';

    if (options.workspaceFiles && options.workspaceFiles.length > 0) {
      prompt += '=== Workspace Files ===\n';
      prompt += options.workspaceFiles.join('\n');
      prompt += '\n=== End Workspace Files ===\n\n';
    }

    if (options.attachedFiles.length > 0) {
      prompt += '=== Attached Files ===\n';
      for (const file of options.attachedFiles) {
        prompt += `--- ${file.path} ---\n`;
        prompt += file.content || '';
        if (file.truncated) {
          prompt += '\n[... truncated ...]\n';
        }
        prompt += '\n';
      }
      prompt += '=== End Attached Files ===\n\n';
    }

    prompt += options.prompt;
    return prompt;
  }

  /**
   * Enrich tool input by merging data from message.content and message.locations
   * into the args object, so the webview can access file paths and content.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private enrichToolInput(message: any): Record<string, unknown> {
    const input: Record<string, unknown> = { ...(message.args || {}) };

    // Merge ToolCallContent fields (path, newText, oldText, markdown)
    if (message.content) {
      if (message.content.path && !input.file_path) {
        input.file_path = message.content.path;
      }
      if (message.content.newText != null && !input.content) {
        input.content = message.content.newText;
      }
      if (message.content.oldText != null && !input.old_string) {
        input.old_string = message.content.oldText;
      }
      if (message.content.markdown != null) {
        input._markdown = message.content.markdown;
      }
      if (message.content.type) {
        input._contentType = message.content.type;
      }
    }

    // Merge first location as file_path
    if (message.locations && message.locations.length > 0) {
      const loc = message.locations[0];
      if (loc.path && !input.file_path) {
        input.file_path = loc.path;
      }
    }

    return input;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async mapMessageToChunks(message: any): Promise<StreamChunk[]> {
    const sdk = await getSDK();
    const chunks: StreamChunk[] = [];

    switch (message.type) {
      case sdk.MessageType.ASSISTANT:
        // Handle native thought chunks from SDK
        if (message.chunk?.thought) {
          if (!this.inNativeThinking) {
            chunks.push({ chunkType: 'thinking_start' });
            this.inNativeThinking = true;
          }
          chunks.push({ chunkType: 'thinking_content', content: message.chunk.thought });
        }
        // Handle text chunks
        if (message.chunk?.text) {
          // End native thinking block if we were in one
          if (this.inNativeThinking) {
            chunks.push({ chunkType: 'thinking_end' });
            this.inNativeThinking = false;
          }
          if (this.parser) {
            const parserChunks = this.parser.parse(message.chunk.text);
            chunks.push(...parserChunks);
          } else {
            chunks.push({ chunkType: 'text', content: message.chunk.text });
          }
        }
        break;

      case sdk.MessageType.TOOL_CALL: {
        this.log(`TOOL_CALL: status=${message.status}, toolName=${message.toolName}, label=${message.label}, args=${JSON.stringify(message.args)}`);

        // Check if this is a permission confirmation request (injected by patchPermission)
        if (message.confirmation && message._requestId !== undefined) {
          // Emit tool_start so the tool appears as a running entry in the messages
          chunks.push({
            chunkType: 'tool_start',
            name: message.toolName || message.label || 'unknown',
            input: {},
            label: message.label || undefined
          });
          // Emit tool_confirmation so the webview can show the approval UI in the composer
          chunks.push({
            chunkType: 'tool_confirmation',
            requestId: message._requestId,
            toolName: message.toolName || message.label || 'unknown',
            description: message.confirmation.description || '',
            confirmationType: message.confirmation.type || 'other',
          });
          break;
        }

        const enrichedInput = this.enrichToolInput(message);
        const toolName = message.toolName || message.label || 'unknown';

        if (message.status === 'pending' || message.status === 'in_progress') {
          chunks.push({
            chunkType: 'tool_start',
            name: toolName,
            input: enrichedInput,
            label: message.label || undefined
          });
        } else if (message.status === 'completed') {
          // Send an input update before completion (block is still 'running')
          // so the preview renderer has access to content/locations data
          if (Object.keys(enrichedInput).length > 0) {
            chunks.push({
              chunkType: 'tool_start',
              name: toolName,
              input: enrichedInput,
              label: message.label || undefined
            });
          }
          if (message.output) {
            chunks.push({
              chunkType: 'tool_output',
              content: message.output
            });
          }
          chunks.push({
            chunkType: 'tool_end',
            status: 'completed'
          });
        } else if (message.status === 'failed') {
          if (message.output) {
            chunks.push({
              chunkType: 'tool_output',
              content: message.output
            });
          }
          chunks.push({
            chunkType: 'tool_end',
            status: 'error'
          });
        }
        break;
      }

      case sdk.MessageType.PLAN:
        if (message.entries && Array.isArray(message.entries)) {
          let planText = 'Execution Plan:\n';
          for (const entry of message.entries) {
            const statusIcon = entry.status === 'completed' ? '✅' : '⏳';
            planText += `${statusIcon} [${entry.priority}] ${entry.content}\n`;
          }
          chunks.push({ chunkType: 'text', content: planText });
        }
        break;

      case sdk.MessageType.ERROR:
        chunks.push({
          chunkType: 'error',
          message: message.message || 'Unknown error'
        });
        break;

      case sdk.MessageType.TASK_FINISH:
        // Close any open native thinking block
        if (this.inNativeThinking) {
          chunks.push({ chunkType: 'thinking_end' });
          this.inNativeThinking = false;
        }
        // Task finish is handled in the run loop
        break;

      default:
        this.log(`Unknown message type: ${message.type}`);
    }

    return chunks;
  }
}
