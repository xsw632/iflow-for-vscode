import type { AttachedFile } from "../../../src/protocol";
import { getFileName, getFileIcon } from "../../fileUtils";
import { postMessage } from "../../hooks/usePostMessage";

interface AttachedFilesProps {
  files: AttachedFile[];
  onRemove: (index: number) => void;
}

export function AttachedFiles({ files, onRemove }: AttachedFilesProps) {
  if (files.length === 0) return null;

  const handleOpen = (path: string) => {
    postMessage({ type: "openFile", path });
  };

  return (
    <div class="attached-files" id="attached-files">
      {files.map((f, i) => (
        <div key={f.path} class={`file-chip ${f.content === undefined ? "loading" : ""}`}>
          <button
            class="file-open-btn"
            onClick={() => handleOpen(f.path)}
            title={`Open ${getFileName(f.path)}`}
          >
            <span class="file-icon">{getFileIcon(f.path)}</span>
            <span class="file-name">{getFileName(f.path)}</span>
          </button>
          {f.content === undefined && (
            <span class="file-loading-indicator">⏳</span>
          )}
          <button class="remove-file" onClick={() => onRemove(i)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
