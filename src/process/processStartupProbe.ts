import * as cp from "child_process";
import {
  buildStartupFailureMessage,
  extractManagedPort,
  isReadySignal,
} from "./startupSignals";
import {
  waitForWebSocketReadiness,
  type WebSocketFactory,
} from "./webSocketReadinessProbe";

const PROCESS_STARTUP_TIMEOUT_MS = 30_000;
const PROCESS_READY_FALLBACK_MS = 2_000;
const PROCESS_INIT_DELAY_MS = 500;
const STARTUP_LOG_BUFFER_MAX_LINES = 20;
const PROCESS_WS_MAX_ATTEMPTS = 8;
const PROCESS_WS_RETRY_INTERVAL_MS = 250;
const PROCESS_WS_HANDSHAKE_TIMEOUT_MS = 1_000;

export type SpawnProcessFn = typeof cp.spawn;

export interface ProcessStartupProbeOptions {
  nodePath: string;
  port: number;
  iflowScript: string;
  cwd?: string;
  enableStream?: boolean;
}

export interface ProcessStartupProbeDependencies {
  spawnProcess: SpawnProcessFn;
  createWebSocket: WebSocketFactory;
  log: (message: string) => void;
}

export interface StartManagedProcessWithProbeOptions
  extends ProcessStartupProbeOptions,
    ProcessStartupProbeDependencies {
  isCancelled?: () => boolean;
}

export interface ProcessStartupProbeHandle {
  childProcess: cp.ChildProcess;
  ready: Promise<number>;
}

export type ProcessStartupReadyVia = "signal" | "websocket" | "fallback";

export interface ProcessStartupResult {
  process: cp.ChildProcess;
  port: number;
  readyVia: ProcessStartupReadyVia;
  readinessAttempts: number;
}

export class ProcessStartupProbeError extends Error {
  readonly code: number | null;
  readonly port: number;
  readonly stdoutBuffer: string[];
  readonly stderrBuffer: string[];

  constructor(params: {
    code: number | null;
    port: number;
    stdoutBuffer: string[];
    stderrBuffer: string[];
    nodePath: string;
  }) {
    super(
      buildStartupFailureMessage(
        params.code,
        params.stdoutBuffer,
        params.stderrBuffer,
        params.port,
        params.nodePath,
        PROCESS_STARTUP_TIMEOUT_MS,
      ),
    );
    this.name = "ProcessStartupProbeError";
    this.code = params.code;
    this.port = params.port;
    this.stdoutBuffer = [...params.stdoutBuffer];
    this.stderrBuffer = [...params.stderrBuffer];
  }
}

interface StructuredProcessStartupProbeHandle {
  childProcess: cp.ChildProcess;
  ready: Promise<ProcessStartupResult>;
}

export function launchManagedProcess(
  options: ProcessStartupProbeOptions,
  deps: ProcessStartupProbeDependencies,
): ProcessStartupProbeHandle {
  const startup = createStartupProbe(options, {
    ...deps,
    isCancelled: () => false,
  });
  return {
    childProcess: startup.childProcess,
    ready: startup.ready.then((result) => result.port),
  };
}

export async function startManagedProcessWithProbe(
  options: StartManagedProcessWithProbeOptions,
): Promise<ProcessStartupResult> {
  const startup = createStartupProbe(options, {
    ...options,
    isCancelled: options.isCancelled ?? (() => false),
  });
  return startup.ready;
}

