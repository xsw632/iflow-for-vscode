import { useSignal } from "@preact/signals";
import { useCallback, useEffect } from "preact/hooks";
import type { PendingQuestion } from "../../panels/panelTypes";
import { pendingQuestion } from "../../store/signals";
import { postMessage } from "../../hooks/usePostMessage";
import {
  createQuestionPanelState,
  deriveQuestionPanelState,
  reduceQuestionPanelState,
  shouldSubmitAnswers,
  buildQuestionAnswerPayload,
  buildCancelledQuestionAnswerPayload,
} from "../../../src/shared/questionPanelState";
import type { QuestionPanelState } from "../../../src/shared/questionPanelTypes";

export function QuestionPanel({ pq }: { pq: PendingQuestion }) {
  const state = useSignal<QuestionPanelState>(
    createQuestionPanelState(pq.questions),
  );
  const derived = deriveQuestionPanelState(state.value);

  const dispatch = useCallback(
    (action: Parameters<typeof reduceQuestionPanelState>[1]) => {
      const prev = state.value;
      const next = reduceQuestionPanelState(prev, action);
      state.value = next;

      if (shouldSubmitAnswers(prev, next)) {
        const answers = buildQuestionAnswerPayload(next);
        postMessage({
          type: "questionAnswer",
          requestId: pq.requestId,
          answers,
        });
        pendingQuestion.value = null;
      }
    },
    [pq.requestId],
  );

  const handleCancel = useCallback(() => {
    const answers = buildCancelledQuestionAnswerPayload(pq.questions);
    postMessage({
      type: "questionAnswer",
      requestId: pq.requestId,
      answers,
    });
    pendingQuestion.value = null;
  }, [pq.requestId, pq.questions]);

  // Global keyboard handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleCancel();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        dispatch({ type: "moveNav", delta: -1 });
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        dispatch({ type: "moveNav", delta: 1 });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        dispatch({ type: "moveOption", delta: -1 });
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        dispatch({ type: "moveOption", delta: 1 });
        return;
      }
      if (e.key === "Enter" && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        if (state.value.isReviewMode) {
          dispatch({ type: "attemptSubmit" });
        } else {
          const optionIdx =
            state.value.activeOptionIndexByQuestion[state.value.activeQuestionIndex] ?? 0;
          dispatch({ type: "activateOption", optionIdx });
        }
        return;
      }
      // Number key shortcuts
      const numKey = parseInt(e.key, 10);
      if (numKey >= 1 && !isNaN(numKey)) {
        dispatch({ type: "activateOption", optionIdx: numKey - 1 });
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [dispatch, handleCancel]);

  const s = state.value;

  return (
    <div class="composer question-panel" role="dialog" aria-label="Questionnaire">
      {/* Navigation tabs */}
      <div class="question-nav" role="tablist" aria-label="Question navigation">
        {pq.questions.map((q, idx) => (
          <button
            key={idx}
            class={`question-nav-item${idx === s.activeNavIndex ? " active" : ""}${derived.answeredByQuestion[idx] ? " answered" : ""}`}
            type="button"
            onClick={() => dispatch({ type: "setNavIndex", navIndex: idx })}
            title={q.header}
          >
            {q.header}
          </button>
        ))}
        <button
          class={`question-nav-item question-submit-item${s.activeNavIndex === derived.submitNavIndex ? " active" : ""}${!derived.canSubmit ? " disabled" : ""}`}
          type="button"
          onClick={() => dispatch({ type: "attemptSubmit" })}
        >
          Submit answers
        </button>
      </div>

      {/* Question or Review stage */}
      {s.isReviewMode ? (
        <ReviewStage state={s} />
      ) : (
        <QuestionStage
          state={s}
          derived={derived}
          dispatch={dispatch}
        />
      )}

      {/* Error message */}
      {s.showSubmitError && (
        <div class="question-submit-error visible">
          Please answer every question before submitting.
        </div>
      )}

      <div class="approval-hint question-hint">
        Enter to select · Left/Right to switch question · Esc to cancel
      </div>
    </div>
  );
}

function QuestionStage({
  state,
  derived,
  dispatch,
}: {
  state: QuestionPanelState;
  derived: ReturnType<typeof deriveQuestionPanelState>;
  dispatch: (action: Parameters<typeof reduceQuestionPanelState>[1]) => void;
}) {
  const question = derived.activeQuestion;
  if (!question) {
    return (
      <div class="question-stage">
        <div class="question-empty">No questions to answer. Press Esc to cancel.</div>
      </div>
    );
  }

  const selected = state.selectedOptionLabelsByQuestion[state.activeQuestionIndex] ?? [];
  const otherValue = state.otherTextByQuestion[state.activeQuestionIndex] ?? "";

  return (
    <div class="question-stage">
      <div class="question-text">{question.question}</div>
      <div class="question-subtitle">
        Question {state.activeQuestionIndex + 1} of {state.questions.length}
        {question.multiSelect ? " · Select one or more" : ""}
      </div>
      <div class="approval-options question-options-list">
        {question.options.map((opt, optionIdx) => (
          <button
            key={optionIdx}
            class={`approval-option question-option${selected.includes(opt.label) ? " selected" : ""}${derived.activeOptionIndex === optionIdx ? " focused" : ""}`}
            type="button"
            onClick={() => dispatch({ type: "activateOption", optionIdx })}
          >
            <span class="approval-key">{optionIdx + 1}</span>
            <span class="approval-label">{opt.label}</span>
            {opt.description && (
              <span class="option-description">{opt.description}</span>
            )}
          </button>
        ))}
        {/* Other option */}
        <div
          class={`approval-option question-option question-other-row${otherValue.trim() ? " selected" : ""}${derived.activeOptionIndex === question.options.length ? " focused" : ""}`}
          onClick={() =>
            dispatch({ type: "activateOption", optionIdx: question.options.length })
          }
        >
          <span class="approval-key">{question.options.length + 1}</span>
          <input
            type="text"
            class="approval-feedback-input question-other-input"
            placeholder="Other..."
            value={otherValue}
            onInput={(e) =>
              dispatch({
                type: "setOtherText",
                questionIdx: state.activeQuestionIndex,
                value: (e.target as HTMLInputElement).value,
              })
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.stopPropagation();
                dispatch({
                  type: "commitOtherInput",
                  questionIdx: state.activeQuestionIndex,
                });
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      </div>
    </div>
  );
}

function ReviewStage({ state }: { state: QuestionPanelState }) {
  return (
    <div class="question-review">
      <div class="question-review-title">Review your answers</div>
      <div class="question-review-list">
        {state.questions.map((question, qIdx) => {
          let answerText: string;
          if (question.multiSelect) {
            const selected = [...(state.selectedOptionLabelsByQuestion[qIdx] ?? [])];
            const other = (state.otherTextByQuestion[qIdx] ?? "").trim();
            if (other) selected.push(other);
            answerText = selected.join(", ") || "(No answer)";
          } else {
            const selected = state.selectedOptionLabelsByQuestion[qIdx]?.[0] ?? "";
            const other = (state.otherTextByQuestion[qIdx] ?? "").trim();
            answerText = other || selected || "(No answer)";
          }
          return (
            <div key={qIdx} class="review-row">
              <div class="review-question">- {question.question}</div>
              <div class="review-answer">-&gt; {answerText}</div>
            </div>
          );
        })}
      </div>
      <div class="question-review-ready">Ready to submit your answers?</div>
    </div>
  );
}
