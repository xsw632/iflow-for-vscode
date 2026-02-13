import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ConversationStore } from './store';
import { IFlowClient } from './iflowClient';
import { WebviewMessage, ExtensionMessage, AttachedFile } from './protocol';

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
  private readonly extensionUri: vscode.Uri;
  private webview: vscode.Webview | null = null;
  private disposables: vscode.Disposable[] = [];
  private cliChecked = false;

  constructor(extensionUri: vscode.Uri, globalState: vscode.Memento) {
    this.extensionUri = extensionUri;
    this.client = new IFlowClient();
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
  }

  getStore(): ConversationStore {
    return this.store;
  }

  async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        // Always send current state immediately - no CLI check on startup.
        // CLI availability is checked lazily when user sends a message.
        this.postMessage({ type: 'stateUpdated', state: this.store.getState() });
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

      case 'newConversation':
        this.store.newConversation();
        break;

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

      case 'sendMessage':
        await this.handleSendMessage(message.content, message.attachedFiles);
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

      case 'planApproval':
        if (message.requestId === -1) {
          // Synthetic approval: AI ended without calling exit_plan_mode.
          // Approve → switch to default mode for implementation.
          // Reject → stay in plan mode so user can refine.
          if (message.approved) {
            this.store.setMode('default');
          }
        } else {
          await this.client.approvePlan(message.requestId, message.approved);
        }
        break;

      case 'cancelCurrent':
        await this.client.cancel();
        this.store.setStreaming(false);
        this.store.endAssistantMessage();
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

  private async getWorkspaceFileList(): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return [];
    }

    const excludePattern = '**/node_modules/**,**/.git/**,**/dist/**,**/out/**';
    const files = await vscode.workspace.findFiles('**/*', excludePattern, 200);

    const rootPath = workspaceFolders[0].uri.fsPath;
    return files.map(f => path.relative(rootPath, f.fsPath));
  }

  private async handleSendMessage(content: string, attachedFiles: AttachedFile[]): Promise<void> {
    // Immediately reflect "running" in UI so Enter has instant feedback.
    // Expensive checks (CLI probe/connect) happen after this optimistic state update.
    this.store.batchUpdate(() => {
      this.store.addUserMessage(content, attachedFiles);
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

    const conversation = this.store.getCurrentConversation();
    if (!conversation) return;

    const workspaceFiles = await this.getWorkspaceFileList();

    // Track whether the AI called exit_plan_mode during this run
    let planApprovalEmitted = false;

    await this.client.run(
      {
        prompt: content,
        attachedFiles,
        mode: conversation.mode,
        think: conversation.think,
        model: conversation.model,
        workspaceFiles,
        sessionId: conversation.sessionId
      },
      (chunk) => {
        if (chunk.chunkType === 'plan_approval') {
          planApprovalEmitted = true;
        }
        this.store.appendToAssistantMessage(chunk);
        this.postMessage({ type: 'streamChunk', chunk });
      },
      () => {
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
    this.disposeListeners();
    await this.client.dispose();
    this.webview = null;
  }
}
