import { toAppError } from "../../errorUtils";
import { StreamChunk } from "../../protocol";
import { AcpProtocol } from "../../acpProtocol";
import { SUBAGENT_CANCEL_RECOVERY_TIMEOUT_MS } from "../../constants/runtime";
import { InactivityGuard, InProgressTool } from "../inactivityGuard";
import { RunOptions } from "../types";

type SessionRecovery = { protocol: AcpProtocol; sessionId: string };

export interface ConnectWithRecoveryDeps {
  ensureConnected: (options: RunOptions) => Promise<void>;
  isMissingSessionError: (error: unknown) => boolean;
  recoverMissingSession: (options: RunOptions) => Promise<SessionRecovery>;
  log: (message: string) => void;
}

export async function connectWithRecovery(
  options: RunOptions,
  deps: ConnectWithRecoveryDeps,
): Promise<RunOptions> {
  try {
    await deps.ensureConnected(options);
    return options;
  } catch (connectError) {
    if (options.sessionId && deps.isMissingSessionError(connectError)) {
      deps.log(
        "ACP session missing during connect/load. Falling back to a fresh session.",
      );
      const recovered = await deps.recoverMissingSession(options);
      return { ...options, sessionId: recovered.sessionId };
    }
    throw connectError;
  }
}

export interface InactivitySignalState {
  resolveInactivitySignal: (() => void) | null;
  waitForInactivity: Promise<void>;
}

export function createInactivitySignalState(): InactivitySignalState {
  const state: InactivitySignalState = {
    resolveInactivitySignal: null,
    waitForInactivity: Promise.resolve(),
  };
  resetInactivitySignalState(state);
  return state;
}

export function resetInactivitySignalState(
  state: InactivitySignalState,
): void {
  state.waitForInactivity = new Promise<void>((resolve) => {
    state.resolveInactivitySignal = resolve;
  });
}

export interface InactivityRecoveryPrompt {
  toolDesc: string;
  timeoutMinutes: number;
  warningMessage: string;
  reminderPrompt: string;
}

export function buildInactivityRecoveryPrompt(
  stuckTool: InProgressTool,
  inactivityTimeoutMs: number,
): InactivityRecoveryPrompt {
  const toolDesc = stuckTool.title || stuckTool.name;
  const timeoutMinutes = Math.round(inactivityTimeoutMs / 60000);
  const warningMessage =
    `Sub-agent "${toolDesc}" appears stuck (no activity for ${timeoutMinutes} min). ` +
    "Notifying main agent...";
  const reminderPrompt =
    `<system-reminder>The sub-agent "${toolDesc}" (tool: ${stuckTool.name}) ` +
    `was inactive for over ${timeoutMinutes} minutes and has been automatically cancelled. ` +
    "It may not be available or may have encountered an internal error. " +
    "Please try a different approach or continue without this step.</system-reminder>";

  return {
    toolDesc,
    timeoutMinutes,
    warningMessage,
    reminderPrompt,
  };
}

export interface PromptExecutionContext {
  protocol: AcpProtocol;
  sessionId: string;
  builtPrompt: string;
  inactivityGuard: InactivityGuard;
  inactivityTimeoutMs: number;
  onChunk: (chunk: StreamChunk) => void;
  registerNotificationHandler: (targetProtocol: AcpProtocol) => void;
  inactivitySignalState: InactivitySignalState;
}

export interface PromptExecutionResult {
  promptResult: unknown;
  needsRecovery: boolean;
  protocol: AcpProtocol;
  sessionId: string;
}

export interface ExecutePromptWithRecoveryDeps {
  isMissingSessionError: (error: unknown) => boolean;
  recoverMissingSession: (options: RunOptions) => Promise<SessionRecovery>;
  resetChunkMapper: () => void;
  log: (message: string) => void;
}

