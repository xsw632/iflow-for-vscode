import type { ReadonlySignal } from "@preact/signals";
import { useComputed } from "@preact/signals";
import {
  currentConversation,
  isStreaming,
  pendingStatusText,
} from "../../store/signals";
import { useScrollToBottom } from "../../hooks/useScrollToBottom";
import { MessageItem } from "./MessageItem";

interface MessageListProps {
  faviconUri: string;
}

export function MessageList({ faviconUri }: MessageListProps) {
  const conversation = currentConversation.value;
  const streaming = isStreaming.value;
  const statusText = pendingStatusText.value;
  const scrollRef = useScrollToBottom(isStreaming);

  if (!conversation || conversation.messages.length === 0) {
    return (
      <div class="messages" id="messages-container" ref={scrollRef}>
        <div class="empty-state">
          <div class="logo">
            <img src={faviconUri} alt="IFlow" class="logo-icon" />
          </div>
          <h2>Welcome to IFlow</h2>
          <p>Start a conversation by typing a message below.</p>
          <p class="hint">Use / for commands, @ to mention files</p>
        </div>
      </div>
    );
  }

  return (
    <div class="messages" id="messages-container" ref={scrollRef}>
      {conversation.messages.map((m) => (
        <MessageItem key={m.id} message={m} />
      ))}
      {streaming && (
        <div class="pending-indicator">
          <div class="bounce-logo">
            <img src={faviconUri} alt="IFlow" class="bounce-logo-icon" />
          </div>
          <span class="pending-indicator-text">{statusText}</span>
        </div>
      )}
    </div>
  );
}
