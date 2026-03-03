import { normalizeErrorMessage } from "../errorUtils";
import type { RunOptions } from "./types";

export type ErrorLayerTag =
  | "TRANSPORT_ERROR"
  | "AUTH_ERROR"
  | "PROTOCOL_ERROR";

export const DEFAULT_AUTH_RECOVERY_ACTION =
  "Next step: run `iflow login` and retry.";

const DEFAULT_AUTH_FALLBACK_METHODS = [
  "oauth-iflow",
  "iflow",
  "openai-compatible",
] as const;

export interface ResolveAuthMethodOrderInput {
  availableMethodIds: string[];
  preferredMethodIds?: string[];
  fallbackMethodIds?: string[];
}

export interface RecoverReusableSessionInput {
  options: RunOptions;
  currentSessionId: string;
  currentMode: RunOptions["mode"] | null;
  sendRequest: (method: string, params?: unknown) => Promise<unknown>;
  buildSessionSettings: (options: RunOptions) => Record<string, unknown>;
  cwd?: string;
  mcpServers?: readonly unknown[];
}

export interface RecoverReusableSessionResult {
  sessionId: string;
  sessionSettings: Record<string, unknown>;
  action: "create_new" | "load_requested" | "reload_current" | "reuse_existing";
}

export function extractAuthMethodIds(
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

export function resolveAuthMethodOrder(
  input: ResolveAuthMethodOrderInput,
): string[] {
  const availableMethodIds = input.availableMethodIds;
  const preferredMethodIds = input.preferredMethodIds ?? [];
  const fallbackMethodIds = input.fallbackMethodIds ?? [
    ...DEFAULT_AUTH_FALLBACK_METHODS,
  ];
  const requested = [
    ...preferredMethodIds,
    ...fallbackMethodIds,
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

export function hasKnownLayerTag(message: string): boolean {
  return /\[(TRANSPORT_ERROR|AUTH_ERROR|PROTOCOL_ERROR)\]/.test(message);
}

export function toLayerTaggedError(
  error: unknown,
  layer: ErrorLayerTag,
  authRecoveryAction = DEFAULT_AUTH_RECOVERY_ACTION,
): Error {
  const normalized = normalizeErrorMessage(error);
  const prefixed = hasKnownLayerTag(normalized)
    ? normalized
    : `[${layer}] ${normalized}`;
  const message =
    layer === "AUTH_ERROR" && !/iflow login/i.test(prefixed)
      ? `${prefixed} ${authRecoveryAction}`
      : prefixed;

  if (error instanceof Error && error.message === message) {
    return error;
  }

  if (error instanceof Error) {
    return new Error(message, { cause: error });
  }

  return new Error(message);
}

export function ensureLayerTag(
  error: unknown,
  fallbackLayer: ErrorLayerTag,
  authRecoveryAction = DEFAULT_AUTH_RECOVERY_ACTION,
): Error {
  const message = normalizeErrorMessage(error);
  if (hasKnownLayerTag(message)) {
    return error instanceof Error ? error : new Error(message);
  }
  return toLayerTaggedError(error, fallbackLayer, authRecoveryAction);
}

export function determineReusableSessionAction(input: {
  options: RunOptions;
  currentSessionId: string;
  currentMode: RunOptions["mode"] | null;
}): RecoverReusableSessionResult["action"] {
  if (!input.options.sessionId) {
    return "create_new";
  }

  if (input.options.sessionId !== input.currentSessionId) {
    return "load_requested";
  }

  const modeChanged =
    input.currentMode !== null && input.currentMode !== input.options.mode;

  return modeChanged ? "reload_current" : "reuse_existing";
}

export async function recoverReusableSession(
  input: RecoverReusableSessionInput,
): Promise<RecoverReusableSessionResult> {
  const cwd = input.cwd ?? input.options.cwd ?? process.cwd();
  const mcpServers = input.mcpServers ?? [];
  const sessionSettings = input.buildSessionSettings(input.options);
  const action = determineReusableSessionAction({
    options: input.options,
    currentSessionId: input.currentSessionId,
    currentMode: input.currentMode,
  });

  if (action === "create_new") {
    const sessionResult = (await input.sendRequest("session/new", {
      cwd,
      mcpServers,
      settings: sessionSettings,
    })) as { sessionId?: string };

    if (!sessionResult.sessionId) {
      throw new Error("session/new did not return sessionId");
    }

    return {
      sessionId: sessionResult.sessionId,
      sessionSettings,
      action,
    };
  }

  if (action === "load_requested" || action === "reload_current") {
    const sessionId =
      action === "load_requested"
        ? input.options.sessionId!
        : input.currentSessionId;

    await input.sendRequest("session/load", {
      sessionId,
      cwd,
      mcpServers,
      settings: sessionSettings,
    });

    return {
      sessionId,
      sessionSettings,
      action,
    };
  }

  return {
    sessionId: input.currentSessionId,
    sessionSettings,
    action,
  };
}