export async function executePromptWithRecovery(
  context: PromptExecutionContext,
  options: RunOptions,
  deps: ExecutePromptWithRecoveryDeps,
): Promise<PromptExecutionResult> {
  let { protocol, sessionId } = context;
  const {
    builtPrompt,
    inactivityGuard,
    inactivityTimeoutMs,
    onChunk,
    registerNotificationHandler,
    inactivitySignalState,
  } = context;

  let promptResult: unknown;
  let needsRecovery = false;

  const runPromptWithInactivityRace = async (
    targetProtocol: AcpProtocol,
    targetSessionId: string,
    promptText: string,
  ): Promise<unknown> => {
    const outcome = await requestPromptWithInactivityRace(
      targetProtocol,
      targetSessionId,
      promptText,
      inactivitySignalState.waitForInactivity,
    );

    if (outcome.kind === "inactivity") {
      needsRecovery = true;
      resetInactivitySignalState(inactivitySignalState);
      return {};
    }

    if (outcome.kind === "error") {
      throw outcome.error;
    }

    return outcome.result;
  };

  try {
    promptResult = await runPromptWithInactivityRace(protocol, sessionId, builtPrompt);
  } catch (promptError) {
    if (deps.isMissingSessionError(promptError)) {
      deps.log(
        "ACP session missing during prompt. Recreating session and retrying once.",
      );
      const recovered = await deps.recoverMissingSession(options);
      protocol = recovered.protocol;
      sessionId = recovered.sessionId;
      registerNotificationHandler(protocol);
      promptResult = await runPromptWithInactivityRace(
        protocol,
        sessionId,
        builtPrompt,
      );
    } else if (inactivityGuard.didTrigger) {
      needsRecovery = true;
    } else {
      throw promptError;
    }
  } finally {
    inactivityGuard.stop();
  }

  if (needsRecovery && inactivityGuard.lastTool) {
    promptResult = await handleInactivityRecovery(
      {
        protocol,
        sessionId,
        inactivityGuard,
        inactivityTimeoutMs,
        onChunk,
        registerNotificationHandler,
      },
      deps,
    );
  }

  return { promptResult, needsRecovery, protocol, sessionId };
}

interface InactivityRecoveryContext {
  protocol: AcpProtocol;
  sessionId: string;
  inactivityGuard: InactivityGuard;
  inactivityTimeoutMs: number;
  onChunk: (chunk: StreamChunk) => void;
  registerNotificationHandler: (targetProtocol: AcpProtocol) => void;
}

async function handleInactivityRecovery(
  context: InactivityRecoveryContext,
  deps: ExecutePromptWithRecoveryDeps,
): Promise<unknown> {
  const {
    protocol,
    sessionId,
    inactivityGuard,
    inactivityTimeoutMs,
    onChunk,
    registerNotificationHandler,
  } = context;
  const stuckTool = inactivityGuard.lastTool!;
  const prompt = buildInactivityRecoveryPrompt(stuckTool, inactivityTimeoutMs);

  onChunk({
    chunkType: "warning",
    message: prompt.warningMessage,
  });

  deps.resetChunkMapper();
  registerNotificationHandler(protocol);

  try {
    return await requestPromptWithTimeout(
      protocol,
      sessionId,
      prompt.reminderPrompt,
      SUBAGENT_CANCEL_RECOVERY_TIMEOUT_MS,
    );
  } catch (recoveryError) {
    const recoveryMessage = toAppError(
      recoveryError,
      "Failed to request post-cancel recovery response",
    ).message;
    deps.log(`[ACP] ${recoveryMessage}`);
    onChunk({
      chunkType: "warning",
      message: `Sub-agent was cancelled, but recovery prompt failed: ${recoveryMessage}`,
    });
    return undefined;
  }
}

export async function requestPromptWithTimeout(
  protocol: AcpProtocol,
  sessionId: string,
  promptText: string,
  timeoutMs: number,
): Promise<unknown> {
  const requestPromise = protocol.sendRequest("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: promptText }],
  });

  if (timeoutMs <= 0) {
    return requestPromise;
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`session/prompt timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([requestPromise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export async function requestPromptWithInactivityRace(
  protocol: AcpProtocol,
  sessionId: string,
  promptText: string,
  waitForInactivity: Promise<void>,
): Promise<
  | { kind: "result"; result: unknown }
  | { kind: "error"; error: unknown }
  | { kind: "inactivity" }
> {
  const requestPromise = protocol.sendRequest("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: promptText }],
  });
  let settled = false;

  const promptOutcome = requestPromise.then(
    (result) => {
      settled = true;
      return { kind: "result", result } as const;
    },
    (error) => {
      settled = true;
      return { kind: "error", error } as const;
    },
  );

  const raced = await Promise.race([
    promptOutcome,
    waitForInactivity.then(() => ({ kind: "inactivity" as const })),
  ]);

  if (!settled && raced.kind === "inactivity") {
    requestPromise.catch(() => {});
  }

  return raced;
}
