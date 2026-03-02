import { AcpClient } from "../acpClient";
import { toAppError } from "../errorUtils";
import { ConversationStore } from "../store";
import {
  AttachedFile,
  Conversation,
  ExtensionMessage,
  IDEContext,
  MODELS,
  StreamChunk,
  StreamStatusPhase,
} from "../protocol";
import { PlanApprovalCoordinator } from "./planApprovalCoordinator";
import {
  DEFAULT_STREAM_RENDER_INTERVAL_MS,
  MIN_STREAM_RENDER_INTERVAL_MS,
  WAITING_FIRST_CHUNK_STATUS_DELAY_MS,
} from "../constants/runtime";

const PLAN_EXECUTION_REMINDER =
  "<system-reminder>\nPlan mode has been deactivated. The user approved the plan. You are now in execution mode. You may now freely use all tools including write_file, edit_file, run_shell_command, and other modification tools. Please proceed with the implementation.\n</system-reminder>";
const CLI_RECHECK_HINT = "未连接到 iFlow CLI，请 Re-check CLI。";
const WORKSPACE_FILE_CACHE_TTL_MS = 5000;

interface QueuedMessage {
  content: string;
  attachedFiles: AttachedFile[];
  silent: boolean;
  ideContext?: IDEContext;
}

interface RunLifecycleContext {
  conversationId: string;
  assistantMessageId: string;
  cwd?: string;
  allowedDirs: string[];
}

interface RunFinalizeContext extends RunLifecycleContext {
  succeeded: boolean;
}

interface SendMessagePipelineDependencies {
  store: ConversationStore;
  client: AcpClient;
  postMessage: (message: ExtensionMessage) => void;
  markCliUnavailable: (diagnostics: string) => void;
  clearSessionId?: () => void;
  resolveWorkspaceFolder: (conversation: Conversation) => string | undefined;
  getAllWorkspaceFolderPaths: () => string[];
  getWorkspaceFileList: (cwd?: string, limit?: number) => Promise<string[]>;
  shouldIncludeWorkspaceFiles: () => boolean;
  getWorkspaceFilesLimit: () => number;
  getStreamRenderIntervalMs: () => number;
  planApprovalCoordinator: PlanApprovalCoordinator;
  debug: (message: string) => void;
  setSessionId: (sessionId: string) => void;
  onRunStart?: (context: RunLifecycleContext) => void;
  onChunk?: (chunk: StreamChunk, context: RunLifecycleContext) => void;
  onRunFinalize?: (context: RunFinalizeContext) => void;
  now?: () => number;
}

type PreflightStageCode = "INVALID_FILES" | "INVALID_CONTEXT" | "INVALID_MODEL";

interface PreflightValidationFailure {
  stage: PreflightStageCode;
  summary: string;
  action: string;
  reason: string;
}

export class SendMessagePipeline {
  private readonly now: () => number;
  private workspaceFileCache: {
    cwd: string | undefined;
    limit: number;
    files: string[];
    expiresAt: number;
  } | null = null;

  constructor(private readonly deps: SendMessagePipelineDependencies) {
    this.now = deps.now ?? (() => Date.now());
  }

  async execute(input: QueuedMessage): Promise<void> {
    const queue: QueuedMessage[] = [input];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }

