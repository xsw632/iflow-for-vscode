import { shortenPath } from "../../../fileUtils";
import { MAX_DIFF_LINES } from "../../../renderers/toolTypes";

export function WritePreview({
  filePath,
  content,
}: {
  filePath: string;
  content: string;
}) {
  const lines = content.split("\n");
  const visible = lines.slice(0, MAX_DIFF_LINES);
  const truncated = lines.length > MAX_DIFF_LINES;

  return (
    <div class="edited-file-preview">
      <div class="edited-file-header">
        <span class="edited-file-title">Written file</span>
        <span class="edited-file-name">{shortenPath(filePath)}</span>
        <span class="edited-file-stats">
          <span class="stat-added">Added {lines.length}</span>
        </span>
      </div>
      <div class="edited-file-diff-scroll">
        {visible.map((line, idx) => (
          <div key={idx} class="diff-line add">
            <span class="diff-line-no">{idx + 1}</span>
            <span class="diff-sign">+</span>
            <span class="diff-text">{line}</span>
          </div>
        ))}
        {truncated && (
          <div class="diff-line add">
            <span class="diff-line-no" />
            <span class="diff-sign" />
            <span class="diff-text">
              ... {lines.length - MAX_DIFF_LINES} more lines
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
