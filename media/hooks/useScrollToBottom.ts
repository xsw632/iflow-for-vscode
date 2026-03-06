import { useEffect, useRef } from "preact/hooks";
import type { ReadonlySignal } from "@preact/signals";

/**
 * Auto-scrolls an element to the bottom when its children change,
 * but only if the user hasn't scrolled up manually.
 */
export function useScrollToBottom(
  isStreaming: ReadonlySignal<boolean>,
): preact.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const handleScroll = () => {
      const threshold = 40;
      userScrolledUp.current =
        el.scrollTop + el.clientHeight < el.scrollHeight - threshold;
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-scroll when streaming or content changes
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (!userScrolledUp.current) {
      el.scrollTop = el.scrollHeight;
    }
  });

  // Reset scroll lock when streaming starts
  useEffect(() => {
    if (isStreaming.value) {
      userScrolledUp.current = false;
    }
  }, [isStreaming.value]);

  return ref;
}
