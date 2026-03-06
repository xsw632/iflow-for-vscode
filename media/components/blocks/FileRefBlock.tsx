import { FileIcon } from "../shared/FileIcon";

interface FileRefBlockProps {
  path: string;
  lineStart?: number;
  lineEnd?: number;
}

export function FileRefBlock({ path, lineStart, lineEnd }: FileRefBlockProps) {
  return (
    <div class="block-file-ref">
      <FileIcon path={path} />
      <span class="file-path">{path}</span>
      {lineStart ? (
        <span class="line-range">
          :{lineStart}
          {lineEnd ? `-${lineEnd}` : ""}
        </span>
      ) : null}
    </div>
  );
}
