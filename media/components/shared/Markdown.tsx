import { renderMarkdown } from "../../markdownRenderer";

export function Markdown({ text }: { text: string }) {
  return (
    <div
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
    />
  );
}
