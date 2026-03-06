import { escapeHtml } from "../../markdownRenderer";
import { CopyButton } from "../shared/CopyButton";

interface CodeBlockProps {
  language: string;
  filename?: string;
  content: string;
}

export function CodeBlock({ language, filename, content }: CodeBlockProps) {
  return (
    <div class="block-code">
      <div class="code-header">
        <span class="language">
          {escapeHtml(language)}
          {filename ? ` - ${escapeHtml(filename)}` : ""}
        </span>
        <CopyButton content={content} />
      </div>
      <pre>
        <code>{content}</code>
      </pre>
    </div>
  );
}
