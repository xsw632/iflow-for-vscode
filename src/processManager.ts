// Process lifecycle management for the iFlow CLI subprocess.

import * as cp from "child_process";
import WebSocket = require("ws");
import {
  findIFlowPathCrossPlatform,
  resolveIFlowScriptCrossPlatform,
  deriveNodePathFromIFlow,
} from "./cliDiscovery";
import {
  PROCESS_FORCE_KILL_TIMEOUT_MS,
} from "./constants/runtime";
import {
  findAvailablePort,
  isPortAvailable,
  resolveStartupPort,
} from "./process/portDiscovery";
import {
  isAddressInUseError,
} from "./process/startupSignals";
import {
  launchManagedProcess,
  type SpawnProcessFn,
} from "./process/processStartupProbe";
import { type WebSocketFactory } from "./process/webSocketReadinessProbe";

export interface ManualStartInfo {
  nodePath: string;
  iflowScript: string;
  port: number;
}

interface ProcessManagerConfig {
  nodePath: string | null;
  port: number;
}

interface ProcessManagerDependencies {
  spawn?: SpawnProcessFn;
  createWebSocket?: WebSocketFactory;
  isPortAvailable?: (port: number) => Promise<boolean>;
  findAvailablePort?: () => Promise<number>;
}

export class ProcessManager {
  private managedProcess: cp.ChildProcess | null = null;
  private managedPort: number | null = null;
  // Auto-detection cache: undefined = not attempted, null = attempted & failed, object = success
  private _cachedAutoDetect:
    | { nodePath: string; iflowScript: string }
    | null
    | undefined = undefined;
  // CLI path cache: undefined = not attempted, null = attempted & failed, string = success
  private _cachedIflowPath: string | null | undefined = undefined;
  private readonly spawnProcess: SpawnProcessFn;
  private readonly createWebSocket: WebSocketFactory;
  private readonly checkPortAvailable: (port: number) => Promise<boolean>;
  private readonly allocateAvailablePort: () => Promise<number>;

  constructor(
    private log: (message: string) => void,
    private logInfo: (message: string) => void,
    deps: ProcessManagerDependencies = {},
  ) {
    this.spawnProcess = deps.spawn ?? cp.spawn;
    this.createWebSocket =
      deps.createWebSocket ??
      ((url, options) => this.createDefaultWebSocket(url, options));
    this.checkPortAvailable = deps.isPortAvailable ?? isPortAvailable;
    this.allocateAvailablePort = deps.findAvailablePort ?? findAvailablePort;
  }

  /** Whether a managed process is currently running. */
  get hasProcess(): boolean {
    return this.managedProcess !== null;
  }

  /** Actual ACP port used by the managed process (if known). */
  get currentPort(): number | null {
    return this.managedPort;
  }

  // ── Auto-detection orchestration ────────────────────────────────

  /**
   * Auto-detect Node.js and iFlow script paths from the iFlow CLI location.
   * Results are cached per instance.
   */
  async autoDetectNodePath(): Promise<{
    nodePath: string;
    iflowScript: string;
  } | null> {
    // undefined = not yet attempted; null = attempted and failed
    if (this._cachedAutoDetect !== undefined) {
      return this._cachedAutoDetect;
    }

    const logFn = this.logInfo;
    this.logInfo(
      "Attempting auto-detection of Node.js path from iflow CLI location",
    );

    const iflowPath = await this.findIFlowPathCached();
    if (!iflowPath) {
      this.logInfo("Auto-detection: iflow CLI not found in PATH or APPDATA");
      this._cachedAutoDetect = null;
      return null;
    }

    this.logInfo(`Auto-detection: found iflow at ${iflowPath}`);

    const iflowScript = resolveIFlowScriptCrossPlatform(iflowPath, logFn);
    if (!iflowScript) {
      this.logInfo(
        "Auto-detection: failed to resolve iFlow script from CLI wrapper",
      );
      this._cachedAutoDetect = null;
      return null;
    }

    const nodePath = await deriveNodePathFromIFlow(
      iflowPath,
      logFn,
      iflowScript,
    );
    if (!nodePath) {
      this.logInfo(
        "Auto-detection: could not derive node path from iflow location",
      );
      this._cachedAutoDetect = null;
      return null;
    }
    this.logInfo(
      `Auto-detection successful: node=${nodePath}, script=${iflowScript}`,
    );

    this._cachedAutoDetect = { nodePath, iflowScript };
    return this._cachedAutoDetect;
  }

