import * as vscode from "vscode";
import * as path from "path";
import { ConversationStore } from "./store";
import { AcpClient } from "./acpClient";
import {
  WebviewMessage,
  ExtensionMessage,
  AttachedFile,
  IDEContext,
} from "./protocol";
import { CliStatusService } from "./webview/cliStatusService";
import { PlanModeOrchestrator } from "./webview/planModeOrchestrator";
import { PlanApprovalCoordinator } from "./webview/planApprovalCoordinator";
import { SendMessagePipeline } from "./webview/sendMessagePipeline";
import { buildWebviewHtml } from "./webview/htmlTemplate";
import { routeWebviewMessage } from "./webview/messageRouter";
import { createWebviewMessageHandlers } from "./webview/messageHandler";
import { WorkspaceFileService } from "./webview/workspaceFileService";
import { IDEContextSyncService } from "./webview/ideContextSyncService";
import { FileChangeReviewService } from "./webview/fileChangeReviewService";
import { toAppError } from "./errorUtils";
import {
  DEFAULT_STREAM_RENDER_INTERVAL_MS,
  DEFAULT_WORKSPACE_FILES_LIMIT,
} from "./constants/runtime";
import {
  IDE_CONTEXT_MAX_SELECTION_CHARS,
  IDE_CONTEXT_SELECTION_DEBOUNCE_MS,
} from "./constants/ui";

export interface WebviewHandlerDeps {
  getConfig<T>(key: string, defaultValue: T): T;
  getWorkspaceFolders(): readonly vscode.WorkspaceFolder[] | undefined;
  onDidChangeConfiguration(
    listener: (e: vscode.ConfigurationChangeEvent) => void,
  ): vscode.Disposable;
  onDidChangeWorkspaceFolders(
    listener: (e: vscode.WorkspaceFoldersChangeEvent) => void,
  ): vscode.Disposable;
  findFiles(
    include: string | vscode.GlobPattern,
    exclude?: string | vscode.GlobPattern | null,
    maxResults?: number,
    token?: vscode.CancellationToken,
  ): Thenable<vscode.Uri[]>;
  getWorkspaceFolder(uri: vscode.Uri): vscode.WorkspaceFolder | undefined;
  getActiveTextEditor(): vscode.TextEditor | undefined;
  onDidChangeActiveTextEditor(
    listener: (e: vscode.TextEditor | undefined) => void,
  ): vscode.Disposable;
  onDidChangeTextEditorSelection(
    listener: (e: vscode.TextEditorSelectionChangeEvent) => void,
  ): vscode.Disposable;
  showOpenDialog(
    options?: vscode.OpenDialogOptions,
  ): Thenable<vscode.Uri[] | undefined>;
  showInformationMessage(message: string): Thenable<string | undefined>;
  showErrorMessage(message: string): Thenable<string | undefined>;
  createOutputChannel(name: string): vscode.OutputChannel;
  executeCommand<T>(
    command: string,
    ...rest: unknown[]
  ): Thenable<T | undefined>;
  registerTextDocumentContentProvider(
    scheme: string,
    provider: vscode.TextDocumentContentProvider,
  ): vscode.Disposable;
}

function createDefaultDeps(): WebviewHandlerDeps {
  return {
    getConfig: <T>(key: string, defaultValue: T): T =>
      vscode.workspace.getConfiguration("iflow").get<T>(key, defaultValue),
    getWorkspaceFolders: () => vscode.workspace.workspaceFolders,
    onDidChangeConfiguration: (listener) =>
      vscode.workspace.onDidChangeConfiguration(listener),
    onDidChangeWorkspaceFolders: (listener) =>
      vscode.workspace.onDidChangeWorkspaceFolders(listener),
    findFiles: (include, exclude, maxResults, token) =>
      vscode.workspace.findFiles(include, exclude, maxResults, token),
    getWorkspaceFolder: (uri) => vscode.workspace.getWorkspaceFolder(uri),
    getActiveTextEditor: () => vscode.window.activeTextEditor,
    onDidChangeActiveTextEditor: (listener) =>
      vscode.window.onDidChangeActiveTextEditor(listener),
    onDidChangeTextEditorSelection: (listener) =>
      vscode.window.onDidChangeTextEditorSelection(listener),
    showOpenDialog: (options) => vscode.window.showOpenDialog(options),
    showInformationMessage: (message) =>
      vscode.window.showInformationMessage(message),
    showErrorMessage: (message) => vscode.window.showErrorMessage(message),
    createOutputChannel: (name) => vscode.window.createOutputChannel(name),
    executeCommand: (command, ...rest) =>
      vscode.commands.executeCommand(command, ...rest),
    registerTextDocumentContentProvider: (scheme, provider) =>
      vscode.workspace.registerTextDocumentContentProvider(scheme, provider),
  };
}

