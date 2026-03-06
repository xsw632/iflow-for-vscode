import { useCallback, useEffect, useRef } from "preact/hooks";
import type { PendingPlanApproval } from "../../panels/panelTypes";
import { pendingPlanApproval } from "../../store/signals";
import { postMessage } from "../../hooks/usePostMessage";
import { Markdown } from "../shared/Markdown";

export function PlanApprovalPanel({ pp }: { pp: PendingPlanApproval }) {
  const feedbackRef = useRef<HTMLInputElement>(null);

  const respond = useCallback(
    (option: "smart" | "default" | "keep", feedback?: string) => {
      postMessage({
        type: "planApproval",
        requestId: pp.requestId,
        option: feedback ? "feedback" : option,
        feedback,
      });
      pendingPlanApproval.value = null;
    },
    [pp.requestId],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "1") respond("smart");
      else if (e.key === "2") respond("default");
      else if (e.key === "3") respond("keep");
      else if (e.key === "4") feedbackRef.current?.focus();
      else if (e.key === "Escape") respond("keep");
      else if (e.key === "Enter" && document.activeElement === feedbackRef.current) {
        const text = feedbackRef.current?.value.trim();
        if (text) respond("keep", text);
      }
    },
    [respond],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div
      class="composer plan-approval-panel"
      role="dialog"
      aria-label="Plan approval"
    >
      <div class="plan-approval-question">Approve this plan?</div>
      {pp.plan && (
        <div class="plan-content">
          <Markdown text={pp.plan} />
        </div>
      )}
      <div class="approval-options">
        <button
          class="approval-option"
          onClick={() => respond("smart")}
          aria-label="Approve plan and use smart mode edits"
        >
          <span class="approval-key">1</span>
          <span class="approval-label">Yes, and use smart mode edits</span>
        </button>
        <button
          class="approval-option"
          onClick={() => respond("default")}
          aria-label="Approve plan and require manual edit approvals"
        >
          <span class="approval-key">2</span>
          <span class="approval-label">Yes, and manually approve edits</span>
        </button>
        <button
          class="approval-option"
          onClick={() => respond("keep")}
          aria-label="Keep planning"
        >
          <span class="approval-key">3</span>
          <span class="approval-label">No, keep planning</span>
        </button>
        <div class="approval-option plan-feedback-option">
          <span class="approval-key">4</span>
          <input
            ref={feedbackRef}
            type="text"
            class="approval-feedback-input plan-feedback-input"
            placeholder="Tell iFlow what to do instead..."
            aria-label="Plan feedback"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const text = (e.target as HTMLInputElement).value.trim();
                if (text) respond("keep", text);
              }
            }}
          />
        </div>
      </div>
      <div class="approval-hint">Esc to keep planning</div>
    </div>
  );
}
