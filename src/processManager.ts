// Process lifecycle management for the iFlow CLI subprocess.

import * as cp from 'child_process';
import { findIFlowPathCrossPlatform, resolveIFlowScriptCrossPlatform, deriveNodePathFromIFlow } from './cliDiscovery';

// ── Process lifecycle constants ──────────────────────────────────────
const PROCESS_STARTUP_TIMEOUT_MS = 30_000;
const PROCESS_READY_FALLBACK_MS = 2_000;
const PROCESS_INIT_DELAY_MS = 500;

export interface ManualStartInfo {
  nodePath: string;
  iflowScript: string;
  port: number;
}

export interface ProcessManagerConfig {
  nodePath: string | null;
  port: number;
}

export class ProcessManager {
  private managedProcess: cp.ChildProcess | null = null;
  // Auto-detection cache: undefined = not attempted, null = attempted & failed, object = success
  private _cachedAutoDetect: { nodePath: string; iflowScript: string } | null | undefined = undefined;

  constructor(
    private log: (message: string) => void,
    private logInfo: (message: string) => void,
    private getCwd: () => string | undefined
  ) {}

  /** Whether a managed process is currently running. */
  get hasProcess(): boolean {
    return this.managedProcess !== null;
  }

  // ── Auto-detection orchestration ────────────────────────────────

  /**
   * Auto-detect Node.js and iFlow script paths from the iFlow CLI location.
   * Results are cached per instance.
   */
  async autoDetectNodePath(): Promise<{ nodePath: string; iflowScript: string } | null> {
    // undefined = not yet attempted; null = attempted and failed
    if (this._cachedAutoDetect !== undefined) {
      return this._cachedAutoDetect;
    }

    const logFn = this.logInfo;
    this.logInfo('Attempting auto-detection of Node.js path from iflow CLI location');

    const iflowPath = await findIFlowPathCrossPlatform(logFn);
    if (!iflowPath) {
      this.logInfo('Auto-detection: iflow CLI not found in PATH or APPDATA');
      this._cachedAutoDetect = null;
      return null;
    }

    this.logInfo(`Auto-detection: found iflow at ${iflowPath}`);

    const nodePath = await deriveNodePathFromIFlow(iflowPath, logFn);
    if (!nodePath) {
      this.logInfo('Auto-detection: could not derive node path from iflow location');
      this._cachedAutoDetect = null;
      return null;
    }

    const iflowScript = resolveIFlowScriptCrossPlatform(iflowPath, logFn);
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
  async resolveStartMode(config: ProcessManagerConfig): Promise<ManualStartInfo | null> {
    const logFn = this.logInfo;

    // Tier 1: User-configured nodePath
    if (config.nodePath) {
      this.log(`Using user-configured nodePath: ${config.nodePath}`);
      const iflowPath = await findIFlowPathCrossPlatform(logFn);
      if (!iflowPath) {
        throw new Error('iFlow CLI not found. Please install iFlow CLI first.');
      }
      const iflowScript = resolveIFlowScriptCrossPlatform(iflowPath, logFn);
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
  async startManagedProcess(nodePath: string, port: number, iflowScript?: string): Promise<void> {
    if (!iflowScript) {
      const logFn = this.logInfo;
      const iflowPath = await findIFlowPathCrossPlatform(logFn);
      if (!iflowPath) {
        throw new Error('iFlow CLI not found in PATH. Please install iFlow CLI first.');
      }
      iflowScript = resolveIFlowScriptCrossPlatform(iflowPath, logFn);
    }

    this.log(`Starting iFlow with Node: ${nodePath}, script: ${iflowScript}, port: ${port}`);

    return new Promise((resolve, reject) => {
      const args = [iflowScript!, '--experimental-acp', '--port', String(port)];

      this.managedProcess = cp.spawn(nodePath, args, {
        cwd: this.getCwd(),
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let started = false;
      const timeout = setTimeout(() => {
        if (!started) {
          reject(new Error('iFlow process startup timeout'));
        }
      }, PROCESS_STARTUP_TIMEOUT_MS);

      this.managedProcess.stdout?.on('data', (data: Buffer) => {
        const output = data.toString();
        this.log(`[iFlow stdout] ${output}`);
        // Look for ready signal
        if (output.includes('listening') || output.includes('ready') || output.includes('port')) {
          if (!started) {
            started = true;
            clearTimeout(timeout);
            // Give it a moment to fully initialize
            setTimeout(() => resolve(), PROCESS_INIT_DELAY_MS);
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
            setTimeout(() => resolve(), PROCESS_INIT_DELAY_MS);
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

      // If no ready signal after fallback timeout, assume it's ready anyway
      setTimeout(() => {
        if (!started && this.managedProcess && !this.managedProcess.killed) {
          started = true;
          clearTimeout(timeout);
          resolve();
        }
      }, PROCESS_READY_FALLBACK_MS);
    });
  }

  /**
   * Stop the managed iFlow process.
   */
  stopManagedProcess(): void {
    if (this.managedProcess) {
      this.log('Stopping managed iFlow process');
      this.managedProcess.kill('SIGTERM');
      this.managedProcess = null;
    }
  }
}