  /**
   * Determine how to start the iFlow process.
   * Tier 1: User-configured nodePath
   * Tier 2: Auto-detected from iflow CLI location
   * Tier 3: null (caller decides how to proceed)
   */
  async resolveStartMode(
    config: ProcessManagerConfig,
  ): Promise<ManualStartInfo | null> {
    const logFn = this.logInfo;

    // Tier 1: User-configured nodePath (uses cached CLI path lookup)
    if (config.nodePath) {
      this.log(`Using user-configured nodePath: ${config.nodePath}`);
      const iflowPath = await this.findIFlowPathCached();
      if (!iflowPath) {
        throw new Error("iFlow CLI not found. Please install iFlow CLI first.");
      }
      const iflowScript = resolveIFlowScriptCrossPlatform(iflowPath, logFn);
      if (!iflowScript) {
        throw new Error(
          "Failed to resolve iFlow CLI script path from wrapper.",
        );
      }
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

    // Tier 3: No manual start path available.
    this.log(
      "No manual node path available from user config or auto-detection",
    );
    return null;
  }

  clearAutoDetectCache(): void {
    this._cachedAutoDetect = undefined;
    this._cachedIflowPath = undefined;
  }

  // ── Process management ──────────────────────────────────────────────

  /**
   * Start iFlow process manually with a specific Node path.
   * If iflowScript is provided, uses it directly; otherwise discovers it.
   */
  async startManagedProcess(
    nodePath: string,
    port: number,
    iflowScript?: string,
    cwd?: string,
    enableStream = true,
    autoPortFallback = true,
  ): Promise<number> {
    if (!iflowScript) {
      const logFn = this.logInfo;
      const iflowPath = await this.findIFlowPathCached();
      if (!iflowPath) {
        throw new Error(
          "iFlow CLI not found in PATH. Please install iFlow CLI first.",
        );
      }
      const resolvedScript = resolveIFlowScriptCrossPlatform(iflowPath, logFn);
      if (!resolvedScript) {
        throw new Error(
          "Failed to resolve iFlow CLI script path from wrapper.",
        );
      }
      iflowScript = resolvedScript;
    }

    let startupPort = port;
    if (autoPortFallback) {
      startupPort = await resolveStartupPort(port, {
        isPortAvailable: this.checkPortAvailable,
        findAvailablePort: this.allocateAvailablePort,
      });
      if (startupPort !== port) {
        this.log(
          `ACP configured port ${port} is busy; falling back to available port ${startupPort}`,
        );
      }
    }

    try {
      return await this.startManagedProcessOnPort(
        nodePath,
        startupPort,
        iflowScript,
        cwd,
        enableStream,
      );
    } catch (err: unknown) {
      if (!autoPortFallback || !isAddressInUseError(err)) {
        throw err;
      }

      const retryPort = await this.allocateAvailablePort();
      if (retryPort === startupPort) {
        throw err;
      }

      this.log(
        `ACP port ${startupPort} became unavailable during startup; retrying with port ${retryPort}`,
      );
      return this.startManagedProcessOnPort(
        nodePath,
        retryPort,
        iflowScript,
        cwd,
        enableStream,
      );
    }
  }

  private async startManagedProcessOnPort(
    nodePath: string,
    port: number,
    iflowScript: string,
    cwd?: string,
    enableStream = true,
  ): Promise<number> {
    const startup = launchManagedProcess(
      {
        nodePath,
        port,
        iflowScript,
        cwd,
        enableStream,
      },
      {
        spawnProcess: this.spawnProcess,
        createWebSocket: this.createWebSocket,
        log: this.log,
      },
    );

    this.managedProcess = startup.childProcess;
    this.managedProcess.on("exit", () => {
      this.managedProcess = null;
      this.managedPort = null;
    });

    try {
      const effectivePort = await startup.ready;
      this.managedPort = effectivePort;
      return effectivePort;
    } catch (error) {
      this.managedPort = null;
      throw error;
    }
  }

  /**
   * Stop the managed iFlow process.
   * Uses taskkill on Windows (SIGTERM is unreliable there).
   */
  stopManagedProcess(): void {
    if (this.managedProcess) {
      this.log("Stopping managed iFlow process");
      if (process.platform === "win32") {
        try {
          cp.execSync(`taskkill /F /T /PID ${this.managedProcess.pid}`, {
            windowsHide: true,
            timeout: PROCESS_FORCE_KILL_TIMEOUT_MS,
            stdio: "ignore",
          });
        } catch {
          // Process may have already exited
        }
      } else {
        this.managedProcess.kill("SIGTERM");
      }
      this.managedProcess = null;
      this.managedPort = null;
    }
  }

  private async findIFlowPathCached(): Promise<string | null> {
    if (this._cachedIflowPath !== undefined) {
      return this._cachedIflowPath;
    }
    this._cachedIflowPath = await findIFlowPathCrossPlatform(this.logInfo);
    return this._cachedIflowPath;
  }

  private createDefaultWebSocket(
    url: string,
    options?: { handshakeTimeout?: number },
  ): ReturnType<WebSocketFactory> {
    return new WebSocket(url, undefined, options);
  }
}
