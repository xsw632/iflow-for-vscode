import { AcpProtocol } from "../acpProtocol";
import { AcpTransport, AcpTransportOptions } from "../acpTransport";
import { RuntimeConfigApplier, normalizeCwd } from "./runtimeConfigApplier";
import { InteractionBridge } from "./interactionBridge";
import {
  ConnectionSnapshot,
  ConnectionStateListener,
  ConnectionStatus,
  RunOptions,
} from "./types";
import { normalizeErrorMessage } from "../errorUtils";

interface ProcessManagerLike {
  hasProcess: boolean;
  currentPort: number | null;
  stopManagedProcess(): void;
  resolveStartMode(config: {
    nodePath: string | null;
    port: number;
  }): Promise<{ nodePath: string; iflowScript: string; port: number } | null>;
  startManagedProcess(
    nodePath: string,
    port: number,
    iflowScript?: string,
    cwd?: string,
    enableStream?: boolean,
  ): Promise<number>;
}

interface SessionCoordinatorDependencies {
  createTransport: () => AcpTransport;
  createProtocol: (transport: AcpTransport) => AcpProtocol;
  getProcessManager: () => ProcessManagerLike;
  getConfig: <T>(key: string, defaultValue: T) => T;
  resolveAuthMethodOrder?: (availableMethodIds: string[]) => string[];
  runtimeConfigApplier: RuntimeConfigApplier;
  interactionBridge: InteractionBridge;
  log: (message: string) => void;
  onConnectionStateChange?: ConnectionStateListener;
}

const EMPTY_MCP_SERVERS: readonly never[] = [];
const AUTH_RECOVERY_ACTION = "Next step: run `iflow login` and retry.";

const INITIAL_CONNECTION_SNAPSHOT: ConnectionSnapshot = {
  status: "disconnected",
  isConnected: false,
  sessionId: null,
  connectedCwd: null,
  connectedMode: null,
  lastError: null,
};

export class SessionCoordinator {
  private transport: AcpTransport | null = null;
  private protocol: AcpProtocol | null = null;
  private snapshot: ConnectionSnapshot = { ...INITIAL_CONNECTION_SNAPSHOT };

  constructor(private readonly deps: SessionCoordinatorDependencies) {
    this.notifyState("initial");
  }

  get currentSessionId(): string | null {
    return this.snapshot.sessionId;
  }

  get currentProtocol(): AcpProtocol | null {
    return this.protocol;
  }

  get currentIsConnected(): boolean {
    return this.snapshot.isConnected;
  }

  get currentCwd(): string | null {
    return this.snapshot.connectedCwd;
  }

  get connectionSnapshot(): ConnectionSnapshot {
    return { ...this.snapshot };
  }

  // Backward-compat test hook.
  setConnectionForTests(state: {
    protocol?: AcpProtocol | null;
    isConnected?: boolean;
    sessionId?: string | null;
    connectedCwd?: string | null;
  }): void {
    if (state.protocol !== undefined) {
      this.protocol = state.protocol;
    }

    const merged: ConnectionSnapshot = {
      ...this.snapshot,
      isConnected: state.isConnected ?? this.snapshot.isConnected,
      sessionId: state.sessionId ?? this.snapshot.sessionId,
      connectedCwd: state.connectedCwd ?? this.snapshot.connectedCwd,
    };

    const status: ConnectionStatus =
      merged.isConnected && merged.sessionId ? "ready" : "disconnected";

    this.updateSnapshot(
      {
        ...merged,
        status,
        connectedMode:
          status === "ready" ? (merged.connectedMode ?? "default") : null,
      },
      "ready",
    );
  }

  async cancel(): Promise<void> {
    if (
      this.protocol &&
      this.snapshot.status === "ready" &&
      this.snapshot.sessionId
    ) {
      await this.protocol.sendRequest("session/cancel", {
        sessionId: this.snapshot.sessionId,
      });
    }
  }

  /**
   * Tear down the current transport/process and return to a reusable disconnected state.
   * Unlike dispose(), this keeps the coordinator reusable for future ensureConnected() calls.
   */
  async reset(): Promise<void> {
    if (this.snapshot.status === "disposed") {
      return;
    }
    this.deps.interactionBridge.clearPendingInteractions();
    await this.teardownConnection(true);
    this.updateSnapshot(
      {
        ...INITIAL_CONNECTION_SNAPSHOT,
      },
      "dispose",
    );
  }

