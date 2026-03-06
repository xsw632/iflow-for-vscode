import type { Message } from "../../../src/protocol";
import { getFileName } from "../../fileUtils";
import { FileIcon } from "../shared/FileIcon";
import { BlockRenderer } from "../blocks/BlockRenderer";
import { postMessage } from "../../hooks/usePostMessage";

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function MessageItem({ message }: { message: Message }) {
  const isUser = message.role === "user";

  const handleOpenFile = (path: string) => {
    postMessage({ type: "openFile", path });
  };

  return (
    <div class={`message ${isUser ? "user" : "assistant"}`}>
      <div class="message-header">
        <span class="role">{isUser ? "You" : "IFlow"}</span>
        <span class="timestamp">{formatTime(message.timestamp)}</span>
      </div>
      {message.attachedFiles.length > 0 && (
        <div class="attached-files-display">
          {message.attachedFiles.map((f) => (
            <button
              key={f.path}
              class="file-chip small file-open-btn"
              onClick={() => handleOpenFile(f.path)}
              title={`Open ${getFileName(f.path)}`}
              aria-label={`Open file ${getFileName(f.path)}`}
            >
              <FileIcon path={f.path} />
              <span class="file-name">{getFileName(f.path)}</span>
            </button>
          ))}
        </div>
      )}
      <div class="message-content">
        {message.blocks.map((block, i) => (
          <BlockRenderer key={i} block={block} />
        ))}
      </div>
    </div>
  );
}
