import type {
  AttachedFile,
  ConversationMode,
  IDEContext,
  ModelType,
  WebviewMessage,
} from "../protocol";
import type { MessageHandlers } from "./messageRouter";

export interface WebviewMessageHandlerContext {
  syncWorkspaceFolders(): void;
  postStateUpdated(): void;
  pushIdeContext(): void;
  postCurrentSettings(): void;
  resetCliConnection(): Promise<void>;
  checkCliAvailability(forceRefresh: boolean): Promise<void>;
  pickFiles(): Promise<void>;
  listWorkspaceFiles(query: string): Promise<void>;
  readFiles(paths: string[]): Promise<void>;
  openFile(path: string): Promise<void>;
  newConversation(): void;
  switchConversation(conversationId: string): void;
  deleteConversation(conversationId: string): void;
  clearConversation(): void;
  setMode(mode: ConversationMode): void;
  setThink(enabled: boolean): void;
  setModel(model: ModelType): void;
  setWorkspaceFolder(uri: string): void;
  sendMessage(
    content: string,
    attachedFiles: AttachedFile[],
    ideContext?: IDEContext,
  ): Promise<void>;
  handleToolApproval(
    message: Extract<WebviewMessage, { type: "toolApproval" }>,
  ): Promise<void>;
  answerQuestions(
    requestId: number,
    answers: Record<string, string | string[]>,
  ): Promise<void>;
  handleFileChangeAction(
    message: Extract<WebviewMessage, { type: "fileChangeAction" }>,
  ): Promise<void>;
  handlePlanApproval(
    message: Extract<WebviewMessage, { type: "planApproval" }>,
  ): Promise<void>;
  cancelCurrent(): Promise<void>;
}

export function createWebviewMessageHandlers(
  context: WebviewMessageHandlerContext,
): MessageHandlers {
  return {
    ready: async () => {
      context.syncWorkspaceFolders();
      context.postStateUpdated();
      context.pushIdeContext();
      context.postCurrentSettings();
    },
    recheckCli: async () => {
      await context.resetCliConnection();
      await context.checkCliAvailability(true);
    },
    pickFiles: async () => context.pickFiles(),
    listWorkspaceFiles: async (message) =>
      context.listWorkspaceFiles(message.query),
    readFiles: async (message) => context.readFiles(message.paths),
    openFile: async (message) => context.openFile(message.path),
    newConversation: async () => context.newConversation(),
    switchConversation: async (message) =>
      context.switchConversation(message.conversationId),
    deleteConversation: async (message) =>
      context.deleteConversation(message.conversationId),
    clearConversation: async () => context.clearConversation(),
    setMode: async (message) => context.setMode(message.mode),
    setThink: async (message) => context.setThink(message.enabled),
    setModel: async (message) => context.setModel(message.model),
    setWorkspaceFolder: async (message) =>
      context.setWorkspaceFolder(message.uri),
    sendMessage: async (message) =>
      context.sendMessage(
        message.content,
        message.attachedFiles,
        message.ideContext,
      ),
    toolApproval: async (message) => context.handleToolApproval(message),
    questionAnswer: async (message) =>
      context.answerQuestions(message.requestId, message.answers),
    fileChangeAction: async (message) => context.handleFileChangeAction(message),
    planApproval: async (message) => context.handlePlanApproval(message),
    cancelCurrent: async () => context.cancelCurrent(),
  };
}
