import { ChunkMapper } from "../../chunkMapper";
import { toAppError } from "../../errorUtils";
import { StreamChunk } from "../../protocol";
import { InactivityGuard } from "../inactivityGuard";
import { PathPolicy } from "../pathPolicy";
import { SessionCoordinator } from "../sessionCoordinator";
import { RunOptions } from "../types";
import { AcpProtocol } from "../../acpProtocol";
import { AcpNotificationRouter } from "./acpNotificationRouter";
import { AcpUsageExtractor } from "./acpUsageExtractor";
import {
  connectWithRecovery,
  createInactivitySignalState,
  executePromptWithRecovery,
} from "./acpRunRecovery";
import { isObject } from "../../shared/typeGuards";
import {
  DEFAULT_SUBAGENT_INACTIVITY_TIMEOUT_MS,
  SUBAGENT_CANCEL_RECOVERY_TIMEOUT_MS,
} from "../../constants/runtime";

interface RunExecutorDeps {
  chunkMapper: ChunkMapper;
  pathPolicy: PathPolicy;
  sessionCoordinator: SessionCoordinator;
  notificationRouter: AcpNotificationRouter;
  usageExtractor: AcpUsageExtractor;
  getConfig: <T>(key: string, defaultValue: T) => T;
  log: (message: string) => void;
  updateIFlowCliModel: (model: RunOptions["model"]) => void;
  updateIFlowCliApiConfig: (baseUrl: string | undefined) => void;
  isRunning: () => boolean;
  setRunning: (running: boolean) => void;
  setActiveChunkSink: (sink: ((chunk: StreamChunk) => void) | null) => void;
  cancel: () => Promise<void>;
  isMissingSessionError: (error: unknown) => boolean;
  recoverMissingSession: (
    options: RunOptions,
  ) => Promise<{ protocol: AcpProtocol; sessionId: string }>;
  createInactivityGuard?: (
    timeoutMs: number,
    onTimeout: () => void,
    log: (message: string) => void,
  ) => InactivityGuard;
}

interface RunCallbacks {
  onChunk: (chunk: StreamChunk) => void;
  onEnd: () => void;
  onError: (error: string) => void;
}

export class AcpRunExecutor {
  constructor(private readonly deps: RunExecutorDeps) {}