  async dispose(): Promise<void> {
    this.deps.interactionBridge.clearPendingInteractions();
    await this.teardownConnection(true);
    this.updateSnapshot(
      {
        ...INITIAL_CONNECTION_SNAPSHOT,
        status: "disposed",
      },
      "dispose",
    );
  }

  async ensureConnected(options: RunOptions): Promise<void> {
    if (this.snapshot.status === "disposed") {
      throw new Error("Session coordinator is disposed");
    }

    const nextCwd = normalizeCwd(options.cwd);
    const canReuseConnection =
      this.snapshot.status === "ready" &&
      Boolean(this.protocol) &&
      this.snapshot.connectedCwd === nextCwd;

    if (canReuseConnection) {
      await this.ensureSessionLoadedForReusableConnection(options);
      return;
    }

    if (this.transport || this.protocol) {
      await this.teardownConnection(true);
      this.updateSnapshot({ ...INITIAL_CONNECTION_SNAPSHOT }, "dispose");
    }

    this.updateSnapshot(
      {
        ...INITIAL_CONNECTION_SNAPSHOT,
        status: "connecting",
      },
      "connect_start",
    );

    const configuredPort = this.deps.getConfig<number>("port", 8090);
    let acpPort = configuredPort;
    const timeout = this.deps.getConfig<number>("timeout", 60000);
    const enableCliStream = this.deps.getConfig<boolean>(
      "enableCliStream",
      true,
    );

    const processManager = this.deps.getProcessManager();
    try {
      if (!processManager.hasProcess) {
        const startInfo = await processManager.resolveStartMode({
          nodePath: this.deps.getConfig<string | null>("nodePath", null),
          port: configuredPort,
        });

        if (startInfo) {
          acpPort = await processManager.startManagedProcess(
            startInfo.nodePath,
            startInfo.port,
            startInfo.iflowScript,
            options.cwd,
            enableCliStream,
          );
        } else {
          throw new Error(
            "iFlow CLI not found. Please install it (npm i -g @iflow-ai/iflow-cli) or set iflow.nodePath in settings.",
          );
        }
      } else if (typeof processManager.currentPort === "number") {
        acpPort = processManager.currentPort;
      }
    } catch (error) {
      throw this.toLayerTaggedError(error, "TRANSPORT_ERROR");
    }

    let transport: AcpTransport;
    try {
      transport = this.deps.createTransport();
    } catch (error) {
      throw this.toLayerTaggedError(error, "TRANSPORT_ERROR");
    }
    this.transport = transport;

    transport.onClose = (error) => {
      this.handleTransportClosed(error);
    };

    let protocol: AcpProtocol;
    try {
      protocol = this.deps.createProtocol(transport);
    } catch (error) {
      throw this.toLayerTaggedError(error, "PROTOCOL_ERROR");
    }
    this.protocol = protocol;

    try {
      const connectOptions: AcpTransportOptions = {
        url: `ws://localhost:${acpPort}/acp`,
        timeout,
      };
      try {
        await transport.connect(connectOptions);
      } catch (error) {
        throw this.toLayerTaggedError(error, "TRANSPORT_ERROR");
      }

      this.updateSnapshot(
        {
          ...this.snapshot,
          status: "initializing",
        },
        "initialize_start",
      );

      this.deps.interactionBridge.registerServerHandlers(protocol);
      protocol.startReceiveLoop();

      let initResult: {
        isAuthenticated?: boolean;
        authMethods?: Array<{ id?: string }>;
      };
      try {
        initResult = (await protocol.sendRequest("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: {
              readTextFile: true,
              writeTextFile: true,
            },
          },
        })) as {
          isAuthenticated?: boolean;
          authMethods?: Array<{ id?: string }>;
        };
      } catch (error) {
        throw this.toLayerTaggedError(error, "PROTOCOL_ERROR");
      }

      if (!initResult.isAuthenticated) {
        const availableMethodIds = this.extractAuthMethodIds(
          initResult.authMethods,
        );
        const authMethodOrder = this.resolveAuthMethodOrder(availableMethodIds);
        let lastAuthError: Error | null = null;
        let authenticated = false;

        for (const methodId of authMethodOrder) {
          try {
            await protocol.sendRequest("authenticate", { methodId });
            this.deps.log(`ACP authenticate succeeded: methodId=${methodId}`);
            authenticated = true;
            break;
          } catch (error) {
            const message = normalizeErrorMessage(error);
            lastAuthError = error instanceof Error ? error : new Error(message);
            this.deps.log(
              `ACP authenticate failed: methodId=${methodId}, error=${message}`,
            );
          }
        }

        if (!authenticated) {
          if (lastAuthError) {
            throw this.toLayerTaggedError(lastAuthError, "AUTH_ERROR");
          }
          throw this.toLayerTaggedError(
            new Error("ACP authentication failed: no supported auth methods"),
            "AUTH_ERROR",
          );
        }
      }

      const cwd = options.cwd ?? process.cwd();
      let sessionSettings: ReturnType<
        RuntimeConfigApplier["buildSessionSettings"]
      >;
      try {
        sessionSettings =
          this.deps.runtimeConfigApplier.buildSessionSettings(options);
      } catch (error) {
        throw this.toLayerTaggedError(error, "PROTOCOL_ERROR");
      }

      let sessionId: string;
      if (options.sessionId) {
        try {
          await protocol.sendRequest("session/load", {
            sessionId: options.sessionId,
            cwd,
            mcpServers: EMPTY_MCP_SERVERS,
            settings: sessionSettings,
          });
        } catch (error) {
          throw this.toLayerTaggedError(error, "PROTOCOL_ERROR");
        }
        sessionId = options.sessionId;
      } else {
        let sessionResult: { sessionId?: string };
        try {
          sessionResult = (await protocol.sendRequest("session/new", {
            cwd,
            mcpServers: EMPTY_MCP_SERVERS,
            settings: sessionSettings,
          })) as { sessionId?: string };
        } catch (error) {
          throw this.toLayerTaggedError(error, "PROTOCOL_ERROR");
        }

        if (!sessionResult.sessionId) {
          throw this.toLayerTaggedError(
            new Error("session/new did not return sessionId"),
            "PROTOCOL_ERROR",
          );
        }
        sessionId = sessionResult.sessionId;
      }

      try {
        await this.deps.runtimeConfigApplier.applySessionRuntimeSettings(
          protocol,
          sessionId,
          options,
        );
      } catch (error) {
        throw this.toLayerTaggedError(error, "PROTOCOL_ERROR");
      }

      this.updateSnapshot(
        {
          status: "ready",
          isConnected: true,
          sessionId,
          connectedMode: options.mode,
          connectedCwd: nextCwd,
          lastError: null,
        },
        "ready",
      );
    } catch (err: unknown) {
      const taggedError = this.ensureLayerTag(err, "PROTOCOL_ERROR");
      const message = normalizeErrorMessage(taggedError);
      await this.teardownConnection(false);
      this.updateSnapshot(
        {
          ...INITIAL_CONNECTION_SNAPSHOT,
          status: "disconnected",
          lastError: message,
        },
        "error",
        taggedError,
      );
      throw taggedError;
    }
  }

  private async ensureSessionLoadedForReusableConnection(
    options: RunOptions,
  ): Promise<void> {
    if (!this.protocol || !this.snapshot.sessionId) {
      throw this.toLayerTaggedError(
        new Error("No active protocol/session for reusable connection"),
        "PROTOCOL_ERROR",
      );
    }

    try {
      const cwd = options.cwd ?? process.cwd();
      const sessionSettings =
        this.deps.runtimeConfigApplier.buildSessionSettings(options);
      const modeChanged =
        this.snapshot.connectedMode !== null &&
        this.snapshot.connectedMode !== options.mode;

      if (!options.sessionId) {
        // New conversation (no sessionId) — create a fresh server-side session
        // to avoid inheriting plan/todo state from the previous session.
        const sessionResult = (await this.protocol.sendRequest("session/new", {
          cwd,
          mcpServers: EMPTY_MCP_SERVERS,
          settings: sessionSettings,
        })) as { sessionId?: string };

        if (!sessionResult.sessionId) {
          throw new Error("session/new did not return sessionId");
        }

        this.updateSnapshot(
          {
            ...this.snapshot,
            sessionId: sessionResult.sessionId,
          },
          "ready",
        );
      } else if (options.sessionId !== this.snapshot.sessionId) {
        // Resuming a specific existing session — load it.
        await this.protocol.sendRequest("session/load", {
          sessionId: options.sessionId,
          cwd,
          mcpServers: EMPTY_MCP_SERVERS,
          settings: sessionSettings,
        });

        this.updateSnapshot(
          {
            ...this.snapshot,
            sessionId: options.sessionId,
          },
          "ready",
        );
      } else if (modeChanged) {
        // Same session id but different mode (for example plan -> smart/default):
        // reload session settings so mode-specific prompts (append_system_prompt)
        // do not leak into the next run.
        await this.protocol.sendRequest("session/load", {
          sessionId: options.sessionId,
          cwd,
          mcpServers: EMPTY_MCP_SERVERS,
          settings: sessionSettings,
        });
      }

      await this.deps.runtimeConfigApplier.applySessionRuntimeSettings(
        this.protocol,
        this.snapshot.sessionId!,
        options,
      );

      this.updateSnapshot(
        {
          ...this.snapshot,
          connectedMode: options.mode,
          lastError: null,
        },
        "ready",
      );
    } catch (error) {
      throw this.ensureLayerTag(error, "PROTOCOL_ERROR");
    }
  }

  private extractAuthMethodIds(
    authMethods: Array<{ id?: string }> | undefined,
  ): string[] {
    if (!Array.isArray(authMethods)) {
      return [];
    }

    const methodIds: string[] = [];
    const seen = new Set<string>();
    for (const method of authMethods) {
      if (!method || typeof method.id !== "string") {
        continue;
      }
      const id = method.id.trim();
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      methodIds.push(id);
    }
    return methodIds;
  }

  private resolveAuthMethodOrder(availableMethodIds: string[]): string[] {
    const preferred =
      this.deps.resolveAuthMethodOrder?.(availableMethodIds) ?? [];
    const fallbackDefaults = ["oauth-iflow", "iflow", "openai-compatible"];
    const requested = [
      ...preferred,
      ...fallbackDefaults,
      ...availableMethodIds,
    ];

    const availableSet = new Set(availableMethodIds);
    const order: string[] = [];
    const seen = new Set<string>();

    for (const methodId of requested) {
      if (!methodId || seen.has(methodId)) {
        continue;
      }
      if (availableSet.size > 0 && !availableSet.has(methodId)) {
        continue;
      }
      seen.add(methodId);
      order.push(methodId);
    }

    if (order.length > 0) {
      return order;
    }

    return availableMethodIds.length > 0 ? [...availableMethodIds] : ["iflow"];
  }

  private ensureLayerTag(
    error: unknown,
    fallbackLayer: "TRANSPORT_ERROR" | "AUTH_ERROR" | "PROTOCOL_ERROR",
  ): Error {
    const message = normalizeErrorMessage(error);
    if (this.hasKnownLayerTag(message)) {
      return error instanceof Error ? error : new Error(message);
    }
    return this.toLayerTaggedError(error, fallbackLayer);
  }

  private toLayerTaggedError(
    error: unknown,
    layer: "TRANSPORT_ERROR" | "AUTH_ERROR" | "PROTOCOL_ERROR",
  ): Error {
    const normalized = normalizeErrorMessage(error);
    const prefixed = this.hasKnownLayerTag(normalized)
      ? normalized
      : `[${layer}] ${normalized}`;
    const message =
      layer === "AUTH_ERROR" && !/iflow login/i.test(prefixed)
        ? `${prefixed} ${AUTH_RECOVERY_ACTION}`
        : prefixed;

    if (error instanceof Error && error.message === message) {
      return error;
    }

    if (error instanceof Error) {
      return new Error(message, { cause: error });
    }

    return new Error(message);
  }

  private hasKnownLayerTag(message: string): boolean {
    return /\[(TRANSPORT_ERROR|AUTH_ERROR|PROTOCOL_ERROR)\]/.test(message);
  }

  private handleTransportClosed(error?: Error): void {
    this.deps.log(`Connection closed: ${error?.message ?? "unknown reason"}`);

    this.protocol?.dispose();
    this.protocol = null;
    this.transport = null;

    this.updateSnapshot(
      {
        ...INITIAL_CONNECTION_SNAPSHOT,
      },
      "closed",
      error,
    );
  }

  private async teardownConnection(stopProcess: boolean): Promise<void> {
    this.deps.interactionBridge.clearPendingInteractions();

    if (this.protocol) {
      this.protocol.dispose();
      this.protocol = null;
    }

    if (this.transport) {
      await this.transport.disconnect();
      this.transport = null;
    }

    if (stopProcess) {
      this.deps.getProcessManager().stopManagedProcess();
    }
  }

  private updateSnapshot(
    next: ConnectionSnapshot,
    reason: Parameters<ConnectionStateListener>[1],
    error?: Error,
  ): void {
    this.snapshot = { ...next };
    this.notifyState(reason, error);
  }

  private notifyState(
    reason: Parameters<ConnectionStateListener>[1],
    error?: Error,
  ): void {
    this.deps.onConnectionStateChange?.({ ...this.snapshot }, reason, error);
  }
}
