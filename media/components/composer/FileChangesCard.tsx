import type { RoundFileChangeSummary } from "../../../src/protocol";
import { FileIcon } from "../shared/FileIcon";
import { postMessage } from "../../hooks/usePostMessage";

export function FileChangesCard({
  summary,
}: {
  summary: RoundFileChangeSummary | undefined;
}) {
  if (!summary || summary.changedFiles.length === 0) return null;

  const visibleFiles = summary.changedFiles.filter(
    (file) => file.status !== "accepted",
  );
  if (visibleFiles.length === 0) return null;

  const fileCount = visibleFiles.length;
  const fileLabel = fileCount === 1 ? "file" : "files";
  const totalAdded = visibleFiles.reduce((sum, f) => sum + f.added, 0);
  const totalRemoved = visibleFiles.reduce((sum, f) => sum + f.removed, 0);

  const handleRowClick = (file: typeof visibleFiles[0]) => {
    postMessage({
      type: "fileChangeAction",
      action: "openDiff",
      path: file.path,
      conversationId: summary.conversationId,
      assistantMessageId: summary.assistantMessageId,
    });
  };

  const handleAction = (
    e: Event,
    action: "approve" | "rollback",
    filePath: string,
  ) => {
    e.stopPropagation();
    postMessage({
      type: "fileChangeAction",
      action,
      path: filePath,
      conversationId: summary.conversationId,
      assistantMessageId: summary.assistantMessageId,
    });
  };

  return (
    <div class="round-file-changes-card" aria-label="Round file changes summary">
      <div class="round-file-changes-header">
        <span>
          {fileCount} {fileLabel} changed
        </span>
        <span class="round-file-changes-total">
          <span class="round-file-change-added">+{totalAdded}</span>
          <span class="round-file-change-removed">-{totalRemoved}</span>
        </span>
      </div>
      <div class="round-file-changes-list">
        {visibleFiles.map((file) => (
          <div
            key={file.path}
            class={`round-file-change-row status-${file.status}`}
            role="button"
            tabIndex={0}
            onClick={() => handleRowClick(file)}
            title={file.path}
            aria-label={`Open diff for ${file.displayPath}`}
          >
            <span class="round-file-change-main">
              <FileIcon path={file.path} extraClass="round-file-change-icon" />
              <span class="round-file-change-path">{file.displayPath}</span>
              <span class="round-file-change-kind">{file.kind}</span>
            </span>
            <span class="round-file-change-stats">
              <span class="round-file-change-added">+{file.added}</span>
              <span class="round-file-change-removed">-{file.removed}</span>
            </span>
            <span class="round-file-change-actions">
              <button
                type="button"
                class="round-file-change-action approve"
                onClick={(e) => handleAction(e, "approve", file.path)}
                aria-label={`Approve ${file.displayPath}`}
                title="同意"
              >
                ✓
              </button>
              <button
                type="button"
                class="round-file-change-action rollback"
                onClick={(e) => handleAction(e, "rollback", file.path)}
                aria-label={`Rollback ${file.displayPath}`}
                title="撤销"
              >
                撤销
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
