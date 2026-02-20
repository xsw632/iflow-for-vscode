import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ConversationStore } from './store';
import { IFlowClient } from './iflowClient';
import { AuthService } from './authService';
import { WebviewMessage, ExtensionMessage, AttachedFile, IDEContext, Conversation } from './protocol';

interface CliAvailabilityResult {
  version: string | null;
  diagnostics: string;
}

/**
 * Shared handler for webview message processing, CLI checking, and HTML generation.
 * Used by both IFlowPanel (independent panel) and IFlowSidebarProvider (sidebar view).
 */
export class WebviewHandler {
  private static readonly CLI_CHECK_SUCCESS_TTL_MS = 2 * 60 * 1000;
  private static readonly CLI_CHECK_FAILURE_TTL_MS = 15 * 1000;
  private static sharedCliCheckCache: { result: CliAvailabilityResult; checkedAt: number } | null = null;
  private static sharedCliCheckInFlight: Promise<CliAvailabilityResult> | null = null;

  private readonly store: ConversationStore;
  private readonly client: IFlowClient;
  private readonly authService: AuthService;
  private readonly extensionUri: vscode.Uri;
  private webview: vscode.Webview | null = null;
  private disposables: vscode.Disposable[] = [];
  private cliChecked = false;
  private planApprovedMode: 'smart' | 'default' | null = null;
  private planFeedbackText: string | null = null;
  private selectionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SELECTION_DEBOUNCE_MS = 300;
  private static readonly MAX_SELECTION_CHARS = 5000;

  constructor(extensionUri: vscode.Uri, globalState: vscode.Memento) {
    this.extensionUri = extensionUri;
    this.client = new IFlowClient();
    this.authService = new AuthService();
    this.store = new ConversationStore(globalState, (state) => {
      this.postMessage({ type: 'stateUpdated', state });
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
      (message: WebviewMessage) => this.handleMessage(message)
    );
    this.disposables.push(messageDisposable);

    // Re-check CLI availability when relevant settings change
    const configDisposable = vscode.workspace.onDidChangeConfiguration(
      async (e) => {
        if (e.affectsConfiguration('iflow.nodePath') ||
            e.affectsConfiguration('iflow.baseUrl') ||
            e.affectsConfiguration('iflow.port') ||
            e.affectsConfiguration('iflow.timeout')) {
          await this.client.dispose();
          WebviewHandler.invalidateSharedCliCheck();
          this.cliChecked = false;
          await this.checkCliAvailability(true);
        }
      }
    );
    this.disposables.push(configDisposable);

    // Track active editor changes for IDE context
    const editorDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
      this.pushIDEContext();
    });
    this.disposables.push(editorDisposable);

    // Track selection changes (debounced)
    const selectionDisposable = vscode.window.onDidChangeTextEditorSelection(() => {
      if (this.selectionDebounceTimer) {
        clearTimeout(this.selectionDebounceTimer);
      }
      this.selectionDebounceTimer = setTimeout(() => {
        this.selectionDebounceTimer = null;
        this.pushIDEContext();
      }, WebviewHandler.SELECTION_DEBOUNCE_MS);
    });
    this.disposables.push(selectionDisposable);

