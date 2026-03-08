import { signal, computed } from "@preact/signals";
import type {
  AttachedFile,
  Conversation,
  ConversationState,
  IDEContext,
  RoundFileChangeSummary,
} from "../../src/protocol";
import type { StreamStatusSnapshot } from "../../src/streamStatusUtils";
import type {
  PendingConfirmation,
  PendingPlanApproval,
  PendingQuestion,
} from "../panels/panelTypes";

export type IDEContextDismissed = { activeFile: boolean; selection: boolean };

// ── Core signals ──────────────────────────────────────────────────────

export const conversationState = signal<ConversationState | null>(null);
export const pendingConfirmation = signal<PendingConfirmation | null>(null);
export const pendingQuestion = signal<PendingQuestion | null>(null);
export const pendingPlanApproval = signal<PendingPlanApproval | null>(null);
export const streamStatus = signal<StreamStatusSnapshot | null>(null);

// ── File attachment signals ──────────────────────────────────────────

export const attachedFiles = signal<AttachedFile[]>([]);
export const mentionFiles = signal<Array<{ path: string; name: string }>>([]);

// ── UI signals ────────────────────────────────────────────────────────

export const showConversationPanel = signal(false);
export const conversationSearch = signal("");
export const showModeMenu = signal(false);
export const showCwdBar = signal(true);

export const ideContext = signal<IDEContext>({
  activeFile: null,
  selection: null,
});
export const ideContextDismissed = signal<IDEContextDismissed>({
  activeFile: false,
  selection: false,
});

export const latestRoundChanges = signal<
  Map<string, RoundFileChangeSummary>
>(new Map());

export const clearInputFlag = signal(false);
export const pendingStatusText = signal("Flowing...");

// ── Computed ──────────────────────────────────────────────────────────

export const conversations = computed(
  () => conversationState.value?.conversations ?? [],
);

export const currentConversationId = computed(
  () => conversationState.value?.currentConversationId ?? null,
);

export const currentConversation = computed<Conversation | null>(() => {
  const id = currentConversationId.value;
  if (!id) return null;
  return conversations.value.find((c) => c.id === id) ?? null;
});

export const isStreaming = computed(
  () => conversationState.value?.isStreaming ?? false,
);

export const currentRoundChanges = computed(() => {
  const conv = currentConversation.value;
  if (!conv) return undefined;
  return latestRoundChanges.value.get(conv.id);
});

export const workspaceFolders = computed(
  () => conversationState.value?.workspaceFolders ?? [],
);

export const isMultiRoot = computed(
  () => conversationState.value?.isMultiRoot ?? false,
);

export const contextUsage = computed(
  () => conversationState.value?.contextUsage,
);

// ── Derived helpers ───────────────────────────────────────────────────

export function getWorkspaceFolderName(
  conversation: Conversation | null,
): string | undefined {
  if (!conversation?.workspaceFolderUri || !conversationState.value?.workspaceFolders) {
    return undefined;
  }
  return conversationState.value.workspaceFolders.find(
    (f) => f.uri === conversation.workspaceFolderUri,
  )?.name;
}

export function getCwd(
  conversation: Conversation | null,
): string | undefined {
  if (conversation?.workspaceFolderUri) {
    return conversation.workspaceFolderUri;
  }
  const folders = conversationState.value?.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri;
  }
  return undefined;
}

export function consumeClearInput(): boolean {
  const val = clearInputFlag.value;
  clearInputFlag.value = false;
  return val;
}

export function clearRoundChangesForConversation(conversationId: string): void {
  const current = latestRoundChanges.value;
  if (!current.has(conversationId)) return;
  const next = new Map(current);
  next.delete(conversationId);
  latestRoundChanges.value = next;
}
