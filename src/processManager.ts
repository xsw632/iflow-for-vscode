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
  PROCESS_WS_MAX_ATTEMPTS,
  PROCESS_WS_RETRY_INTERVAL_MS,
} from "./constants/runtime";
import {
  findAvailablePort,
  isPortAvailable,
  resolveStartupPort,
} from "./process/portDiscovery";
import {
  buildStartupFailureMessage,
  extractManagedPort,
  isAddressInUseError,
  isReadySignal,
} from "./process/startupSignals";
import {
  waitForWebSocketReadiness,
  type WebSocketFactory,
} from "./process/webSocketReadinessProbe";

// ── Process lifecycle constants ──────────────────────────────────────
const PROCESS_STARTUP_TIMEOUT_MS = 30_000;
const PROCESS_READY_FALLBACK_MS = 2_000;
const PROCESS_INIT_DELAY_MS = 500;
const STARTUP_LOG_BUFFER_MAX_LINES = 20;
const PROCESS_WS_HANDSHAKE_TIMEOUT_MS = 1_000;

export interface ManualStartInfo {
  nodePath: string;
  iflowScript: string;
  port: number;
}

interface ProcessManagerConfig {
  nodePath: string | null;
  port: number;
}

type SpawnFn = typeof cp.spawn;
interface ProcessManagerDependencies {
  spawn?: SpawnFn;
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
  private readonly spawnProcess: SpawnFn;
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
    this.log(
      `Starting iFlow with Node: ${nodePath}, script: ${iflowScript}, port: ${port}, stream=${enableStream}`,
    );
    this.log(
      `Command: ${nodePath} ${iflowScript} --experimental-acp --port ${port}${enableStream ? " --stream" : ""}`,
    );

    return new Promise((resolve, reject) => {
      const args = [iflowScript!, "--experimental-acp", "--port", String(port)];
      if (enableStream) {
        args.push("--stream");
      }

      // Buffer to collect output for error reporting
      const stdoutBuffer: string[] = [];
      const stderrBuffer: string[] = [];
      this.managedProcess = this.spawnProcess(nodePath, args, {
        cwd: cwd ?? process.cwd(),
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let settled = false;
      let started = false;
      let effectivePort = port;

      const settleResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        started = true;
        clearTimeout(timeout);
        this.managedPort = effectivePort;
        resolve(effectivePort);
      };

      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.managedPort = null;
        reject(error);
      };

      const ingestOutput = (output: string) => {
        const parsedPort = extractManagedPort(output);
        if (parsedPort !== null && parsedPort !== effectivePort) {
          effectivePort = parsedPort;
          this.log(
            `Detected managed ACP port from CLI output: ${effectivePort}`,
          );
        }
      };

      const timeout = setTimeout(() => {
        if (!started) {
          settleReject(
            new Error(
              buildStartupFailureMessage(
                null,
                stdoutBuffer,
                stderrBuffer,
                effectivePort,
                nodePath,
                PROCESS_STARTUP_TIMEOUT_MS,
              ),
            ),
          );
        }
      }, PROCESS_STARTUP_TIMEOUT_MS);

      this.managedProcess.stdout?.on("data", (data: Buffer) => {
        const output = data.toString();
        ingestOutput(output);
        stdoutBuffer.push(output);
        if (stdoutBuffer.length > STARTUP_LOG_BUFFER_MAX_LINES) {
          stdoutBuffer.shift();
        }
        this.log(`[iFlow stdout] ${output}`);
        // Look for ready signal
        if (isReadySignal(output)) {
          if (!started) {
            // Give it a moment to fully initialize
            setTimeout(() => settleResolve(), PROCESS_INIT_DELAY_MS);
          }
        }
      });

      this.managedProcess.stderr?.on("data", (data: Buffer) => {
        const output = data.toString();
        ingestOutput(output);
        stderrBuffer.push(output);
        if (stderrBuffer.length > STARTUP_LOG_BUFFER_MAX_LINES) {
          stderrBuffer.shift();
        }
        this.log(`[iFlow stderr] ${output}`);
        // Some CLIs output ready messages to stderr
        if (isReadySignal(output)) {
          if (!started) {
            setTimeout(() => settleResolve(), PROCESS_INIT_DELAY_MS);
          }
        }
      });

      this.managedProcess.on("error", (err) => {
        this.log(`iFlow process error: ${err.message}`);
        settleReject(new Error(`Failed to start iFlow: ${err.message}`));
      });

      // If no ready signal, try to connect via WebSocket to confirm server is ready
      const checkWebSocketReady = async () => {
        const readiness = await waitForWebSocketReadiness({
          createWebSocket: this.createWebSocket,
          getWebSocketUrl: () => `ws://localhost:${effectivePort}/acp`,
          maxAttempts: PROCESS_WS_MAX_ATTEMPTS,
          retryIntervalMs: PROCESS_WS_RETRY_INTERVAL_MS,
          handshakeTimeoutMs: PROCESS_WS_HANDSHAKE_TIMEOUT_MS,
          connectionTimeoutMs: PROCESS_READY_FALLBACK_MS,
          isCancelled: () =>
            started ||
            settled ||
            !this.managedProcess ||
            this.managedProcess.killed,
          onFirstFailure: (message) => {
            this.log(`[WebSocket check] Attempt 1 failed: ${message}`);
          },
        });

        if (readiness.ready) {
          if (!started) {
            this.log(
              `[process ready] WebSocket connection confirmed on port ${effectivePort} ` +
                `after ${readiness.attempts} attempt(s)`,
            );
            settleResolve();
          }
          return;
        }

        if (!started && !settled) {
          this.log(
            `[process warning] WebSocket not ready after ${PROCESS_WS_MAX_ATTEMPTS} attempts, proceeding anyway`,
          );
          settleResolve();
        }
      };

      // Start WebSocket readiness check after a short delay
      const initTimeout = setTimeout(() => {
        if (!started && this.managedProcess && !this.managedProcess.killed) {
          checkWebSocketReady();
        }
      }, PROCESS_INIT_DELAY_MS);

      // Consolidated exit listener: handles rejection, cleanup, and timeout cancellation
      this.managedProcess.on("exit", (code) => {
        clearTimeout(initTimeout);
        this.log(`iFlow process exited with code: ${code}`);
        if (!started && !settled) {
          settleReject(
            new Error(
              buildStartupFailureMessage(
                code,
                stdoutBuffer,
                stderrBuffer,
                effectivePort,
                nodePath,
                PROCESS_STARTUP_TIMEOUT_MS,
              ),
            ),
          );
        }

        // Process has exited; ensure cached state is reset.
        this.managedPort = null;

        if (!started) {
          // Log collected output for debugging
          if (stdoutBuffer.length > 0) {
            this.log(`[iFlow stdout buffer]\n${stdoutBuffer.join("")}`);
          }
          if (stderrBuffer.length > 0) {
            this.log(`[iFlow stderr buffer]\n${stderrBuffer.join("")}`);
          }
        }
        this.managedProcess = null;
      });
    });
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