  async run(
    options: RunOptions,
    callbacks: RunCallbacks,
  ): Promise<string | undefined> {
    const { onChunk, onEnd, onError } = callbacks;

    try {
      this.deps.setRunning(true);
      this.deps.setActiveChunkSink(onChunk);
      this.deps.chunkMapper.reset();

      this.deps.updateIFlowCliModel(options.model);
      this.deps.updateIFlowCliApiConfig(undefined);

      this.setupPathPolicy(options);

      const resolvedOptions = await connectWithRecovery(options, {
        ensureConnected: async (connectOptions) =>
          this.deps.sessionCoordinator.ensureConnected(connectOptions),
        isMissingSessionError: (error) => this.deps.isMissingSessionError(error),
        recoverMissingSession: async (recoverOptions) =>
          this.deps.recoverMissingSession(recoverOptions),
        log: (message) => this.deps.log(message),
      });

      let protocol = this.deps.sessionCoordinator.currentProtocol;
      let sessionId = this.deps.sessionCoordinator.currentSessionId;
      if (!protocol || !sessionId) {
        throw new Error("No active ACP protocol/session");
      }
      let mappedSessionUpdateChunkCount = 0;

      const debugLogging = this.deps.getConfig<boolean>("debugLogging", false);
      const inactivityTimeoutMs = this.deps.getConfig<number>(
        "subagentInactivityTimeoutMs",
        DEFAULT_SUBAGENT_INACTIVITY_TIMEOUT_MS,
      );
      const inactivitySignalState = createInactivitySignalState();
      const createInactivityGuard =
        this.deps.createInactivityGuard ??
        ((timeoutMs, onTimeout, log) =>
          new InactivityGuard(timeoutMs, onTimeout, log));
      const inactivityGuard = createInactivityGuard(
        inactivityTimeoutMs,
        () => {
          if (inactivitySignalState.resolveInactivitySignal) {
            inactivitySignalState.resolveInactivitySignal();
            inactivitySignalState.resolveInactivitySignal = null;
          }
          Promise.race([
            this.deps.cancel(),
            new Promise<void>((resolve) =>
              setTimeout(resolve, SUBAGENT_CANCEL_RECOVERY_TIMEOUT_MS),
            ),
          ]).catch(() => {});
        },
        (msg) => this.deps.log(msg),
      );

      const registerNotificationHandler = (
        targetProtocol: AcpProtocol,
      ): void => {
        this.deps.notificationRouter.registerSessionUpdateHandler(
          targetProtocol,
          (chunk) => {
            mappedSessionUpdateChunkCount += 1;
            onChunk(chunk);
          },
          inactivityGuard,
          debugLogging,
        );
      };

      registerNotificationHandler(protocol);
      inactivityGuard.start(() => this.deps.isRunning());

      const builtPrompt = this.deps.chunkMapper.buildPrompt({
        prompt: resolvedOptions.prompt,
        attachedFiles: resolvedOptions.attachedFiles,
        workspaceFiles: resolvedOptions.workspaceFiles,
        ideContext: resolvedOptions.ideContext,
        cwd: resolvedOptions.cwd,
      });
      this.deps.log(
        `[ACP] Sending session/prompt: sessionId=${sessionId}, promptLength=${builtPrompt.length}, preview=${this.buildPromptPreview(builtPrompt)}`,
      );

      const execResult = await executePromptWithRecovery(
        {
          protocol,
          sessionId,
          builtPrompt,
          inactivityGuard,
          inactivityTimeoutMs,
          onChunk,
          registerNotificationHandler,
          inactivitySignalState,
        },
        resolvedOptions,
        {
          isMissingSessionError: (error) =>
            this.deps.isMissingSessionError(error),
          recoverMissingSession: async (recoverOptions) =>
            this.deps.recoverMissingSession(recoverOptions),
          resetChunkMapper: () => this.deps.chunkMapper.reset(),
          log: (message) => this.deps.log(message),
        },
      );

      this.emitFinalChunks(
        execResult.promptResult,
        mappedSessionUpdateChunkCount,
        onChunk,
      );

      onEnd();
      return this.deps.sessionCoordinator.currentSessionId ?? undefined;
    } catch (err: unknown) {
      const appError = toAppError(err, "Unknown ACP error");
      onError(appError.message);
      return undefined;
    } finally {
      this.deps.setRunning(false);
      this.deps.setActiveChunkSink(null);
    }
  }

  async cancel(): Promise<void> {
    await this.deps.cancel();
  }

  private setupPathPolicy(options: RunOptions): void {
    const cwd = options.cwd ?? process.cwd();
    const allowedDirs =
      options.fileAllowedDirs && options.fileAllowedDirs.length > 0
        ? options.fileAllowedDirs
        : [cwd];
    this.deps.pathPolicy.setBaseDir(cwd);
    this.deps.pathPolicy.setAllowedDirs(allowedDirs);
  }

  private emitFinalChunks(
    promptResult: unknown,
    mappedSessionUpdateChunkCount: number,
    onChunk: (chunk: StreamChunk) => void,
  ): void {
    const promptUsage =
      this.deps.usageExtractor.extractUsageChunk(promptResult);
    if (promptUsage) {
      onChunk(promptUsage);
    } else {
      const keys = isObject(promptResult)
        ? Object.keys(promptResult).join(",")
        : typeof promptResult;
      this.deps.log(
        `[ACP] No usage data found in session/prompt result (keys: ${keys})`,
      );
    }
    if (mappedSessionUpdateChunkCount === 0) {
      const fallbackChunks = this.extractPromptResultChunks(promptResult);
      if (fallbackChunks.length > 0) {
        this.deps.log(
          `[ACP] No session/update chunks received; rendering ${fallbackChunks.length} fallback chunk(s) from session/prompt result`,
        );
        for (const fallbackChunk of fallbackChunks) {
          onChunk(fallbackChunk);
        }
      } else {
        this.deps.log(
          "[ACP] No session/update chunks received and session/prompt result contained no renderable text",
        );
      }
    }

    for (const tailChunk of this.deps.chunkMapper.flushToChunks()) {
      onChunk(tailChunk);
    }
  }


