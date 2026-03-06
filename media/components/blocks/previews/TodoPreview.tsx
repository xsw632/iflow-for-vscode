interface TodoEntry {
  task?: string;
  content?: string;
  status?: string;
}

function entryIcon(status: string): string {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "⏳";
  return "☐";
}

function entryClass(status: string): string {
  if (status === "completed") return "completed";
  if (status === "in_progress") return "in-progress";
  return "pending";
}

export function TodoPreview({ entries }: { entries: TodoEntry[] }) {
  return (
    <div class="plan-entries">
      {entries.map((entry, i) => {
        const text = entry.task || entry.content || "";
        const status = entry.status || "pending";
        return (
          <div key={i} class={`plan-entry ${entryClass(status)}`}>
            <span class={`plan-entry-icon ${entryClass(status)}`}>
              {entryIcon(status)}
            </span>
            <span class="plan-entry-text">{text}</span>
          </div>
        );
      })}
    </div>
  );
}
