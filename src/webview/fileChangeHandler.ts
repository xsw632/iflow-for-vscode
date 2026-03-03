import { toAppError } from "../errorUtils";
import type { RoundFileChangeSummary, WebviewMessage } from "../protocol";

type FileChangeActionMessage = Extract<WebviewMessage, { type: "fileChangeAction" }>;

export interface FileChangeActionHandlerContext {
  handleAction(message: FileChangeActionMessage): Promise<RoundFileChangeSummary>;
  postRoundFileChanges(summary: RoundFileChangeSummary): void;
  debug(message: string): void;
  showErrorMessage(message: string): PromiseLike<string | undefined>;
}

export function createFileChangeActionHandler(
  context: FileChangeActionHandlerContext,
): (message: FileChangeActionMessage) => Promise<void> {
  return async (message) => {
    try {
      const summary = await context.handleAction(message);
      context.postRoundFileChanges(summary);
    } catch (error) {
      const messageText = toAppError(
        error,
        "Failed to handle file change action",
      ).message;
      context.debug(`fileChangeAction failed (${message.action}): ${messageText}`);
      await context.showErrorMessage(messageText);
    }
  };
}
