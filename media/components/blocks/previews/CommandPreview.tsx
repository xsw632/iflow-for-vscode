export function CommandPreview({
  command,
  lines,
}: {
  command: string;
  lines: string[];
}) {
  return (
    <div class="command-preview">
      <div class="command-preview-header">
        <span class="command-preview-title">Bash command</span>
        <code class="command-preview-cmd">{command}</code>
      </div>
      <div class="command-output-scroll">
        {lines.map((line, idx) => (
          <div key={idx} class="command-line">
            <span class="command-line-no">{idx + 1}</span>
            <span class="command-line-text">{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
