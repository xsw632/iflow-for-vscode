import { useSignal } from "@preact/signals";
import { useCallback } from "preact/hooks";

interface ThinkingBlockProps {
  content: string;
  collapsed: boolean;
}

export function ThinkingBlock({ content, collapsed: initialCollapsed }: ThinkingBlockProps) {
  const collapsed = useSignal(initialCollapsed);

  const toggle = useCallback(() => {
    collapsed.value = !collapsed.value;
  }, [collapsed]);

  return (
    <div class={`block-thinking ${collapsed.value ? "collapsed" : ""}`}>
      <div class="thinking-header" onClick={toggle}>
        <span class="thinking-icon">💭</span>
        <span>Thinking...</span>
        <span class="expand-icon">▼</span>
      </div>
      <div class={`thinking-content ${collapsed.value ? "collapsed" : ""}`}>
        {content}
      </div>
    </div>
  );
}
