import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StreamChunk, ConversationMode, ModelType, AttachedFile } from './protocol';

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
}

interface ManualStartInfo {
  nodePath: string;
  iflowScript: string;
  port: number;
}

export class ThinkingParser {
  private buffer: string = '';
  private inThinking: boolean = false;

  parse(text: string): StreamChunk[] {
    this.buffer += text;
    const chunks: StreamChunk[] = [];

    while (true) {
      if (!this.inThinking) {
        const thinkStart = this.buffer.indexOf('<think>');
        if (thinkStart !== -1) {
          if (thinkStart > 0) {
            chunks.push({ chunkType: 'text', content: this.buffer.slice(0, thinkStart) });
          }
          chunks.push({ chunkType: 'thinking_start' });
          this.inThinking = true;
          this.buffer = this.buffer.slice(thinkStart + 7);
        } else {
          // Check for partial <think>
          const lastLt = this.buffer.lastIndexOf('<');
          if (lastLt !== -1 && '<think>'.startsWith(this.buffer.slice(lastLt))) {
            if (lastLt > 0) {
              chunks.push({ chunkType: 'text', content: this.buffer.slice(0, lastLt) });
              this.buffer = this.buffer.slice(lastLt);
            }
            break;
          } else {
            if (this.buffer.length > 0) {
              chunks.push({ chunkType: 'text', content: this.buffer });
              this.buffer = '';
            }
            break;
          }
        }
      } else {
        const thinkEnd = this.buffer.indexOf('</think>');
        if (thinkEnd !== -1) {
          if (thinkEnd > 0) {
            chunks.push({ chunkType: 'thinking_content', content: this.buffer.slice(0, thinkEnd) });
          }
          chunks.push({ chunkType: 'thinking_end' });
          this.inThinking = false;
          this.buffer = this.buffer.slice(thinkEnd + 8);
        } else {
          // Check for partial </think>
          const lastLt = this.buffer.lastIndexOf('<');
          if (lastLt !== -1 && '</think>'.startsWith(this.buffer.slice(lastLt))) {
            if (lastLt > 0) {
              chunks.push({ chunkType: 'thinking_content', content: this.buffer.slice(0, lastLt) });
              this.buffer = this.buffer.slice(lastLt);
            }
            break;
          } else {
            if (this.buffer.length > 0) {
              chunks.push({ chunkType: 'thinking_content', content: this.buffer });
              this.buffer = '';
            }
            break;
          }
        }
      }
    }
    return chunks;
  }
}

export class IFlowClient {
  private client: SDKClientType | null = null;
  private outputChannel: vscode.OutputChannel | null = null;
  private isConnected = false;
  private isCancelled = false;
  private managedProcess: cp.ChildProcess | null = null;
  private parser: ThinkingParser | null = null;
  // Auto-detection cache: undefined = not attempted, null = attempted & failed, object = success
  private _cachedAutoDetect: { nodePath: string; iflowScript: string } | null | undefined = undefined;

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

  // ── Cross-platform iFlow CLI discovery ──────────────────────────────

  /**
   * Find iFlow CLI path across platforms.
   * Unix: tries `which iflow`, then falls back to a login shell to pick up nvm/fnm.
   * Windows: tries `where iflow`, then checks common npm global paths.
   */
  private async findIFlowPathCrossPlatform(): Promise<string | null> {
    if (process.platform === 'win32') {
      return this.findIFlowPathWindows();
    }
    return this.findIFlowPathUnix();
  }

  private findIFlowPathWindows(): Promise<string | null> {
    return new Promise((resolve) => {
      cp.exec('where iflow 2>NUL & where iflow.ps1 2>NUL & where iflow.cmd 2>NUL', { timeout: 5000 }, (error, stdout) => {
        const lines = (stdout || '').trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (lines.length > 0) {
          // Prefer .ps1 > .cmd > others (PowerShell wrappers are most reliable on modern Windows)
          const ps1 = lines.find(l => l.toLowerCase().endsWith('.ps1'));
          const cmd = lines.find(l => l.toLowerCase().endsWith('.cmd'));
          const picked = ps1 || cmd || lines[0];
          this.logInfo(`[Windows discovery] 'where' returned ${lines.length} result(s): ${lines.join(', ')}`);
          this.logInfo(`[Windows discovery] picked: ${picked}`);
          resolve(picked);
          return;
        }
        // Fallback: check common Windows npm global location
        const appData = process.env.APPDATA;
        if (appData) {
          for (const ext of ['.ps1', '.cmd', '']) {
            const candidate = path.join(appData, 'npm', `iflow${ext}`);
            if (fs.existsSync(candidate)) {
              this.logInfo(`[Windows discovery] fallback found: ${candidate}`);
              resolve(candidate);
              return;
            }
          }
        }
        this.logInfo('[Windows discovery] iflow CLI not found via "where" or APPDATA fallback');
        resolve(null);
      });
    });
  }