/**
 * Shared handler for webview message processing, CLI checking, and HTML generation.
 * Used by both IFlowPanel (independent panel) and IFlowSidebarProvider (sidebar view).
 */
export class WebviewHandler {
  private readonly store: ConversationStore;
  private readonly client: AcpClient;
  private readonly cliStatusService: CliStatusService;
  private readonly planApprovalCoordinator: PlanApprovalCoordinator;
  private readonly sendMessagePipeline: SendMessagePipeline;
  private readonly workspaceFileService: WorkspaceFileService;
  private readonly ideContextSyncService: IDEContextSyncService;
  private readonly fileChangeReviewService: FileChangeReviewService;
  private readonly extensionUri: vscode.Uri;
  private readonly deps: WebviewHandlerDeps;
  private webview: vscode.Webview | null = null;
  private disposables: vscode.Disposable[] = [];
  private selectionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private outputChannel: vscode.OutputChannel | null = null;

  constructor(
    extensionUri: vscode.Uri,
    globalState: vscode.Memento,
    deps: Partial<WebviewHandlerDeps> = {},
  ) {
    this.extensionUri = extensionUri;
    this.deps = { ...createDefaultDeps(), ...deps };
    this.client = new AcpClient();
    this.store = new ConversationStore(globalState, (state) => {
      this.postMessage({ type: "stateUpdated", state });
    });
    this.workspaceFileService = new WorkspaceFileService({
      getConfig: (key, defaultValue) => this.deps.getConfig(key, defaultValue),
      getWorkspaceFolders: () => this.deps.getWorkspaceFolders(),
      getWorkspaceFolder: (uri) => this.deps.getWorkspaceFolder(uri),
      findFiles: (include, exclude, maxResults, token) =>
        this.deps.findFiles(include, exclude, maxResults, token),
      executeCommand: (command, ...rest) =>
        this.deps.executeCommand(command, ...rest),
      debug: (message) => this.debug(message),
    });
    this.ideContextSyncService = new IDEContextSyncService({
      postContextMessage: (context) =>
        this.postMessage({ type: "ideContextChanged", context }),
      debug: (message) => this.debug(message),
    });
    this.fileChangeReviewService = new FileChangeReviewService({
      executeCommand: (command, ...rest) =>
        this.deps.executeCommand(command, ...rest),
      registerTextDocumentContentProvider: (scheme, provider) =>
        this.deps.registerTextDocumentContentProvider(scheme, provider),
      log: (message) => this.debug(message),
    });

    this.cliStatusService = new CliStatusService(
      this.client,
      (result) =>
        this.store.setCliStatus(
          result.version !== null,
          result.version,
          result.diagnostics,
        ),
      (message) => this.debug(message),
    );
    this.planApprovalCoordinator = new PlanApprovalCoordinator(
      new PlanModeOrchestrator(),
    );

    this.sendMessagePipeline = new SendMessagePipeline({
      store: this.store,
      client: this.client,
      postMessage: (message) => this.postMessage(message),
      markCliUnavailable: (diagnostics) => this.markCliUnavailable(diagnostics),
      clearSessionId: () => this.store.clearSessionId(),
      resolveWorkspaceFolder: (conversation) =>
        this.workspaceFileService.resolveWorkspaceFolder(
          conversation,
          this.deps.getActiveTextEditor(),
        ),
      getAllWorkspaceFolderPaths: () =>
        this.workspaceFileService.getAllWorkspaceFolderPaths(),
      getWorkspaceFileList: async (cwd, limit) =>
        this.workspaceFileService.getWorkspaceFileList(cwd, limit),
      shouldIncludeWorkspaceFiles: () =>
        this.deps.getConfig<boolean>("autoIncludeWorkspaceFiles", false),
      getWorkspaceFilesLimit: () =>
        this.deps.getConfig<number>(
          "workspaceFilesLimit",
          DEFAULT_WORKSPACE_FILES_LIMIT,
        ),
      getStreamRenderIntervalMs: () =>
        this.deps.getConfig<number>(
          "streamRenderIntervalMs",
          DEFAULT_STREAM_RENDER_INTERVAL_MS,
        ),
      planApprovalCoordinator: this.planApprovalCoordinator,
      debug: (message) => this.debug(message),
      setSessionId: (sessionId) => this.store.setSessionId(sessionId),
      onRunStart: (context) => {
        this.fileChangeReviewService.startRun(context);
      },
      onChunk: (chunk) => {
        this.fileChangeReviewService.onChunk(chunk);
      },
      onRunFinalize: (context) => {
        const summary = this.fileChangeReviewService.finalizeRun(context);
        this.postMessage({ type: "roundFileChanges", summary });
      },
    });
  }

