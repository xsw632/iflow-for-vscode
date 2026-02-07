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

  private log(message: string): void {
    const debugLogging = vscode.workspace.getConfiguration('iflow').get<boolean>('debugLogging', false);
    if (debugLogging) {
      if (!this.outputChannel) {
        this.outputChannel = vscode.window.createOutputChannel('IFlow');
      }
      const timestamp = new Date().toISOString();
      this.outputChannel.appendLine(`[${timestamp}] ${message}`);
      console.log('[IFlow]', message);
    }
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

  /**
   * Find iFlow CLI path using 'which' command
   */
  private async findIFlowPath(): Promise<string | null> {
    return new Promise((resolve) => {
      cp.exec('which iflow', (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve(null);
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }

  /**
   * Start iFlow process manually with custom Node path
   */
  private async startManagedProcess(nodePath: string, port: number): Promise<void> {
    const iflowPath = await this.findIFlowPath();
    if (!iflowPath) {
      throw new Error('iFlow CLI not found in PATH. Please install iFlow CLI first.');
    }

    this.log(`Starting iFlow with Node: ${nodePath}, iFlow: ${iflowPath}, port: ${port}`);

    // Get the actual script path from the iflow executable
    // iflow is usually a symlink or wrapper, we need to find the actual JS file
    const iflowScript = await this.resolveIFlowScript(iflowPath);

    return new Promise((resolve, reject) => {
      const args = [iflowScript, '--experimental-acp', '--port', String(port)];

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
   * Resolve the actual JavaScript file from iflow executable
   */
  private async resolveIFlowScript(iflowPath: string): Promise<string> {
    return new Promise((resolve) => {
      // Try to read the shebang/script to find actual JS file
      cp.exec(`readlink -f "${iflowPath}"`, (error, stdout) => {
        if (error || !stdout.trim()) {
          // If readlink fails, just use the path directly
          resolve(iflowPath);
        } else {
          resolve(stdout.trim());
        }
      });
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

  private getSDKOptions(): Record<string, unknown> {
    const config = this.getConfig();
    const useManualProcess = !!config.nodePath;

    const options: Record<string, unknown> = {
      timeout: config.timeout,
      logLevel: config.debugLogging ? 'DEBUG' : 'WARN',
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    };

    if (useManualProcess) {
      // Connect to our manually started process
      options.autoStartProcess = false;
      options.url = `ws://localhost:${config.port}/acp`;
    } else {
      // Let SDK manage the process
      options.autoStartProcess = true;
      options.processStartPort = config.port;
    }

    return options;
  }

  async checkAvailability(): Promise<string | null> {
    this.log('Checking iFlow CLI availability via SDK');
    const config = this.getConfig();

    try {
      // If using custom Node path, start the process first
      if (config.nodePath) {
        await this.startManagedProcess(config.nodePath, config.port);
      }

      const sdk = await getSDK();
      const testClient = new sdk.IFlowClient(this.getSDKOptions());
      await testClient.connect();
      await testClient.disconnect();

      this.log('iFlow CLI is available');
      return 'SDK Connected';
    } catch (error) {
      this.log(`iFlow CLI not available: ${error instanceof Error ? error.message : String(error)}`);
      return null;
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
    const config = this.getConfig();

    // Update model in CLI settings so all internal code paths use it
    this.updateIFlowCliModel(options.model);

    const sdkOptions: Record<string, unknown> = {
      ...this.getSDKOptions(),
      sessionSettings: {
        permission_mode: this.mapMode(options.mode),
      },
    };

    this.log(`Starting run with options: ${JSON.stringify({ mode: options.mode, model: options.model, think: options.think })}`);

    try {
      // If using custom Node path and process isn't running, start it
      if (config.nodePath && !this.managedProcess) {
        await this.startManagedProcess(config.nodePath, config.port);
      }

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
   * Full cleanup - disconnect SDK and stop managed process
   */
  async dispose(): Promise<void> {
    await this.disconnect();
    this.stopManagedProcess();
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

      case sdk.MessageType.TOOL_CALL:
        if (message.status === 'pending' || message.status === 'running') {
          chunks.push({
            chunkType: 'tool_start',
            name: message.toolName || message.label || 'unknown',
            input: {}
          });
        } else if (message.status === 'completed') {
          chunks.push({
            chunkType: 'tool_end',
            status: 'completed'
          });
        } else if (message.status === 'error') {
          chunks.push({
            chunkType: 'tool_end',
            status: 'error'
          });
        }
        break;

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