  private findIFlowPathUnix(): Promise<string | null> {
    return new Promise((resolve) => {
      // First try: direct 'which' with inherited PATH (works when launched from terminal)
      cp.exec('which iflow', { timeout: 5000 }, (error, stdout) => {
        if (!error && stdout.trim()) {
          resolve(stdout.trim());
          return;
        }
        // Second try: login shell to pick up nvm/fnm/volta initialization
        const shell = process.env.SHELL || '/bin/bash';
        cp.exec(`${shell} -lc "which iflow"`, { timeout: 10000 }, (err2, stdout2) => {
          if (!err2 && stdout2.trim()) {
            resolve(stdout2.trim());
          } else {
            resolve(null);
          }
        });
      });
    });
  }

  // ── Cross-platform script resolution ────────────────────────────────

  /**
   * Resolve the actual JavaScript entry point from an iflow executable path.
   * Uses fs.realpathSync (cross-platform) instead of `readlink -f`.
   * On Windows, parses .cmd wrapper to extract the JS path.
   */
  private resolveIFlowScriptCrossPlatform(iflowPath: string): string {
    if (process.platform === 'win32') {
      const lower = iflowPath.toLowerCase();
      const dir = path.dirname(iflowPath);

      // Try .ps1 PowerShell wrapper (preferred on modern Windows)
      const ps1Path = lower.endsWith('.ps1') ? iflowPath : null;
      const ps1Sibling = !ps1Path ? path.join(dir, 'iflow.ps1') : null;
      const ps1File = ps1Path || (ps1Sibling && fs.existsSync(ps1Sibling) ? ps1Sibling : null);
      if (ps1File) {
        const result = this.parsePs1Wrapper(ps1File);
        if (result) {
          this.logInfo(`[script resolve] extracted JS from .ps1: ${result}`);
          return result;
        }
      }

      // Try .cmd batch wrapper
      const cmdPath = lower.endsWith('.cmd') ? iflowPath : null;
      const cmdSibling = !cmdPath ? path.join(dir, 'iflow.cmd') : null;
      const cmdFile = cmdPath || (cmdSibling && fs.existsSync(cmdSibling) ? cmdSibling : null);
      if (cmdFile) {
        const result = this.parseCmdWrapper(cmdFile);
        if (result) {
          this.logInfo(`[script resolve] extracted JS from .cmd: ${result}`);
          return result;
        }
      }
    }

    // Unix or fallback: resolve symlinks via Node.js native API
    try {
      const resolved = fs.realpathSync(iflowPath);
      this.logInfo(`[script resolve] realpathSync: ${iflowPath} -> ${resolved}`);
      return resolved;
    } catch {
      this.logInfo(`[script resolve] realpathSync failed for ${iflowPath}, using original path`);
      return iflowPath;
    }
  }

