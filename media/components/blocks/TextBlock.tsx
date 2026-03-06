import { Markdown } from "../shared/Markdown";

export function TextBlock({ content }: { content: string }) {
  return (
    <div class="block-text">
      <Markdown text={content} />
    </div>
  );
}
