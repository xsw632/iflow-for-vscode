import { ideContext, ideContextDismissed } from "../../store/signals";
import { FileIcon } from "../shared/FileIcon";

export function IDEContextChips() {
  const ctx = ideContext.value;
  const dismissed = ideContextDismissed.value;

  const chips: preact.JSX.Element[] = [];

  if (ctx.activeFile && !dismissed.activeFile) {
    chips.push(
      <div
        key="activeFile"
        class="ide-context-chip"
        title={ctx.activeFile.path}
      >
        <FileIcon path={ctx.activeFile.path} />
        <span class="ide-context-label">{ctx.activeFile.name}</span>
        <button
          class="ide-context-dismiss"
          onClick={() => {
            ideContextDismissed.value = {
              ...ideContextDismissed.value,
              activeFile: true,
            };
          }}
          title="Remove"
          aria-label="Dismiss active file context"
        >
          &times;
        </button>
      </div>,
    );
  }

  if (ctx.selection && !dismissed.selection) {
    const label = `${ctx.selection.fileName}:${ctx.selection.lineStart}-${ctx.selection.lineEnd}`;
    chips.push(
      <div
        key="selection"
        class="ide-context-chip"
        title={ctx.selection.text.substring(0, 200)}
      >
        <span class="file-icon">&#9986;</span>
        <span class="ide-context-label">{label}</span>
        <button
          class="ide-context-dismiss"
          onClick={() => {
            ideContextDismissed.value = {
              ...ideContextDismissed.value,
              selection: true,
            };
          }}
          title="Remove"
          aria-label="Dismiss selection context"
        >
          &times;
        </button>
      </div>,
    );
  }

  if (chips.length === 0) return null;

  return (
    <div class="ide-context-chips" id="ide-context-chips">
      {chips}
    </div>
  );
}
