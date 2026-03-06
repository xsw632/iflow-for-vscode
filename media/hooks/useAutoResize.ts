import { useCallback, useRef } from "preact/hooks";
import { TEXTAREA_MIN_HEIGHT, TEXTAREA_MAX_HEIGHT } from "../webviewUtils";

export function useAutoResize() {
  const ref = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(Math.max(el.scrollHeight, TEXTAREA_MIN_HEIGHT), TEXTAREA_MAX_HEIGHT);
    el.style.height = `${next}px`;
  }, []);

  return { ref, resize };
}
