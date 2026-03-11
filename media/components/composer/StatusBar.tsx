import { useCallback } from "preact/hooks";
import type { Conversation, ConversationMode, ModelType } from "../../../src/protocol";
import { MODELS } from "../../../src/protocol";
import { showModeMenu } from "../../store/signals";
import { getModeLabel, getPieSlicePath } from "../../renderers/sharedRendererUtils";
import { postMessage } from "../../hooks/usePostMessage";

interface StatusBarProps {
  conversation: Conversation | null;
  contextUsage?: { percent: number; usedTokens: number; totalTokens: number };
}

const MODES: Array<{ value: ConversationMode; label: string; desc: string }> = [
  { value: "default", label: "Chat", desc: "Normal conversation" },
  { value: "yolo", label: "YOLO", desc: "Auto-approve actions" },
  { value: "plan", label: "Plan", desc: "Plan before executing" },
  { value: "smart", label: "Smart", desc: "AI-driven edits" },
];

export function StatusBar({ conversation, contextUsage }: StatusBarProps) {
  const currentMode = conversation?.mode || "default";
  const isThinking = conversation?.think ?? false;
  const currentModel = conversation?.model ?? "GLM-4.7";
  const isMenuOpen = showModeMenu.value;

  const toggleMenu = useCallback(() => {
    showModeMenu.value = !showModeMenu.value;
  }, []);

  const selectMode = useCallback((mode: ConversationMode) => {
    postMessage({ type: "setMode", mode });
    showModeMenu.value = false;
  }, []);

  const toggleThinking = useCallback(() => {
    postMessage({ type: "setThink", enabled: !isThinking });
    showModeMenu.value = false;
  }, [isThinking]);

  const handleModelChange = useCallback((e: Event) => {
    const value = (e.target as HTMLSelectElement).value as ModelType;
    postMessage({ type: "setModel", model: value });
  }, []);

  return (
    <div class="composer-status-bar">
      <div class="status-left">
        <div class="status-item mode-selector-wrapper">
          <button
            id="mode-trigger"
            class="mode-trigger"
            aria-label="Choose mode"
            aria-haspopup="listbox"
            aria-expanded={isMenuOpen ? "true" : "false"}
            aria-controls="mode-popup"
            onClick={toggleMenu}
          >
            <span>{getModeLabel(currentMode)}</span>
            <span class="chevron">▾</span>
          </button>
          <div
            class={`mode-popup ${isMenuOpen ? "" : "hidden"}`}
            id="mode-popup"
            role="listbox"
            aria-label="Conversation mode options"
          >
            {MODES.map((m) => (
              <div
                key={m.value}
                class={`mode-option ${currentMode === m.value ? "active" : ""}`}
                role="option"
                tabIndex={0}
                aria-selected={currentMode === m.value ? "true" : "false"}
                onClick={() => selectMode(m.value)}
              >
                <span class="mode-option-label">{m.label}</span>
                <span class="mode-option-desc">{m.desc}</span>
              </div>
            ))}
            <div class="mode-popup-divider" />
            <div
              class="mode-option think-option"
              id="think-option"
              role="button"
              tabIndex={0}
              aria-label="Toggle thinking mode"
              aria-pressed={isThinking ? "true" : "false"}
              onClick={toggleThinking}
            >
              <span class="mode-option-label">🧠 Thinking</span>
              <div class={`toggle-switch ${isThinking ? "active" : ""}`}>
                <div class="toggle-knob" />
              </div>
            </div>
          </div>
        </div>
        {isThinking && <span class="thinking-chip">🧠 Thinking</span>}
        <div class="status-item model-selector-wrapper">
          <select
            id="model-select"
            class="dropdown-mini"
            title="Select Model"
            aria-label="Select model"
            value={currentModel}
            onChange={handleModelChange}
          >
            {(MODELS as readonly string[]).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <span class="chevron" aria-hidden="true">▾</span>
        </div>
      </div>
      <ContextUsage usage={contextUsage} />
    </div>
  );
}

function ContextUsage({
  usage,
}: {
  usage?: { percent: number; usedTokens: number; totalTokens: number };
}) {
  if (!usage || usage.usedTokens === 0) return null;

  const percent = usage.percent;
  const colorClass =
    percent >= 80 ? "context-high" : percent >= 50 ? "context-mid" : "context-low";
  const label = percent === 0 ? "<1%" : `${percent}%`;
  const piePath = getPieSlicePath(18, 18, 16, percent, usage.usedTokens);

  return (
    <div class="status-right">
      <div
        class={`context-usage ${colorClass}`}
        title={`${usage.usedTokens.toLocaleString()} / ${usage.totalTokens.toLocaleString()} tokens`}
      >
        <svg class="context-pie" width="16" height="16" viewBox="0 0 36 36">
          <circle
            cx="18"
            cy="18"
            r="16"
            fill="var(--vscode-widget-border, rgba(128,128,128,0.3))"
          />
          {piePath && <path d={piePath} fill="currentColor" />}
        </svg>
        <span>{label}</span>
      </div>
    </div>
  );
}
