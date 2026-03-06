import { useCallback, useRef } from "preact/hooks";
import { useSignal } from "@preact/signals";
import {
  attachedFiles,
  clearInputFlag,
  consumeClearInput,
  contextUsage,
  currentConversation,
  currentRoundChanges,
  isMultiRoot,
  isStreaming,
  mentionFiles,
  pendingConfirmation,
  pendingPlanApproval,
  pendingQuestion,
  workspaceFolders,
} from "../../store/signals";
import { getCwd } from "../../store/signals";
import { postMessage } from "../../hooks/usePostMessage";
import { useAutoResize } from "../../hooks/useAutoResize";
import { IDEContextChips } from "./IDEContextChips";
import { AttachedFiles } from "./AttachedFiles";
import { MentionMenu } from "./MentionMenu";
import { SlashMenu } from "./SlashMenu";
import { FileChangesCard } from "./FileChangesCard";
import { StatusBar } from "./StatusBar";
import { PanelHost } from "../panels/PanelHost";
import { useEffect } from "preact/hooks";

export function Composer() {
  const conversation = currentConversation.value;
  const streaming = isStreaming.value;

  // Panel overlays take priority
  if (pendingConfirmation.value || pendingQuestion.value || pendingPlanApproval.value) {
    return <PanelHost />;
  }

  return <ComposerInner conversation={conversation} streaming={streaming} />;
}

function ComposerInner({
  conversation,
  streaming,
}: {
  conversation: ReturnType<typeof currentConversation["peek"]>;
  streaming: boolean;
}) {
  const showMention = useSignal(false);
  const mentionFilter = useSignal("");
  const showSlash = useSignal(false);
  const slashFilter = useSignal("");
  const { ref: textareaRef, resize } = useAutoResize();

  // Clear input when conversation changes
  useEffect(() => {
    if (consumeClearInput()) {
      const el = textareaRef.current;
      if (el) {
        el.value = "";
        resize();
      }
    }
  }, [clearInputFlag.value]);

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    resize();
    const value = el.value;
    const cursorPos = el.selectionStart;

    // Slash menu detection
    if (value.startsWith("/")) {
      showSlash.value = true;
      slashFilter.value = value;
      showMention.value = false;
      return;
    }
    showSlash.value = false;

    // Mention menu detection
    const textBeforeCursor = value.substring(0, cursorPos);
    const atMatch = textBeforeCursor.match(/@(\S*)$/);
    if (atMatch) {
      showMention.value = true;
      mentionFilter.value = atMatch[1];
      postMessage({ type: "listWorkspaceFiles", query: atMatch[1] });
    } else {
      showMention.value = false;
    }
  }, [resize]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (showSlash.value) return;

      if (showMention.value && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        return;
      }
      if (showMention.value && e.key === "Escape") {
        e.preventDefault();
        showMention.value = false;
        return;
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [showSlash.value, showMention.value],
  );

  const handleSend = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const content = el.value.trim();
    const files = attachedFiles.value;
    const hasFiles = files.length > 0;
    const hasLoading = files.some((f) => f.content === undefined);

    if (!content && !hasFiles) return;
    if (hasFiles && hasLoading) return;

    const toSend = [...files];
    attachedFiles.value = [];
    el.value = "";
    resize();

    postMessage({ type: "sendMessage", content, attachedFiles: toSend });
  }, [resize]);

  const handleCancel = useCallback(() => {
    postMessage({ type: "cancelCurrent" });
  }, []);

  const handleAttach = useCallback(() => {
    postMessage({ type: "pickFiles" });
  }, []);

  const handleRemoveFile = useCallback((index: number) => {
    attachedFiles.value = attachedFiles.value.filter((_, i) => i !== index);
  }, []);

  const handleMentionSelect = useCallback((filePath: string) => {
    const el = textareaRef.current;
    if (!el) return;

    const value = el.value;
    const cursorPos = el.selectionStart;
    const textBeforeCursor = value.substring(0, cursorPos);
    const newTextBefore = textBeforeCursor.replace(/@\S*$/, "");
    el.value = newTextBefore + value.substring(cursorPos);

    const existing = new Set(attachedFiles.value.map((f) => f.path));
    if (!existing.has(filePath)) {
      attachedFiles.value = [...attachedFiles.value, { path: filePath }];
      postMessage({ type: "readFiles", paths: [filePath] });
    }

    showMention.value = false;
    el.focus();
  }, []);

  const cwd = getCwd(conversation);
  const usage = contextUsage.value;
  const roundChanges = currentRoundChanges.value;

  return (
    <div class="composer">
      <FileChangesCard summary={roundChanges} />
      <IDEContextChips />
      <AttachedFiles files={attachedFiles.value} onRemove={handleRemoveFile} />
      <div class="composer-input-row">
        <button
          id="attach-btn"
          class="icon-btn"
          title="Attach files"
          aria-label="Attach files"
          onClick={handleAttach}
        >
          <span class="icon">📎</span>
        </button>
        <div class="input-wrapper">
          <textarea
            id="message-input"
            ref={textareaRef}
            placeholder="Message iFlow..."
            rows={1}
            aria-label="Message input"
            onInput={handleInput}
            onKeyDown={handleKeyDown}
          />
          {showSlash.value && (
            <SlashMenu
              visible={showSlash.value}
              filter={slashFilter.value}
              conversation={conversation}
              workspaceFolders={workspaceFolders.value}
              isMultiRoot={isMultiRoot.value}
              onClose={() => {
                showSlash.value = false;
              }}
              onClearInput={() => {
                const el = textareaRef.current;
                if (el) {
                  el.value = "";
                  resize();
                }
              }}
            />
          )}
          {showMention.value && (
            <MentionMenu
              files={mentionFiles.value}
              filter={mentionFilter.value}
              onSelect={handleMentionSelect}
            />
          )}
        </div>
        {streaming ? (
          <button
            id="cancel-btn"
            class="icon-btn danger stop-btn"
            title="Stop"
            aria-label="Stop response generation"
            onClick={handleCancel}
          >
            <span class="stop-glyph" aria-hidden="true" />
          </button>
        ) : (
          <button
            id="send-btn"
            class="icon-btn primary"
            title="Send"
            aria-label="Send message"
            onClick={handleSend}
          >
            <span class="icon">➤</span>
          </button>
        )}
      </div>
      <StatusBar
        conversation={conversation}
        cwd={cwd}
        contextUsage={usage}
      />
    </div>
  );
}
