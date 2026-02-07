import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ConversationStore } from './store';
import { IFlowClient } from './iflowClient';
import { WebviewMessage, ExtensionMessage, AttachedFile } from './protocol';

export class IFlowPanel {
  public static currentPanel: IFlowPanel | undefined;
  private static readonly viewType = 'iflowPanel';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly store: ConversationStore;
  private readonly client: IFlowClient;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri, globalState: vscode.Memento): void {
    // If we already have a panel, show it
    if (IFlowPanel.currentPanel) {
      IFlowPanel.currentPanel.panel.reveal();
      return;
    }

    // Otherwise, create a new panel beside the current editor (right side)
    const panel = vscode.window.createWebviewPanel(
      IFlowPanel.viewType,
      'IFlow',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        enableCommandUris: ['workbench.action.openSettings'],
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'dist'),
          vscode.Uri.joinPath(extensionUri, 'media')
        ]
      }
    );

    IFlowPanel.currentPanel = new IFlowPanel(panel, extensionUri, globalState);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    globalState: vscode.Memento
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.client = new IFlowClient();

    // Initialize store with state change callback
    this.store = new ConversationStore(globalState, (state) => {
      this.postMessage({ type: 'stateUpdated', state });
    });

    // Set the webview's initial html content
    this.panel.webview.html = this.getHtmlForWebview();

    // Listen for when the panel is disposed
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Re-check CLI availability when relevant settings change
    vscode.workspace.onDidChangeConfiguration(
      async (e) => {
        if (e.affectsConfiguration('iflow.nodePath') ||
            e.affectsConfiguration('iflow.baseUrl') ||
            e.affectsConfiguration('iflow.port') ||
            e.affectsConfiguration('iflow.timeout')) {
          // Stop existing managed process if settings changed
          await this.client.dispose();
          await this.checkCliAvailability();
        }
      },
      null,
      this.disposables
    );

    // Handle messages from the webview
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleMessage(message),
      null,
      this.disposables
    );
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.checkCliAvailability();
        this.postMessage({ type: 'stateUpdated', state: this.store.getState() });
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

      case 'cancelCurrent':
        await this.client.cancel();
        this.store.setStreaming(false);
        this.store.endAssistantMessage();
        break;
    }
  }

  private async checkCliAvailability(): Promise<void> {
    const version = await this.client.checkAvailability();
    this.store.setCliStatus(version !== null, version);
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

  private async handleSendMessage(content: string, attachedFiles: AttachedFile[]): Promise<void> {
    if (!this.store.getState().cliAvailable) {
      this.postMessage({ type: 'streamError', error: 'IFlow SDK is not available. Please ensure iFlow CLI is installed.' });
      return;
    }

    // Add user message
    this.store.addUserMessage(content, attachedFiles);

    // Start assistant message
    this.store.startAssistantMessage();
    this.store.setStreaming(true);

    const conversation = this.store.getCurrentConversation();
    if (!conversation) return;

    await this.client.run(
      {
        prompt: content,
        attachedFiles,
        mode: conversation.mode,
        think: conversation.think,
        model: conversation.model
      },
      (chunk) => {
        this.store.appendToAssistantMessage(chunk);
        this.postMessage({ type: 'streamChunk', chunk });
      },
      () => {
        this.store.endAssistantMessage();
        this.store.setStreaming(false);
        this.postMessage({ type: 'streamEnd' });
      },
      (error) => {
        this.store.endAssistantMessage();
        this.store.setStreaming(false);
        this.postMessage({ type: 'streamError', error });
      }
    );
  }

  private postMessage(message: ExtensionMessage): void {
    this.panel.webview.postMessage(message);
  }

  private getHtmlForWebview(): string {
    const webview = this.panel.webview;

    // Get URIs for resources
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'styles.css')
    );
    const faviconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'iflow_favicon.svg')
    );

    // Use a nonce to only allow specific scripts to be run
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

  public dispose(): void {
    IFlowPanel.currentPanel = undefined;

    // Full cleanup: disconnect SDK and stop managed iFlow process (fire-and-forget since dispose is sync)
    this.client.dispose().catch(() => {});

    // Clean up resources
    this.panel.dispose();

    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}