  /** Parse a Windows .cmd batch wrapper to extract the JS entry point. */
  private parseCmdWrapper(cmdPath: string): string | null {
    try {
      const content = fs.readFileSync(cmdPath, 'utf-8');
      const match = content.match(/"([^"]*\.js)"/);
      if (match) {
        const dir = path.dirname(cmdPath);
        const jsPath = match[1]
          .replace(/%~dp0\\/gi, dir + path.sep)
          .replace(/%~dp0/gi, dir + path.sep)
          .replace(/%dp0%\\/gi, dir + path.sep)
          .replace(/%dp0%/gi, dir + path.sep);
        if (fs.existsSync(jsPath)) {
          return jsPath;
        }
        this.logInfo(`[.cmd parse] JS path extracted but does not exist: ${jsPath}`);
      }
    } catch {
      this.logInfo(`[.cmd parse] failed to read: ${cmdPath}`);
    }
    return null;
  }

  /** Parse a Windows .ps1 PowerShell wrapper to extract the JS entry point. */
  private parsePs1Wrapper(ps1Path: string): string | null {
    try {
      const content = fs.readFileSync(ps1Path, 'utf-8');
      // Match patterns like: "$basedir/node_modules/iflow/dist/cli.js"
      const match = content.match(/"\$basedir[/\\](.*?\.js)"/);
      if (match) {
        const dir = path.dirname(ps1Path);
        const jsPath = path.join(dir, match[1].replace(/\//g, path.sep));
        if (fs.existsSync(jsPath)) {
          return jsPath;
        }
        this.logInfo(`[.ps1 parse] JS path extracted but does not exist: ${jsPath}`);
      }
    } catch {
      this.logInfo(`[.ps1 parse] failed to read: ${ps1Path}`);
    }
    return null;
  }

  // ── Node.js path derivation ─────────────────────────────────────────

  /**
   * Derive the Node.js binary path from the iflow CLI location.
   * Uses the ORIGINAL (pre-realpath) iflow path because nvm places both
   * `node` and `iflow` symlinks in the same bin/ directory.
   */
  private async deriveNodePathFromIFlow(iflowPath: string): Promise<string | null> {
    const isWindows = process.platform === 'win32';
    const nodeExe = isWindows ? 'node.exe' : 'node';
    const binDir = path.dirname(iflowPath);
    const candidatePath = path.join(binDir, nodeExe);

    if (fs.existsSync(candidatePath)) {
      this.log(`Auto-detected node at: ${candidatePath}`);
      return candidatePath;
    }

    // Windows fallback: iflow.cmd may be in %APPDATA%\npm while node.exe is elsewhere
    if (isWindows) {
      return this.findNodePathWindows();
    }

    this.log(`Node not found alongside iflow at ${binDir}`);
    return null;
  }

  private findNodePathWindows(): Promise<string | null> {
    return new Promise((resolve) => {
      cp.exec('where node', { timeout: 5000 }, (error, stdout) => {
        if (!error && stdout.trim()) {
          resolve(stdout.trim().split(/\r?\n/)[0]);
        } else {
          resolve(null);
        }
      });
    });
  }

  // ── Auto-detection orchestration ────────────────────────────────────

  /**
   * Auto-detect Node.js and iFlow script paths from the iFlow CLI location.
   * Results are cached per client instance.
   */
  private async autoDetectNodePath(): Promise<{ nodePath: string; iflowScript: string } | null> {
    // undefined = not yet attempted; null = attempted and failed
    if (this._cachedAutoDetect !== undefined) {
      return this._cachedAutoDetect;
    }

    this.logInfo('Attempting auto-detection of Node.js path from iflow CLI location');

    const iflowPath = await this.findIFlowPathCrossPlatform();
    if (!iflowPath) {
      this.logInfo('Auto-detection: iflow CLI not found in PATH or APPDATA');
      this._cachedAutoDetect = null;
      return null;
    }

    this.logInfo(`Auto-detection: found iflow at ${iflowPath}`);

    const nodePath = await this.deriveNodePathFromIFlow(iflowPath);
    if (!nodePath) {
      this.logInfo('Auto-detection: could not derive node path from iflow location');
      this._cachedAutoDetect = null;
      return null;
    }

    const iflowScript = this.resolveIFlowScriptCrossPlatform(iflowPath);
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

    // Tier 1: User-configured nodePath
    if (config.nodePath) {
      this.log(`Using user-configured nodePath: ${config.nodePath}`);
      const iflowPath = await this.findIFlowPathCrossPlatform();
      if (!iflowPath) {
        throw new Error('iFlow CLI not found. Please install iFlow CLI first.');
      }
      const iflowScript = this.resolveIFlowScriptCrossPlatform(iflowPath);
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
      const iflowPath = await this.findIFlowPathCrossPlatform();
      if (!iflowPath) {
        throw new Error('iFlow CLI not found in PATH. Please install iFlow CLI first.');
      }
      iflowScript = this.resolveIFlowScriptCrossPlatform(iflowPath);
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
  ): Promise<void> {
    this.isCancelled = false;
    this.parser = new ThinkingParser();

    // Update model in CLI settings so all internal code paths use it
    this.updateIFlowCliModel(options.model);

    this.log(`Starting run with options: ${JSON.stringify({ mode: options.mode, model: options.model, think: options.think })}`);

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
      this.isConnected = true;
      this.log('Connected to iFlow');

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

  private mapMode(mode: ConversationMode): 'default' | 'autoEdit' | 'yolo' | 'plan' {
    switch (mode) {
      case 'default':
        return 'default';
      case 'yolo':
        return 'yolo';
      case 'plan':
        return 'plan';
      case 'autoEdit':
        return 'autoEdit';
      default:
        return 'default';
    }
  }

  private buildPrompt(options: RunOptions): string {
    let prompt = '';

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

    if (options.think) {
      prompt += '[Please think step by step before answering]\n\n';
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
        if (message.chunk?.text) {
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
        // Task finish is handled in the run loop
        break;

      default:
        this.log(`Unknown message type: ${message.type}`);
    }

    return chunks;
  }
}
