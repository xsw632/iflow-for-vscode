import type { JSX } from "preact";
import { getToolHeadline } from "../../renderers/toolHeadline";
import { getToolKind, getInputString, type ToolBlock as ToolBlockData } from "../../renderers/toolTypes";
import { extractEditedFileDiff } from "../../renderers/editPreviewRenderer";
import { extractCommandPreview } from "../../renderers/commandPreviewRenderer";

import { TodoPreview } from "./previews/TodoPreview";
import { DiffPreview } from "./previews/DiffPreview";
import { WritePreview } from "./previews/WritePreview";
import { CommandPreview } from "./previews/CommandPreview";

function statusIcon(status: string): string {
  if (status === "running") return "⏳";
  if (status === "completed") return "✓";
  return "✗";
}

export function ToolBlock({ block }: { block: ToolBlockData }) {
  const headline = getToolHeadline(block);
  const detail = renderDetailPreview(block);

  return (
    <div class="tool-entry">
      <div class={`block-tool ${block.status}`}>
        <span class={`tool-icon ${block.status}`}>{statusIcon(block.status)}</span>
        <span class="tool-headline">{headline}</span>
      </div>
      {detail}
    </div>
  );
}

function renderDetailPreview(block: ToolBlockData): JSX.Element | null {
  // Todo preview
  const toolKind = getToolKind(block);
  if (toolKind === "todo") {
    const todos = block.input?.todos as
      | Array<{ task?: string; content?: string; status?: string }>
      | undefined;
    if (Array.isArray(todos) && todos.length > 0) {
      return <TodoPreview entries={todos} />;
    }
    return null;
  }

  // Edit/patch diff preview
  if (block.status === "completed") {
    const diff = extractEditedFileDiff(block);
    if (diff && diff.lines.length > 0) {
      return <DiffPreview title="Edited file" diff={diff} />;
    }

    // Write file preview
    if (toolKind === "write") {
      const filePath =
        getInputString(block.input || {}, [
          "file_path", "path", "filePath", "file", "absolute_path",
        ]) || "unknown file";
      const content = getInputString(block.input || {}, [
        "content", "file_content", "text", "body", "data",
      ]);
      const raw = (content || block.output || "").trim();
      if (raw) {
        return <WritePreview filePath={filePath} content={raw} />;
      }
    }
  }

  // Command preview
  const cmdPreview = extractCommandPreview(block);
  if (cmdPreview) {
    return <CommandPreview command={cmdPreview.command} lines={cmdPreview.lines} />;
  }

  return null;
}
