interface DiffLine {
  kind: "add" | "del" | "ctx" | "meta";
  text: string;
  lineNo?: number;
}

interface DiffData {
  fileName: string;
  added: number;
  removed: number;
  lines: DiffLine[];
}

function signChar(kind: string): string {
  if (kind === "add") return "+";
  if (kind === "del") return "-";
  return "";
}

export function DiffPreview({
  title,
  diff,
}: {
  title: string;
  diff: DiffData;
}) {
  return (
    <div class="edited-file-preview">
      <div class="edited-file-header">
        <span class="edited-file-title">{title}</span>
        <span class="edited-file-name">{diff.fileName}</span>
        <span class="edited-file-stats">
          <span class="stat-added">Added {diff.added}</span>{" "}
          <span class="stat-removed">Removed {diff.removed}</span>
        </span>
      </div>
      <div class="edited-file-diff-scroll">
        {diff.lines.map((line, i) => (
          <div key={i} class={`diff-line ${line.kind}`}>
            <span class="diff-line-no">{line.lineNo ?? ""}</span>
            <span class="diff-sign">{signChar(line.kind)}</span>
            <span class="diff-text">{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