function createStartupProbe(
  options: ProcessStartupProbeOptions,
  deps: ProcessStartupProbeDependencies & { isCancelled: () => boolean },
): StructuredProcessStartupProbeHandle {
  const { nodePath, port, iflowScript, cwd, enableStream = true } = options;

  deps.log(
    `Starting iFlow with Node: ${nodePath}, script: ${iflowScript}, port: ${port}, stream=${enableStream}`,
  );
  deps.log(
    `Command: ${nodePath} ${iflowScript} --experimental-acp --port ${port}${enableStream ? " --stream" : ""}`,
  );

  const args = [iflowScript, "--experimental-acp", "--port", String(port)];
  if (enableStream) {
    args.push("--stream");
  }

  const childProcess = deps.spawnProcess(nodePath, args, {
    cwd: cwd ?? process.cwd(),
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const ready = new Promise<ProcessStartupResult>((resolve, reject) => {
    const stdoutBuffer: string[] = [];
    const stderrBuffer: string[] = [];

    let settled = false;
    let started = false;
    let effectivePort = port;
    let initTimeout: NodeJS.Timeout | null = null;
    let readySignalSeen = false;

    const clearInitTimeout = (): void => {
      if (!initTimeout) {
        return;
      }
      clearTimeout(initTimeout);
      initTimeout = null;
    };

    const settleResolve = (
      readyVia: ProcessStartupReadyVia,
      readinessAttempts: number,
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      started = true;
      clearTimeout(timeout);
      clearInitTimeout();
      resolve({
        process: childProcess,
        port: effectivePort,
        readyVia,
        readinessAttempts,
      });
    };

    const settleReject = (error: Error | ProcessStartupProbeError) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearInitTimeout();
      reject(error);
    };

    const ingestOutput = (output: string) => {
      const parsedPort = extractManagedPort(output);
      if (parsedPort !== null && parsedPort !== effectivePort) {
        effectivePort = parsedPort;
        deps.log(`Detected managed ACP port from CLI output: ${effectivePort}`);
      }
    };

    const timeout = setTimeout(() => {
      if (!started) {
        settleReject(
          new ProcessStartupProbeError({
            code: null,
            port: effectivePort,
            stdoutBuffer,
            stderrBuffer,
            nodePath,
          }),
        );
      }
    }, PROCESS_STARTUP_TIMEOUT_MS);

    childProcess.stdout?.on("data", (data: Buffer) => {
      const output = data.toString();
      ingestOutput(output);
      stdoutBuffer.push(output);
      if (stdoutBuffer.length > STARTUP_LOG_BUFFER_MAX_LINES) {
        stdoutBuffer.shift();
      }
      deps.log(`[iFlow stdout] ${output}`);
      if (isReadySignal(output) && !started) {
        readySignalSeen = true;
        setTimeout(() => settleResolve("signal", 0), PROCESS_INIT_DELAY_MS);
      }
    });

    childProcess.stderr?.on("data", (data: Buffer) => {
      const output = data.toString();
      ingestOutput(output);
      stderrBuffer.push(output);
      if (stderrBuffer.length > STARTUP_LOG_BUFFER_MAX_LINES) {
        stderrBuffer.shift();
      }
      deps.log(`[iFlow stderr] ${output}`);
      if (isReadySignal(output) && !started) {
        readySignalSeen = true;
        setTimeout(() => settleResolve("signal", 0), PROCESS_INIT_DELAY_MS);
      }
    });

    childProcess.on("error", (err) => {
      deps.log(`iFlow process error: ${err.message}`);
      settleReject(new Error(`Failed to start iFlow: ${err.message}`));
    });

    const checkWebSocketReady = async () => {
      const readiness = await waitForWebSocketReadiness({
        createWebSocket: deps.createWebSocket,
        getWebSocketUrl: () => `ws://localhost:${effectivePort}/acp`,
        maxAttempts: PROCESS_WS_MAX_ATTEMPTS,
        retryIntervalMs: PROCESS_WS_RETRY_INTERVAL_MS,
        handshakeTimeoutMs: PROCESS_WS_HANDSHAKE_TIMEOUT_MS,
        connectionTimeoutMs: PROCESS_READY_FALLBACK_MS,
        isCancelled: () =>
          started || settled || childProcess.killed || deps.isCancelled(),
        onFirstFailure: (message) => {
          deps.log(`[WebSocket check] Attempt 1 failed: ${message}`);
        },
      });

      if (readiness.ready) {
        if (!started) {
          deps.log(
            `[process ready] WebSocket connection confirmed on port ${effectivePort} ` +
              `after ${readiness.attempts} attempt(s)`,
          );
          settleResolve("websocket", readiness.attempts);
        }
        return;
      }

      if (!started && !settled) {
        deps.log(
          `[process warning] WebSocket not ready after ${PROCESS_WS_MAX_ATTEMPTS} attempts, proceeding anyway`,
        );
        settleResolve("fallback", readiness.attempts);
      }
    };

    initTimeout = setTimeout(() => {
      if (!started && !childProcess.killed && !readySignalSeen) {
        void checkWebSocketReady();
      }
    }, PROCESS_INIT_DELAY_MS);

    childProcess.on("exit", (code) => {
      clearInitTimeout();
      deps.log(`iFlow process exited with code: ${code}`);
      if (!started && !settled) {
        settleReject(
          new ProcessStartupProbeError({
            code,
            port: effectivePort,
            stdoutBuffer,
            stderrBuffer,
            nodePath,
          }),
        );
      }

      if (!started) {
        if (stdoutBuffer.length > 0) {
          deps.log(`[iFlow stdout buffer]\n${stdoutBuffer.join("")}`);
        }
        if (stderrBuffer.length > 0) {
          deps.log(`[iFlow stderr buffer]\n${stderrBuffer.join("")}`);
        }
      }
    });
  });

  return { childProcess, ready };
}