    // Initialize workspace folders and track changes
    this.syncWorkspaceFolders();
    const workspaceFolderDisposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.syncWorkspaceFolders();
    });
    this.disposables.push(workspaceFolderDisposable);
  }

  getStore(): ConversationStore {
    return this.store;
  }

  async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        // Always send current state immediately - no CLI check on startup.
        // CLI availability is checked lazily when user sends a message.
        this.syncWorkspaceFolders();
        this.postMessage({ type: 'stateUpdated', state: this.store.getState() });
        this.pushIDEContext();
        break;

      case 'recheckCli':
        await this.client.dispose();
        this.client.clearAutoDetectCache();
        WebviewHandler.invalidateSharedCliCheck();
        this.cliChecked = false;
        await this.checkCliAvailability(true);
        break;

      case 'pickFiles':
        await this.handlePickFiles();
        break;

      case 'listWorkspaceFiles':
        await this.handleListWorkspaceFiles(message.query);
        break;

      case 'readFiles':
        await this.handleReadFiles(message.paths);
        break;

      case 'openFile':
        await this.handleOpenFile(message.path);
        break;

      case 'newConversation': {
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        const folder = activeUri?.scheme === 'file'
          ? vscode.workspace.getWorkspaceFolder(activeUri)
          : undefined;
        this.store.newConversation(folder?.uri.fsPath);
        break;
      }

      case 'switchConversation':
        this.store.switchConversation(message.conversationId);
        break;

      case 'deleteConversation':
        this.store.deleteConversation(message.conversationId);
        break;

      case 'clearConversation':
        this.store.clearCurrentConversation();
        break;

      case 'setMode':
        this.store.setMode(message.mode);
        break;

      case 'setThink':
        this.store.setThink(message.enabled);
        break;

      case 'setModel':
        this.store.setModel(message.model);
        break;

      case 'setWorkspaceFolder':
        this.store.setConversationWorkspaceFolder(message.uri);
        break;

      case 'sendMessage':
        await this.handleSendMessage(message.content, message.attachedFiles, false, message.ideContext);
        break;

      case 'toolApproval':
        if (message.outcome === 'reject') {
          await this.client.rejectToolCall(message.requestId);
          // Terminate the entire conversation, equivalent to pressing stop
          await this.client.cancel();
          this.store.batchUpdate(() => {
            this.store.endAssistantMessage();
            this.store.setStreaming(false);
          });
        } else {
          await this.client.approveToolCall(message.requestId, message.outcome);
        }
        break;

      case 'questionAnswer':
        await this.client.answerQuestions(message.requestId, message.answers);
        break;

      case 'planApproval': {
        const isApproved = message.option === 'smart' || message.option === 'default';
        if (message.requestId === -1) {
          // Synthetic approval: AI ended without calling exit_plan_mode.
          if (isApproved) {
            this.store.setMode(message.option as 'smart' | 'default');
          } else if (message.option === 'feedback' && message.feedback) {
            this.planFeedbackText = message.feedback;
          }
        } else {
          if (isApproved) {
            this.planApprovedMode = message.option as 'smart' | 'default';
          } else if (message.option === 'feedback' && message.feedback) {
            this.planFeedbackText = message.feedback;
          }
          await this.client.approvePlan(message.requestId, isApproved);
        }
        break;
      }

      case 'cancelCurrent':
        await this.client.cancel();
        this.store.setStreaming(false);
        this.store.endAssistantMessage();
        break;

      case 'startAuth':
        await this.handleStartAuth();
        break;
    }
  }

  private static invalidateSharedCliCheck(): void {
    this.sharedCliCheckCache = null;
    this.sharedCliCheckInFlight = null;
  }

  private static cacheCliCheckResult(result: CliAvailabilityResult): void {
    this.sharedCliCheckCache = { result, checkedAt: Date.now() };
  }

  private static isSharedCliCheckFresh(): boolean {
    if (!this.sharedCliCheckCache) {
      return false;
    }

    const ttl = this.sharedCliCheckCache.result.version !== null
      ? this.CLI_CHECK_SUCCESS_TTL_MS
      : this.CLI_CHECK_FAILURE_TTL_MS;
    return Date.now() - this.sharedCliCheckCache.checkedAt < ttl;
  }

  private async getSharedCliAvailability(forceRefresh = false): Promise<CliAvailabilityResult> {
    if (forceRefresh) {
      WebviewHandler.invalidateSharedCliCheck();
    }

    if (WebviewHandler.isSharedCliCheckFresh() && WebviewHandler.sharedCliCheckCache) {
      return WebviewHandler.sharedCliCheckCache.result;
    }

    if (WebviewHandler.sharedCliCheckInFlight) {
      return WebviewHandler.sharedCliCheckInFlight;
    }

    WebviewHandler.sharedCliCheckInFlight = this.client.checkAvailability()
      .then((result) => {
        WebviewHandler.cacheCliCheckResult(result);
        return result;
      })
      .finally(() => {
        WebviewHandler.sharedCliCheckInFlight = null;
      });

    return WebviewHandler.sharedCliCheckInFlight;
  }

  private async checkCliAvailability(forceRefresh = false): Promise<void> {
    const result = await this.getSharedCliAvailability(forceRefresh);
    this.store.setCliStatus(result.version !== null, result.version, result.diagnostics);
  }

  private async handleStartAuth(): Promise<void> {
    try {
      await this.authService.startLogin();
      vscode.window.showInformationMessage('iFlow: Login successful');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`iFlow login failed: ${msg}`);
    }
  }

  private async handlePickFiles(): Promise<void> {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach Files'
    });

    if (files) {
      this.postMessage({
        type: 'pickedFiles',
        files: files.map(f => ({
          path: f.fsPath,
          name: path.basename(f.fsPath)
        }))
      });
    }
  }

  private async handleListWorkspaceFiles(query: string): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      this.postMessage({ type: 'workspaceFiles', files: [] });
      return;
    }

    const pattern = query ? `**/*${query}*` : '**/*';
    const excludePattern = '**/node_modules/**,**/.git/**,**/dist/**,**/out/**';

    const files = await vscode.workspace.findFiles(pattern, excludePattern, 50);

    this.postMessage({
      type: 'workspaceFiles',
      files: files.map(f => ({
        path: f.fsPath,
        name: path.basename(f.fsPath)
      }))
    });
  }

  private async handleReadFiles(paths: string[]): Promise<void> {
    const maxBytes = vscode.workspace.getConfiguration('iflow').get<number>('maxFileBytes', 80000);
    const files: AttachedFile[] = [];

    for (const filePath of paths) {
      try {
        const stat = await fs.promises.stat(filePath);
        const truncated = stat.size > maxBytes;

        let content: string;
        if (truncated) {
          const buffer = Buffer.alloc(maxBytes);
          const fd = await fs.promises.open(filePath, 'r');
          await fd.read(buffer, 0, maxBytes, 0);
          await fd.close();
          content = buffer.toString('utf-8');
        } else {
          content = await fs.promises.readFile(filePath, 'utf-8');
        }

        files.push({ path: filePath, content, truncated });
      } catch {
        files.push({ path: filePath, content: '[Error reading file]', truncated: false });
      }
    }

    this.postMessage({ type: 'fileContents', files });
  }

  private async handleOpenFile(filePath: string): Promise<void> {
    try {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
    } catch {
      // no-op: opening preview is best effort
    }
  }

  private async getWorkspaceFileList(cwd?: string): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return [];
    }

    const excludePattern = '**/node_modules/**,**/.git/**,**/dist/**,**/out/**';
    const files = await vscode.workspace.findFiles('**/*', excludePattern, 200);

    const rootPath = cwd ?? workspaceFolders[0].uri.fsPath;

    // In multi-root, prefix files from non-active folders with folder name
    if (workspaceFolders.length > 1) {
      return files.map(f => {
        const folder = vscode.workspace.getWorkspaceFolder(f);
        if (folder && folder.uri.fsPath === rootPath) {
          return path.relative(rootPath, f.fsPath);
        }
        return `[${folder?.name ?? 'unknown'}] ${path.relative(folder?.uri.fsPath ?? '', f.fsPath)}`;
      });
    }

    return files.map(f => path.relative(rootPath, f.fsPath));
  }

  private async handleSendMessage(content: string, attachedFiles: AttachedFile[], silent = false, ideContext?: IDEContext): Promise<void> {
    // Immediately reflect "running" in UI so Enter has instant feedback.
    // Expensive checks (CLI probe/connect) happen after this optimistic state update.
    this.store.batchUpdate(() => {
      if (!silent) {
        this.store.addUserMessage(content, attachedFiles);
      }
      this.store.startAssistantMessage();
      this.store.setStreaming(true);
    });

    // Lazy check: verify CLI availability on first send (or after previous failure)
    if (!this.cliChecked) {
      await this.checkCliAvailability();
      this.cliChecked = true;
      if (!this.store.getState().cliAvailable) {
        const error = 'IFlow SDK is not available. Please ensure iFlow CLI is installed and accessible in your PATH.';
        this.store.batchUpdate(() => {
          this.store.appendToAssistantMessage({ chunkType: 'error', message: error });
          this.store.endAssistantMessage();
          this.store.setStreaming(false);
        });
        this.postMessage({ type: 'streamError', error });
        this.cliChecked = false; // retry on next send
        return;
      }
    }

    // Refresh OAuth token if near expiry (non-blocking: if not logged in, skip)
    await this.authService.ensureValidToken();

    const conversation = this.store.getCurrentConversation();
    if (!conversation) return;

    // Resolve workspace folder for this conversation
    const cwd = this.resolveWorkspaceFolder(conversation);
    if (cwd && !conversation.workspaceFolderUri) {
      this.store.setConversationWorkspaceFolder(cwd);
    }
    const fileAllowedDirs = this.getAllWorkspaceFolderPaths();

    const workspaceFiles = await this.getWorkspaceFileList(cwd);

    // Track whether the AI called exit_plan_mode during this run
    let planApprovalEmitted = false;
    let runSucceeded = false;
    this.planApprovedMode = null;
    this.planFeedbackText = null;

    await this.client.run(
      {
        prompt: content,
        attachedFiles,
        mode: conversation.mode,
        think: conversation.think,
        model: conversation.model,
        workspaceFiles,
        sessionId: conversation.sessionId,
        ideContext,
        cwd,
        fileAllowedDirs
      },
      (chunk) => {
        if (chunk.chunkType === 'plan_approval') {
          planApprovalEmitted = true;
        }
        this.store.appendToAssistantMessage(chunk);
        this.postMessage({ type: 'streamChunk', chunk });
      },
      () => {
        runSucceeded = true;
        // Batch: end assistant + stop streaming → single stateUpdated
        this.store.batchUpdate(() => {
          this.store.endAssistantMessage();
          this.store.setStreaming(false);
        });
        this.postMessage({ type: 'streamEnd' });

        // In plan mode, if the AI ended its turn without calling exit_plan_mode,
        // show a synthetic plan approval UI so the user can approve/reject.
        if (conversation.mode === 'plan' && !planApprovalEmitted) {
          this.postMessage({
            type: 'streamChunk',
            chunk: {
              chunkType: 'plan_approval',
              requestId: -1,
              plan: '',
            }
          });
        }
      },
      (error) => {
        // Mark CLI as unavailable on connection errors so next send retries check
        if (error.includes('connect') || error.includes('ECONNREFUSED') || error.includes('not found') || error.includes('not available')) {
          WebviewHandler.cacheCliCheckResult({ version: null, diagnostics: error });
          this.store.setCliStatus(false, null, error);
          this.cliChecked = false;
        }
        // Batch: append error + end assistant + stop streaming → single stateUpdated
        this.store.batchUpdate(() => {
          this.store.appendToAssistantMessage({ chunkType: 'error', message: error });
          this.store.endAssistantMessage();
          this.store.setStreaming(false);
        });
        this.postMessage({ type: 'streamError', error });
      }
    ).then((returnedSessionId) => {
      if (returnedSessionId) {
        this.store.setSessionId(returnedSessionId);
      }
    });

    // After a plan run completes, handle the user's plan approval choice.
    if (conversation.mode === 'plan' && runSucceeded) {
      if (this.planApprovedMode) {
        // User chose "Yes, smart mode" or "Yes, manual approval" → execute
        const targetMode = this.planApprovedMode;
        this.planApprovedMode = null;
        this.store.setMode(targetMode);
        await this.handleSendMessage(
          '<system-reminder>\nPlan mode has been deactivated. The user approved the plan. You are now in execution mode. You may now freely use all tools including write_file, edit_file, run_shell_command, and other modification tools. Please proceed with the implementation.\n</system-reminder>',
          [],
          true
        );
      } else if (this.planFeedbackText) {
        // User chose "Tell iFlow what to do instead" → send feedback in plan mode
        const feedback = this.planFeedbackText;
        this.planFeedbackText = null;
        await this.handleSendMessage(feedback, []);
      }
    }
  }

  private syncWorkspaceFolders(): void {
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => ({
      uri: f.uri.fsPath,
      name: f.name,
    }));
    this.store.setWorkspaceFolders(folders);
  }

  private resolveWorkspaceFolder(conversation: Conversation): string | undefined {
    const allFolders = vscode.workspace.workspaceFolders;
    if (!allFolders || allFolders.length === 0) {
      return undefined;
    }

    // Priority 1: Conversation's explicit workspace folder (if still valid)
    if (conversation.workspaceFolderUri) {
      const stillExists = allFolders.some(f => f.uri.fsPath === conversation.workspaceFolderUri);
      if (stillExists) {
        return conversation.workspaceFolderUri;
      }
    }

    // Priority 2: Folder containing the active editor file
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.uri.scheme === 'file') {
      const folder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
      if (folder) {
        return folder.uri.fsPath;
      }
    }

    // Priority 3: First workspace folder
    return allFolders[0].uri.fsPath;
  }

  private getAllWorkspaceFolderPaths(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
  }

  private pushIDEContext(): void {
    const editor = vscode.window.activeTextEditor;
    const context: IDEContext = { activeFile: null, selection: null };

    if (editor && editor.document.uri.scheme === 'file') {
      const filePath = editor.document.uri.fsPath;
      const fileName = path.basename(filePath);
      context.activeFile = { path: filePath, name: fileName };

      const selection = editor.selection;
      if (!selection.isEmpty) {
        const text = editor.document.getText(selection);
        const cappedText = text.length > WebviewHandler.MAX_SELECTION_CHARS
          ? text.substring(0, WebviewHandler.MAX_SELECTION_CHARS)
          : text;
        context.selection = {
          filePath,
          fileName,
          text: cappedText,
          lineStart: selection.start.line + 1,
          lineEnd: selection.end.line + 1,
        };
      }
    }

    this.postMessage({ type: 'ideContextChanged', context });
  }

  postMessage(message: ExtensionMessage): void {
    this.webview?.postMessage(message);
  }

  getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'styles.css')
    );
    const faviconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'iflow_favicon.svg')
    );

    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <link href="${styleUri}" rel="stylesheet">
    <title>IFlow</title>
</head>
<body>
    <div id="app" data-favicon-uri="${faviconUri}"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
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
    this.authService.dispose();
    this.webview = null;
  }
}
