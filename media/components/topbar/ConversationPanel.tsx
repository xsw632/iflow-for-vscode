import { useMemo } from "preact/hooks";
import type { Conversation } from "../../../src/protocol";
import {
  conversations,
  currentConversationId,
  conversationSearch,
  showConversationPanel,
} from "../../store/signals";
import { postMessage } from "../../hooks/usePostMessage";
import { timeAgo } from "../../renderers/sharedRendererUtils";

export function ConversationPanel() {
  const search = conversationSearch.value;
  const show = showConversationPanel.value;
  const currentId = currentConversationId.value;
  const allConversations = conversations.value;

  const filtered = useMemo(() => {
    if (!search) return allConversations;
    const lower = search.toLowerCase();
    return allConversations.filter((c) =>
      c.title.toLowerCase().includes(lower),
    );
  }, [allConversations, search]);

  const now = Date.now();
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const yesterdayStart = todayStart - 86400000;

  const groups = useMemo(() => {
    const today: Conversation[] = [];
    const yesterday: Conversation[] = [];
    const earlier: Conversation[] = [];
    for (const c of filtered) {
      if (c.updatedAt >= todayStart) today.push(c);
      else if (c.updatedAt >= yesterdayStart) yesterday.push(c);
      else earlier.push(c);
    }
    const result: Array<{ label: string; items: Conversation[] }> = [];
    if (today.length > 0) result.push({ label: "Today", items: today });
    if (yesterday.length > 0) result.push({ label: "Yesterday", items: yesterday });
    if (earlier.length > 0) result.push({ label: "Earlier", items: earlier });
    return result;
  }, [filtered, todayStart, yesterdayStart]);

  const handleSelect = (id: string) => {
    postMessage({ type: "switchConversation", conversationId: id });
    showConversationPanel.value = false;
  };

  const handleDelete = (e: Event, id: string) => {
    e.stopPropagation();
    postMessage({ type: "deleteConversation", conversationId: id });
  };

  return (
    <div
      class={`conversation-panel ${show ? "" : "hidden"}`}
      id="conversation-panel"
      role="dialog"
      aria-label="Conversation list"
    >
      <div class="conversation-panel-search">
        <input
          type="text"
          id="conversation-search"
          placeholder="Search sessions..."
          value={search}
          onInput={(e) => {
            conversationSearch.value = (e.target as HTMLInputElement).value;
          }}
          aria-label="Search conversations"
        />
      </div>
      <div class="conversation-panel-list" role="listbox" aria-label="Conversations">
        {groups.length === 0 && (
          <div class="conversation-panel-empty">No conversations found</div>
        )}
        {groups.map((g) => (
          <div key={g.label}>
            <div class="conversation-group-label">{g.label}</div>
            {g.items.map((c) => (
              <div
                key={c.id}
                class={`conversation-item ${c.id === currentId ? "active" : ""}`}
                role="option"
                tabIndex={0}
                aria-selected={c.id === currentId ? "true" : "false"}
                onClick={() => handleSelect(c.id)}
              >
                <div class="conversation-item-info">
                  <div class="conversation-item-title">{c.title}</div>
                  <div class="conversation-item-meta">
                    <span>{c.messages.length} messages</span>
                  </div>
                </div>
                <span class="conversation-item-time">
                  {timeAgo(c.updatedAt, now)}
                </span>
                <button
                  class="conversation-item-delete"
                  onClick={(e) => handleDelete(e, c.id)}
                  title="Delete"
                  aria-label={`Delete conversation ${c.title}`}
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
