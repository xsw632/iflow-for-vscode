import { useCallback, useEffect, useRef } from "preact/hooks";
import type { PendingConfirmation } from "../../panels/panelTypes";
import { pendingConfirmation } from "../../store/signals";
import { postMessage } from "../../hooks/usePostMessage";

export function ApprovalPanel({ conf }: { conf: PendingConfirmation }) {
  const feedbackRef = useRef<HTMLInputElement>(null);

  const respond = useCallback(
    (outcome: "allow" | "alwaysAllow" | "reject", feedback?: string) => {
      postMessage({
        type: "toolApproval",
        requestId: conf.requestId,
        outcome,
      });
      pendingConfirmation.value = null;
    },
    [conf.requestId],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "1") respond("allow");
      else if (e.key === "2") respond("alwaysAllow");
      else if (e.key === "3") respond("reject");
      else if (e.key === "4") feedbackRef.current?.focus();
      else if (e.key === "Escape") respond("reject");
      else if (e.key === "Enter" && document.activeElement === feedbackRef.current) {
        const text = feedbackRef.current?.value.trim();
        if (text) respond("reject", text);
      }
    },
    [respond],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div class="composer approval-panel" role="dialog" aria-label="Tool approval">
      <div class="approval-question">
        Allow <strong>{conf.toolName}</strong>?
      </div>
      <div class="approval-options">
        <button
          class="approval-option"
          onClick={() => respond("allow")}
          aria-label="Allow this action"
        >
          <span class="approval-key">1</span>
          <span class="approval-label">Yes</span>
        </button>
        <button
          class="approval-option"
          onClick={() => respond("alwaysAllow")}
          aria-label="Allow all edits for this session"
        >
          <span class="approval-key">2</span>
          <span class="approval-label">Yes, allow all edits this session</span>
        </button>
        <button
          class="approval-option"
          onClick={() => respond("reject")}
          aria-label="Reject this action"
        >
          <span class="approval-key">3</span>
          <span class="approval-label">No</span>
        </button>
        <div class="approval-option feedback-option">
          <span class="approval-key">4</span>
          <input
            ref={feedbackRef}
            type="text"
            id="approval-feedback-input"
            class="approval-feedback-input"
            placeholder="Tell IFlow what to do instead..."
            aria-label="Approval feedback"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const text = (e.target as HTMLInputElement).value.trim();
                if (text) respond("reject", text);
              }
            }}
          />
        </div>
      </div>
      <div class="approval-hint">Esc to cancel</div>
    </div>
  );
}