  /**
   * Bind this handler to a specific webview instance.
   * Call this when the webview becomes available.
   */
  bindWebview(webview: vscode.Webview): void {
    // Cleanup previous bindings
    this.disposeListeners();
    this.webview = webview;

    // Listen for messages from the webview
    const messageDisposable = webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleMessage(message),
    );
    this.disposables.push(messageDisposable);

    // Re-check CLI availability when relevant settings change
    const configDisposable = this.deps.onDidChangeConfiguration(async (e) => {
      if (
        e.affectsConfiguration("iflow.nodePath") ||
        e.affectsConfiguration("iflow.baseUrl") ||
        e.affectsConfiguration("iflow.port") ||
        e.affectsConfiguration("iflow.timeout") ||
        e.affectsConfiguration("iflow.enableCliStream")
      ) {
        await this.client.resetConnection();
        this.client.clearAutoDetectCache();
        this.cliStatusService.invalidateCache();
        await this.checkCliAvailability(true);
      }
    });
    this.disposables.push(configDisposable);

    // Track active editor changes for IDE context
    const editorDisposable = this.deps.onDidChangeActiveTextEditor(() => {
      this.ideContextSyncService.push(IDE_CONTEXT_MAX_SELECTION_CHARS);
    });
    this.disposables.push(editorDisposable);

    // Track selection changes (debounced)
    const selectionDisposable = this.deps.onDidChangeTextEditorSelection(() => {
      if (this.selectionDebounceTimer) {
        clearTimeout(this.selectionDebounceTimer);
      }
      this.selectionDebounceTimer = setTimeout(() => {
        this.selectionDebounceTimer = null;
        this.ideContextSyncService.push(IDE_CONTEXT_MAX_SELECTION_CHARS);
      }, IDE_CONTEXT_SELECTION_DEBOUNCE_MS);
    });
    this.disposables.push(selectionDisposable);