      const followups = await this.executeSingle(current);
      queue.push(...followups);
    }
  }

  private async executeSingle(input: QueuedMessage): Promise<QueuedMessage[]> {
    const sendStartedAt = this.now();
    let runStartedAt = sendStartedAt;
    let firstChunkAt: number | null = null;
    let workspaceScanMs: number | null = null;

    this.deps.debug(
      `Send pipeline start: silent=${input.silent}, contentLength=${input.content.length}, attachedFiles=${input.attachedFiles.length}, hasIdeContext=${Boolean(input.ideContext)}`,
    );
    this.emitStreamStatus(sendStartedAt, "preparing");

    let assistantMessageId = "";
    this.deps.store.batchUpdate(() => {
      if (!input.silent) {
        this.deps.store.addUserMessage(input.content, input.attachedFiles);
      }
      const assistantMessage = this.deps.store.startAssistantMessage();
      assistantMessageId = assistantMessage.id;
      this.deps.store.setStreaming(true);
    });

    const conversation = this.deps.store.getCurrentConversation();
    if (!conversation) {
      this.deps.debug("No active conversation found; dropping send request");
      return [];
    }

    const cwd = this.deps.resolveWorkspaceFolder(conversation);
    if (cwd && !conversation.workspaceFolderUri) {
      this.deps.store.setConversationWorkspaceFolder(cwd);
    }

    const fileAllowedDirs = this.deps.getAllWorkspaceFolderPaths();
    const autoIncludeWorkspaceFiles = this.deps.shouldIncludeWorkspaceFiles();
    const workspaceFilesLimit = Math.max(1, this.deps.getWorkspaceFilesLimit());
    let workspaceFiles: string[] = [];

    if (autoIncludeWorkspaceFiles) {
      const workspaceScanStartedAt = this.now();
      workspaceFiles = await this.getCachedWorkspaceFileList(
        cwd,
        workspaceFilesLimit,
      );
      workspaceScanMs = this.now() - workspaceScanStartedAt;
    }

    this.deps.debug(
      `Prepared run context: mode=${conversation.mode}, model=${conversation.model}, cwd=${cwd ?? "n/a"}, workspaceFiles=${workspaceFiles.length}, autoIncludeWorkspaceFiles=${autoIncludeWorkspaceFiles}, workspaceFilesLimit=${workspaceFilesLimit}, allowedDirs=${fileAllowedDirs.length}`,
    );
    const runContext: RunLifecycleContext = {
      conversationId: conversation.id,
      assistantMessageId,
      cwd,
      allowedDirs: fileAllowedDirs,
    };
    this.deps.onRunStart?.(runContext);

    let runSucceeded = false;
    let runCompleted = false;
    let runFinalizeCalled = false;
    let firstChunkSeen = false;
    const streamRenderIntervalMs = this.resolveStreamRenderIntervalMs();
    let statePublishTimer: ReturnType<typeof setTimeout> | null = null;
    let hasPendingStatePublish = false;

    const clearStatePublishTimer = (): void => {
      if (!statePublishTimer) {
        return;
      }
      clearTimeout(statePublishTimer);
      statePublishTimer = null;
    };

    const flushPendingStatePublish = (): void => {
      clearStatePublishTimer();
      if (!hasPendingStatePublish) {
        return;
      }
      hasPendingStatePublish = false;
      this.deps.store.publishState();
    };

    const scheduleStatePublish = (): void => {
      hasPendingStatePublish = true;
      if (statePublishTimer) {
        return;
      }
      statePublishTimer = setTimeout(() => {
        statePublishTimer = null;
        if (!hasPendingStatePublish) {
          return;
        }
        hasPendingStatePublish = false;
        this.deps.store.publishState();
      }, streamRenderIntervalMs);
    };

    this.deps.planApprovalCoordinator.startRun();
    runStartedAt = this.now();
    this.emitStreamStatus(sendStartedAt, "connecting");

    const finalizeRunHook = (succeeded: boolean): void => {
      if (runFinalizeCalled) {
        return;
      }
      runFinalizeCalled = true;
      try {
        this.deps.onRunFinalize?.({
          ...runContext,
          succeeded,
        });
      } catch (error) {
        const messageText = toAppError(
          error,
          "Run finalize hook failed",
        ).message;
        this.deps.debug(messageText);
      }
    };

    const preflightFailure = this.validatePreflightInput(input, conversation.model);
    if (preflightFailure) {
      const userError = this.formatPreflightError(preflightFailure);
      this.deps.debug(
        `[preflight] stage=${preflightFailure.stage} reason=${preflightFailure.reason} runSuppressed=true`,
      );
      this.logPerf(sendStartedAt, runStartedAt, firstChunkAt, workspaceScanMs);
      this.deps.store.batchUpdate(() => {
        this.deps.store.appendToAssistantMessage(
          { chunkType: "error", message: userError },
          { notify: false },
        );
        this.deps.store.endAssistantMessage();
        this.deps.store.setStreaming(false);
      });
      finalizeRunHook(false);
      this.deps.postMessage({
        type: "streamError",
        error: userError,
      });
      return [];
    }

    const waitingStatusTimer = setTimeout(() => {
      if (!firstChunkSeen && !runCompleted) {
        this.emitStreamStatus(sendStartedAt, "waiting_first_chunk");
      }
    }, WAITING_FIRST_CHUNK_STATUS_DELAY_MS);

    try {
      const returnedSessionId = await this.deps.client.run(
        {
          prompt: input.content,
          attachedFiles: input.attachedFiles,
          mode: conversation.mode,
          think: conversation.think,
          model: conversation.model,
          workspaceFiles,
          sessionId: conversation.sessionId,
          ideContext: input.ideContext,
          cwd,
          fileAllowedDirs,
        },
        (chunk) => {
          if (!firstChunkSeen) {
            firstChunkSeen = true;
            firstChunkAt = this.now();
          }
          this.deps.onChunk?.(chunk, runContext);
          this.deps.planApprovalCoordinator.onChunk(chunk);
          this.deps.store.appendToAssistantMessage(chunk, { notify: false });
          this.deps.postMessage({ type: "streamChunk", chunk });
          scheduleStatePublish();
        },
        () => {
          runCompleted = true;
          runSucceeded = true;
          flushPendingStatePublish();
          this.logPerf(
            sendStartedAt,
            runStartedAt,
            firstChunkAt,
            workspaceScanMs,
          );
          this.deps.debug("Run completed successfully");
          this.deps.store.batchUpdate(() => {
            this.deps.store.endAssistantMessage();
            this.deps.store.setStreaming(false);
          });
          finalizeRunHook(true);
          this.deps.postMessage({ type: "streamEnd" });
        },
        (error) => {
          runCompleted = true;
          flushPendingStatePublish();
          const appError = toAppError(error);
          let normalizedError = appError.message;
          this.deps.debug(`Run failed: ${normalizedError}`);
          if (appError.code === "MISSING_SESSION") {
            this.deps.debug(
              "Detected missing ACP session; clearing persisted conversation session id",
            );
            this.deps.clearSessionId?.();
          } else if (appError.code === "CLI_UNAVAILABLE") {
            this.deps.markCliUnavailable(normalizedError);
            normalizedError = this.appendCliReconnectHint(normalizedError);
          }
          this.logPerf(
            sendStartedAt,
            runStartedAt,
            firstChunkAt,
            workspaceScanMs,
          );

          this.deps.store.batchUpdate(() => {
            this.deps.store.appendToAssistantMessage(
              { chunkType: "error", message: normalizedError },
              { notify: false },
            );
            this.deps.store.endAssistantMessage();
            this.deps.store.setStreaming(false);
          });
          finalizeRunHook(false);
          this.deps.postMessage({
            type: "streamError",
            error: normalizedError,
          });
        },
      );

      if (returnedSessionId) {
        this.deps.debug(
          `Persisting ACP sessionId on conversation: ${returnedSessionId}`,
        );
        this.deps.setSessionId(returnedSessionId);
      }
    } finally {
      clearTimeout(waitingStatusTimer);
      clearStatePublishTimer();
    }
    if (!runFinalizeCalled) {
      finalizeRunHook(runSucceeded);
    }

    if (!runSucceeded) {
      this.deps.planApprovalCoordinator.cancelWait();
      return [];
    }

    const followup = await this.deps.planApprovalCoordinator.resolveAfterRun(
      conversation.mode,
      () => {
        this.deps.postMessage({
          type: "streamChunk",
          chunk: {
            chunkType: "plan_approval",
            requestId: -1,
            plan: "",
          },
        });
      },
    );

    switch (followup.kind) {
      case "execute":
        this.deps.debug(
          `Plan approved by user; switching to execution mode=${followup.mode}`,
        );
        this.deps.store.setMode(followup.mode);
        this.deps.planApprovalCoordinator.markReplaying();
        return [
          {
            content: PLAN_EXECUTION_REMINDER,
            attachedFiles: [],
            silent: true,
          },
        ];

      case "feedback":
        this.deps.debug(
          "Plan feedback provided by user; re-running in plan mode",
        );
        return [
          {
            content: followup.feedback,
            attachedFiles: [],
            silent: false,
          },
        ];

      case "none":
      default:
        return [];
    }
  }

  private emitStreamStatus(startedAt: number, phase: StreamStatusPhase): void {
    this.deps.postMessage({
      type: "streamStatus",
      phase,
      elapsedMs: Math.max(0, this.now() - startedAt),
    });
  }

  private appendCliReconnectHint(error: string): string {
    if (
      error.includes("Re-check CLI") ||
      error.includes("未连接到 iFlow CLI")
    ) {
      return error;
    }
    return `${error}\n${CLI_RECHECK_HINT}`;
  }

  private logPerf(
    sendStartedAt: number,
    runStartedAt: number,
    firstChunkAt: number | null,
    workspaceScanMs: number | null,
  ): void {
    const preflightMs = Math.max(0, runStartedAt - sendStartedAt);
    const totalMs = Math.max(0, this.now() - sendStartedAt);
    const ttft =
      firstChunkAt === null
        ? "n/a"
        : `${Math.max(0, firstChunkAt - sendStartedAt)}ms`;
    const workspaceScan =
      workspaceScanMs === null ? "n/a" : `${Math.max(0, workspaceScanMs)}ms`;
    this.deps.debug(
      `[perf] ttft=${ttft} preflight=${preflightMs}ms total=${totalMs}ms workspaceScan=${workspaceScan}`,
    );
  }

  private validatePreflightInput(
    input: QueuedMessage,
    model: string,
  ): PreflightValidationFailure | null {
    return (
      this.validateAttachedFiles(input.attachedFiles) ??
      this.validateIdeContext(input.ideContext) ??
      this.validateModel(model)
    );
  }

  private validateAttachedFiles(
    files: AttachedFile[],
  ): PreflightValidationFailure | null {
    for (const [index, file] of files.entries()) {
      const path =
        typeof file?.path === "string" ? file.path.trim() : undefined;
      if (!path) {
        return {
          stage: "INVALID_FILES",
          summary: "One or more attached files are invalid.",
          action: "Reattach valid files and send again.",
          reason: `attachedFiles[${index}].path is missing`,
        };
      }
    }
    return null;
  }

  private validateIdeContext(
    ideContext: IDEContext | undefined,
  ): PreflightValidationFailure | null {
    if (!ideContext) {
      return null;
    }

    const activeFile = ideContext.activeFile;
    if (
      activeFile &&
      (!activeFile.path.trim() || !activeFile.name.trim())
    ) {
      return {
        stage: "INVALID_CONTEXT",
        summary: "IDE context is incomplete.",
        action: "Clear IDE context and retry.",
        reason: "activeFile path/name is empty",
      };
    }

    const selection = ideContext.selection;
    if (!selection) {
      return null;
    }

    const hasTextFields =
      selection.filePath.trim().length > 0 &&
      selection.fileName.trim().length > 0 &&
      selection.text.trim().length > 0;
    const hasLineRange =
      Number.isInteger(selection.lineStart) &&
      Number.isInteger(selection.lineEnd) &&
      selection.lineStart >= 1 &&
      selection.lineEnd >= selection.lineStart;

    if (!hasTextFields || !hasLineRange) {
      return {
        stage: "INVALID_CONTEXT",
        summary: "IDE context is incomplete.",
        action: "Clear IDE context and retry.",
        reason: "selection fields are invalid",
      };
    }

    return null;
  }

  private validateModel(model: string): PreflightValidationFailure | null {
    if (MODELS.includes(model as (typeof MODELS)[number])) {
      return null;
    }

    return {
      stage: "INVALID_MODEL",
      summary: "Selected model is not supported.",
      action: "Choose a supported model and retry.",
      reason: `model '${model}' is not in protocol.MODELS`,
    };
  }

  private formatPreflightError(error: PreflightValidationFailure): string {
    return `[${error.stage}] ${error.summary}\nAction: ${error.action}`;
  }

  private resolveStreamRenderIntervalMs(): number {
    const configured = this.deps.getStreamRenderIntervalMs();
    if (!Number.isFinite(configured)) {
      return DEFAULT_STREAM_RENDER_INTERVAL_MS;
    }
    return Math.max(MIN_STREAM_RENDER_INTERVAL_MS, Math.round(configured));
  }

  private async getCachedWorkspaceFileList(
    cwd: string | undefined,
    limit: number,
  ): Promise<string[]> {
    const cached = this.workspaceFileCache;
    if (
      cached &&
      cached.cwd === cwd &&
      cached.limit === limit &&
      this.now() < cached.expiresAt
    ) {
      this.deps.debug("Workspace file list served from cache");
      return cached.files;
    }

    const files = await this.deps.getWorkspaceFileList(cwd, limit);
    this.workspaceFileCache = {
      cwd,
      limit,
      files,
      expiresAt: this.now() + WORKSPACE_FILE_CACHE_TTL_MS,
    };
    return files;
  }
}
