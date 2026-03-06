interface PlanEntry {
  content: string;
  status: string;
  priority: string;
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

export function PlanBlock({ entries }: { entries: PlanEntry[] }) {
  const pending = entries.filter((e) => e.status === "pending").length;
  const inProgress = entries.filter((e) => e.status === "in_progress").length;
  const completed = entries.filter((e) => e.status === "completed").length;
  const allDone = completed === entries.length && entries.length > 0;

  const summaryParts: string[] = [];
  if (pending > 0) summaryParts.push(`${pending} pending`);
  if (inProgress > 0) summaryParts.push(`${inProgress} in progress`);
  if (completed > 0) summaryParts.push(`${completed} completed`);
  const summary = summaryParts.length > 0 ? summaryParts.join(", ") : "empty";

  const statusIconChar = allDone ? "✓" : "⏳";
  const statusClass = allDone ? "completed" : "running";

  return (
    <div class="tool-entry">
      <div class={`block-tool ${statusClass}`}>
        <span class={`tool-icon ${statusClass}`}>{statusIconChar}</span>
        <span class="tool-headline">{`Plan · ${summary}`}</span>
      </div>
      <div class="plan-entries">
        {entries.map((entry, i) => (
          <div key={i} class={`plan-entry ${entryClass(entry.status)}`}>
            <span class={`plan-entry-icon ${entryClass(entry.status)}`}>
              {entryIcon(entry.status)}
            </span>
            <span class="plan-entry-text">{entry.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
