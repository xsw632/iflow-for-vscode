import type { ExtensionMessage } from "../../src/protocol";
import { reduceStreamStatus } from "../../src/streamStatusUtils";
import {
  attachedFiles,
  conversationState,
  clearInputFlag,
  ideContext,
  ideContextDismissed,
  isStreaming,
  latestRoundChanges,
  mentionFiles,
  pendingConfirmation,
  pendingPlanApproval,
  pendingQuestion,
  streamStatus,
} from "./signals";
import { postMessage } from "../hooks/usePostMessage";

export function handleExtensionMessage(message: ExtensionMessage): void {
  switch (message.type) {
    case "stateUpdated": {
      const previousId =
        conversationState.value?.currentConversationId ?? null;
      conversationState.value = message.state;
      streamStatus.value = reduceStreamStatus(streamStatus.value, {
        type: "stateUpdated",
        isStreaming: message.state.isStreaming,
      });

      const conversationChanged =
        previousId !== (message.state.currentConversationId ?? null);
      if (conversationChanged) {
        clearInputFlag.value = true;
        attachedFiles.value = [];
      }
      break;
    }

    case "pickedFiles": {
      const existing = new Set(attachedFiles.value.map((f) => f.path));
      const newFiles = message.files
        .filter((f) => !existing.has(f.path))
        .map((f) => ({ path: f.path }));
      if (newFiles.length > 0) {
        attachedFiles.value = [...attachedFiles.value, ...newFiles];
        postMessage({
          type: "readFiles",
          paths: newFiles.map((f) => f.path),
        });
      }
      break;
    }

    case "workspaceFiles":
      mentionFiles.value = message.files;
      break;

    case "fileContents": {
      const contentsMap = new Map(
        message.files.map((f) => [f.path, f]),
      );
      attachedFiles.value = attachedFiles.value.map((f) => {
        const updated = contentsMap.get(f.path);
        return updated ? { ...f, content: updated.content, truncated: updated.truncated } : f;
      });
      break;
    }

    case "roundFileChanges": {
      const previous = latestRoundChanges.value;
      const hadSummary = previous.has(message.summary.conversationId);
      const next = new Map(previous);
      if (message.summary.changedFiles.length === 0) {
        if (!hadSummary) break;
        next.delete(message.summary.conversationId);
      } else {
        next.set(message.summary.conversationId, message.summary);
      }
      latestRoundChanges.value = next;
      break;
    }

    case "streamChunk":
      streamStatus.value = reduceStreamStatus(streamStatus.value, {
        type: "streamChunk",
      });
      if (message.chunk.chunkType === "tool_confirmation") {
        pendingConfirmation.value = {
          requestId: message.chunk.requestId,
          toolName: message.chunk.toolName,
          description: message.chunk.description,
        };
      } else if (message.chunk.chunkType === "user_question") {
        pendingQuestion.value = {
          requestId: message.chunk.requestId,
          questions: message.chunk.questions,
        };
      } else if (message.chunk.chunkType === "plan_approval") {
        pendingPlanApproval.value = {
          requestId: message.chunk.requestId,
          plan: message.chunk.plan,
        };
      }
      break;

    case "streamStatus":
      streamStatus.value = reduceStreamStatus(streamStatus.value, message);
      break;

    case "streamEnd":
    case "streamError":
      if (conversationState.value && isStreaming.value) {
        conversationState.value = {
          ...conversationState.value,
          isStreaming: false,
        };
      }
      pendingConfirmation.value = null;
      pendingQuestion.value = null;
      pendingPlanApproval.value = null;
      streamStatus.value = reduceStreamStatus(streamStatus.value, {
        type: message.type,
      });
      break;

    case "ideContextChanged": {
      const previous = ideContext.value;
      const next = message.context;
      const prev = ideContextDismissed.value;

      const activeFileChanged =
        previous.activeFile?.path !== next.activeFile?.path;
      const selectionChanged =
        previous.selection?.filePath !== next.selection?.filePath ||
        previous.selection?.lineStart !== next.selection?.lineStart ||
        previous.selection?.lineEnd !== next.selection?.lineEnd ||
        previous.selection?.text !== next.selection?.text;

      if (activeFileChanged || selectionChanged) {
        ideContextDismissed.value = {
          activeFile: activeFileChanged ? false : prev.activeFile,
          selection: selectionChanged ? false : prev.selection,
        };
      }
      ideContext.value = next;
      break;
    }
  }
}
