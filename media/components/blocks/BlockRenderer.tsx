import type { OutputBlock } from "../../../src/protocol";
import { TextBlock } from "./TextBlock";
import { CodeBlock } from "./CodeBlock";
import { ToolBlock } from "./ToolBlock";
import { ThinkingBlock } from "./ThinkingBlock";
import { FileRefBlock } from "./FileRefBlock";
import { PlanBlock } from "./PlanBlock";
import { ErrorBlock } from "./ErrorBlock";
import { WarningBlock } from "./WarningBlock";

export function BlockRenderer({ block }: { block: OutputBlock }) {
  switch (block.type) {
    case "text":
      return <TextBlock content={block.content} />;
    case "code":
      return (
        <CodeBlock
          language={block.language}
          filename={block.filename}
          content={block.content}
        />
      );
    case "tool":
      return <ToolBlock block={block} />;
    case "thinking":
      return <ThinkingBlock content={block.content} collapsed={block.collapsed} />;
    case "file_ref":
      return (
        <FileRefBlock
          path={block.path}
          lineStart={block.lineStart}
          lineEnd={block.lineEnd}
        />
      );
    case "plan":
      return <PlanBlock entries={block.entries} />;
    case "error":
      return <ErrorBlock message={block.message} />;
    case "warning":
      return <WarningBlock message={block.message} />;
  }
}