  private extractPromptResultChunks(promptResult: unknown): StreamChunk[] {
    const chunks: StreamChunk[] = [];

    for (const update of this.extractSessionUpdatesFromPromptResult(
      promptResult,
    )) {
      chunks.push(...this.deps.chunkMapper.mapUpdateToChunks(update));
    }
    if (chunks.length > 0) {
      return chunks;
    }

    const fallbackText = this.extractPromptResultText(promptResult);
    if (!fallbackText) {
      return [];
    }
    return [{ chunkType: "text", content: fallbackText }];
  }

  private extractSessionUpdatesFromPromptResult(
    payload: unknown,
  ): Record<string, unknown>[] {
    if (!isObject(payload)) {
      return [];
    }

    const updates: Record<string, unknown>[] = [];
    const addCandidate = (candidate: unknown): void => {
      if (!isObject(candidate)) {
        return;
      }
      if (typeof candidate.sessionUpdate === "string") {
        updates.push(candidate);
      }
    };

    addCandidate(payload);
    addCandidate(payload.update);
    addCandidate(payload.result);

    if (Array.isArray(payload.updates)) {
      for (const item of payload.updates) {
        if (isObject(item)) {
          addCandidate(item.update);
        }
        addCandidate(item);
      }
    }

    return updates;
  }

  private extractPromptResultText(payload: unknown): string | null {
    if (typeof payload === "string") {
      return payload.trim().length > 0 ? payload : null;
    }
    if (!isObject(payload)) {
      return null;
    }

    const searchOrder: unknown[] = [
      payload.output_text,
      payload.output,
      payload.outputs,
      payload.response,
      payload.responses,
      payload.message,
      payload.messages,
      payload.content,
      payload.candidate,
      payload.candidates,
      payload.result,
    ];

    for (const candidate of searchOrder) {
      const text = this.extractTextFromCandidate(candidate);
      if (text) {
        return text;
      }
    }

    return null;
  }

  private extractTextFromCandidate(candidate: unknown): string | null {
    if (typeof candidate === "string") {
      return candidate.trim().length > 0 ? candidate : null;
    }

    if (Array.isArray(candidate)) {
      const parts = candidate
        .map((item) => this.extractTextFromCandidate(item))
        .filter((part): part is string =>
          Boolean(part && part.trim().length > 0),
        );
      if (parts.length === 0) {
        return null;
      }
      return parts.join("\n");
    }

    if (!isObject(candidate)) {
      return null;
    }

    if (typeof candidate.role === "string") {
      const role = candidate.role.toLowerCase();
      if (role !== "assistant" && role !== "model") {
        return null;
      }
    }

    if (
      typeof candidate.text === "string" &&
      candidate.text.trim().length > 0
    ) {
      return candidate.text;
    }

    const nested = [
      candidate.content,
      candidate.parts,
      candidate.output,
      candidate.outputs,
      candidate.message,
      candidate.messages,
      candidate.response,
      candidate.responses,
      candidate.candidate,
      candidate.candidates,
    ];

    for (const value of nested) {
      const text = this.extractTextFromCandidate(value);
      if (text) {
        return text;
      }
    }

    return null;
  }

  private buildPromptPreview(prompt: string): string {
    const condensed = prompt.replace(/\s+/g, " ").trim();
    if (condensed.length === 0) {
      return "(empty)";
    }
    if (condensed.length <= 160) {
      return condensed;
    }
    return `${condensed.slice(0, 157)}...`;
  }
}
