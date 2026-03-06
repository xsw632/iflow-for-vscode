import {
  currentConversation,
  showConversationPanel,
} from "../../store/signals";
import { postMessage } from "../../hooks/usePostMessage";
import { ConversationPanel } from "./ConversationPanel";

export function TopBar() {
  const conversation = currentConversation.value;
  const title = conversation?.title || "New Conversation";
  const isOpen = showConversationPanel.value;

  const togglePanel = () => {
    showConversationPanel.value = !showConversationPanel.value;
  };

  const handleNewConversation = () => {
    postMessage({ type: "newConversation" });
  };

  return (
    <div class="top-bar">
      <div class="conversation-selector">
        <button
          id="conversation-trigger"
          class="conversation-trigger"
          title="Switch conversation"
          aria-label="Switch conversation"
          aria-haspopup="listbox"
          aria-expanded={isOpen ? "true" : "false"}
          aria-controls="conversation-panel"
          onClick={togglePanel}
        >
          <span>{title}</span>
          <span class="chevron">▼</span>
        </button>
        <ConversationPanel />
      </div>
      <div class="toolbar">
        <button
          id="new-conversation-top-btn"
          class="icon-btn"
          title="New Chat"
          aria-label="Start new conversation"
          onClick={handleNewConversation}
        >
          <span class="icon">+</span>
        </button>
      </div>
    </div>
  );
}
