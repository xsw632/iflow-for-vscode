import { useCallback } from "preact/hooks";

export function CopyButton({ content }: { content: string }) {
  const handleClick = useCallback(() => {
    void navigator.clipboard.writeText(content);
  }, [content]);

  return (
    <button class="copy-btn" onClick={handleClick}>
      Copy
    </button>
  );
}