    // Initialize workspace folders and track changes
    this.syncWorkspaceFolders();
    const workspaceFolderDisposable = this.deps.onDidChangeWorkspaceFolders(
      () => {
        this.syncWorkspaceFolders();
      },
    );
    this.disposables.push(workspaceFolderDisposable);
  }

  getStore(): ConversationStore {
    return this.store;
  }

  async handleMessage(message: WebviewMessage): Promise<void> {
    this.debug(`Received webview message: ${message.type}`);
    try {
      await routeWebviewMessage(
        message,
        createWebviewMessageHandlers({
          syncWorkspaceFolders: () => this.syncWorkspaceFolders(),
          postStateUpdated: () => {
            this.postMessage({
              type: "stateUpdated",
              state: this.store.getState(),
            });
          },
          pushIdeContext: () =>
            this.ideContextSyncService.push(IDE_CONTEXT_MAX_SELECTION_CHARS),
          resetCliConnection: async () => {
            await this.client.resetConnection();
            this.client.clearAutoDetectCache();
            this.cliStatusService.invalidateCache();
          },
          checkCliAvailability: async (forceRefresh) =>
            this.checkCliAvailability(forceRefresh),
          pickFiles: async () => this.handlePickFiles(),
          listWorkspaceFiles: async (query) => {
            const files = await this.workspaceFileService.listWorkspaceFiles(
              query,
            );
            this.postMessage({ type: "workspaceFiles", files });
          },
          readFiles: async (paths) => {
            const files = await this.workspaceFileService.readFiles(paths);
            this.postMessage({ type: "fileContents", files });
          },
          openFile: async (targetPath) => {
            try {
              await this.workspaceFileService.openFile(targetPath);
            } catch (error) {
              const messageText = toAppError(error).message;
              this.debug(`Failed to open file ${targetPath}: ${messageText}`);
            }
          },
          newConversation: () => {
            const activeUri = this.deps.getActiveTextEditor()?.document.uri;
            const folder =
              activeUri?.scheme === "file"
                ? this.deps.getWorkspaceFolder(activeUri)
                : undefined;
            this.store.newConversation(folder?.uri.fsPath);
          },
          switchConversation: (conversationId) =>
            this.store.switchConversation(conversationId),
          deleteConversation: (conversationId) =>
            this.store.deleteConversation(conversationId),
          clearConversation: () => this.store.clearCurrentConversation(),
          setMode: (mode) => this.store.setMode(mode),
          setThink: (enabled) => this.store.setThink(enabled),
          setModel: (model) => this.store.setModel(model),
          setWorkspaceFolder: (uri) =>
            this.store.setConversationWorkspaceFolder(uri),
          sendMessage: async (content, attachedFiles, ideContext) =>
            this.handleSendMessage(content, attachedFiles, false, ideContext),
          handleToolApproval: async (msg) => {
            if (msg.outcome === "reject") {
              await this.client.rejectToolCall(msg.requestId);
              await this.client.cancel();
              this.store.batchUpdate(() => {
                this.store.endAssistantMessage();
                this.store.setStreaming(false);
              });
              return;
            }
            await this.client.approveToolCall(msg.requestId, msg.outcome);
          },
          answerQuestions: async (requestId, answers) =>
            this.client.answerQuestions(requestId, answers),
          handleFileChangeAction: async (msg) => {
            try {
              const summary =
                await this.fileChangeReviewService.handleAction(msg);
              this.postMessage({ type: "roundFileChanges", summary });
            } catch (error) {
              const messageText = toAppError(
                error,
                "Failed to handle file change action",
              ).message;
              this.debug(
                `fileChangeAction failed (${msg.action}): ${messageText}`,
              );
              await this.deps.showErrorMessage(messageText);
            }
          },
          handlePlanApproval: async (msg) => {
            if (msg.requestId === -1) {
              this.planApprovalCoordinator.registerSyntheticApproval(
                msg.option,
                msg.feedback,
              );
              if (msg.option === "smart" || msg.option === "default") {
                this.store.setMode(msg.option);
              }
              return;
            }

            if (msg.requestId < 0) {
              this.debug(
                `Ignoring planApproval with invalid requestId=${msg.requestId}`,
              );
              return;
            }

            const approved =
              this.planApprovalCoordinator.registerServerApproval(
                msg.option,
                msg.feedback,
              );
            await this.client.approvePlan(msg.requestId, approved);
          },
          cancelCurrent: async () => {
            await this.client.cancel();
            this.store.setStreaming(false);
            this.store.endAssistantMessage();
            this.planApprovalCoordinator.cancelWait();
          },
        }),
        (unknownType) => {
          this.debug(`Unhandled webview message type: ${unknownType}`);
        },
      );
    } catch (error) {
      const messageText = toAppError(
        error,
        "Unhandled webview message error",
      ).message;
      this.debug(`Message handler failed (${message.type}): ${messageText}`);
      if (this.store.getState().isStreaming) {
        this.store.batchUpdate(() => {
          this.store.endAssistantMessage();
          this.store.setStreaming(false);
        });
      }
      this.postMessage({ type: "streamError", error: messageText });
    }
  }

  private async checkCliAvailability(forceRefresh = false): Promise<void> {
    await this.cliStatusService.check(forceRefresh);
  }

  private async handlePickFiles(): Promise<void> {
    const files = await this.deps.showOpenDialog({
      canSelectMany: true,
      openLabel: "Attach Files",
    });

    if (files) {
      this.debug(`Picked files count: ${files.length}`);
      this.postMessage({
        type: "pickedFiles",
        files: files.map((f) => ({
          path: f.fsPath,
          name: path.basename(f.fsPath),
        })),
      });
    }
  }

  private async handleSendMessage(
    content: string,
    attachedFiles: AttachedFile[],
    silent = false,
    ideContext?: IDEContext,
  ): Promise<void> {
    await this.sendMessagePipeline.execute({
      content,
      attachedFiles,
      silent,
      ideContext,
    });
  }

  private markCliUnavailable(diagnostics: string): void {
    this.cliStatusService.cacheResult({ version: null, diagnostics });
    this.store.setCliStatus(false, null, diagnostics);
  }

  private syncWorkspaceFolders(): void {
    this.workspaceFileService.invalidateCanonicalRootsCache();
    const folders = this.workspaceFileService.syncWorkspaceFolders();
    this.store.setWorkspaceFolders(folders);
    this.debug(`Synced workspace folders: count=${folders.length}`);
  }

  postMessage(message: ExtensionMessage): void {
    this.webview?.postMessage(message);
  }

  getHtmlForWebview(webview: vscode.Webview): string {
    return buildWebviewHtml(this.extensionUri, webview);
  }

  private disposeListeners(): void {
    while (this.disposables.length) {
      const d = this.disposables.pop();
      d?.dispose();
    }
  }

  async dispose(): Promise<void> {
    if (this.selectionDebounceTimer) {
      clearTimeout(this.selectionDebounceTimer);
      this.selectionDebounceTimer = null;
    }
    this.disposeListeners();
    await this.client.dispose();
    this.fileChangeReviewService.dispose();
    this.debug("WebviewHandler disposed");
    this.outputChannel?.dispose();
    this.outputChannel = null;
    this.webview = null;
  }

  private debug(message: string): void {
    if (!this.deps.getConfig<boolean>("debugLogging", false)) {
      return;
    }

    if (!this.outputChannel) {
      this.outputChannel = this.deps.createOutputChannel("IFlow Debug");
    }

    this.outputChannel.appendLine(`[WebviewHandler] ${message}`);
    console.debug(`[IFlow][WebviewHandler] ${message}`);
  }
}
