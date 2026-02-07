// Webview entry point for IFlow panel

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// Types (duplicated from protocol.ts for webview bundle)
type ConversationMode = 'default' | 'yolo' | 'plan' | 'autoEdit';

const MODELS = [
  'GLM-4.7',
  'DeepSeek-V3.2',
  'iFlow-ROME-30BA3B(Preview)',
  'Qwen3-Coder-Plus',
  'Kimi-K2-Thinking',
  'MiniMax-M2.1',
  'Kimi-K2-0905',
  'Kimi-K2.5'
] as const;

type ModelType = typeof MODELS[number];

type StreamChunk =
  | { chunkType: 'text'; content: string }
  | { chunkType: 'code_start'; language: string; filename?: string }
  | { chunkType: 'code_content'; content: string }
  | { chunkType: 'code_end' }
  | { chunkType: 'tool_start'; name: string; input: Record<string, unknown> }
  | { chunkType: 'tool_output'; content: string }
  | { chunkType: 'tool_end'; status: 'completed' | 'error' }
  | { chunkType: 'thinking_start' }
  | { chunkType: 'thinking_content'; content: string }
  | { chunkType: 'thinking_end' }
  | { chunkType: 'file_ref'; path: string; lineStart?: number; lineEnd?: number }
  | { chunkType: 'error'; message: string }
  | { chunkType: 'warning'; message: string };

type OutputBlock =
  | { type: 'text'; content: string }
  | { type: 'code'; language: string; filename?: string; content: string }
  | { type: 'tool'; name: string; input: Record<string, unknown>; output: string; status: 'running' | 'completed' | 'error' }
  | { type: 'thinking'; content: string; collapsed: boolean }
  | { type: 'file_ref'; path: string; lineStart?: number; lineEnd?: number }
  | { type: 'error'; message: string }
  | { type: 'warning'; message: string };

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  blocks: OutputBlock[];
  attachedFiles: AttachedFile[];
  timestamp: number;
  streaming?: boolean;
}

interface AttachedFile {
  path: string;
  content?: string;
  truncated?: boolean;
}

interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  mode: ConversationMode;
  think: boolean;
  model: ModelType;
  createdAt: number;
  updatedAt: number;
}

interface ConversationState {
  currentConversationId: string | null;
  conversations: Conversation[];
  cliAvailable: boolean;
  cliVersion: string | null;
  isStreaming: boolean;
}

type WebviewMessage =
  | { type: 'pickFiles' }
  | { type: 'listWorkspaceFiles'; query: string }
  | { type: 'readFiles'; paths: string[] }
  | { type: 'clearConversation' }
  | { type: 'newConversation' }
  | { type: 'switchConversation'; conversationId: string }
  | { type: 'deleteConversation'; conversationId: string }
  | { type: 'setMode'; mode: ConversationMode }
  | { type: 'setThink'; enabled: boolean }
  | { type: 'setModel'; model: ModelType }
  | { type: 'sendMessage'; content: string; attachedFiles: AttachedFile[] }
  | { type: 'cancelCurrent' }
  | { type: 'ready' };

type ExtensionMessage =
  | { type: 'pickedFiles'; files: { path: string; name: string }[] }
  | { type: 'workspaceFiles'; files: { path: string; name: string }[] }
  | { type: 'fileContents'; files: AttachedFile[] }
  | { type: 'stateUpdated'; state: ConversationState }
  | { type: 'streamChunk'; chunk: StreamChunk }
  | { type: 'streamEnd' }
  | { type: 'streamError'; error: string };

// Slash commands
const SLASH_COMMANDS = [
  { command: '/', description: 'Show all commands' },
  { command: '/new', description: 'Start a new conversation' },
  { command: '/clear', description: 'Clear current conversation' },
  { command: '/mode', description: 'Change conversation mode' },
  { command: '/think', description: 'Toggle thinking mode' },
  { command: '/model', description: 'Change model' },
  { command: '/help', description: 'Show help' }
];

// Main app class
class IFlowApp {
  private vscode: VsCodeApi;
  private state: ConversationState | null = null;
  private attachedFiles: AttachedFile[] = [];
  private showSlashMenu = false;
  private slashFilter = '';
  private showMentionMenu = false;
  private mentionFilter = '';
  private workspaceFiles: { path: string; name: string }[] = [];
  private faviconUri: string;

  constructor() {
    this.vscode = acquireVsCodeApi();
    this.faviconUri = document.getElementById('app')?.getAttribute('data-favicon-uri') || '';
    this.setupMessageHandler();
    this.render();
    this.vscode.postMessage({ type: 'ready' });
  }

  private setupMessageHandler(): void {
    window.addEventListener('message', (event) => {
      const message = event.data as ExtensionMessage;
      this.handleMessage(message);
    });
  }

  private handleMessage(message: ExtensionMessage): void {
    switch (message.type) {
      case 'stateUpdated':
        this.state = message.state;
        this.render();
        break;

      case 'pickedFiles':
        this.handlePickedFiles(message.files);
        break;

      case 'workspaceFiles':
        this.workspaceFiles = message.files;
        this.renderMentionMenu();
        break;

      case 'fileContents':
        for (const file of message.files) {
          const existing = this.attachedFiles.find(f => f.path === file.path);
          if (existing) {
            existing.content = file.content;
            existing.truncated = file.truncated;
          }
        }
        break;

      case 'streamChunk':
        this.scrollToBottom();
        break;

      case 'streamEnd':
      case 'streamError':
        this.render();
        break;
    }
  }

  private handlePickedFiles(files: { path: string; name: string }[]): void {
    for (const file of files) {
      if (!this.attachedFiles.find(f => f.path === file.path)) {
        this.attachedFiles.push({ path: file.path });
      }
    }
    // Request file contents
    this.vscode.postMessage({
      type: 'readFiles',
      paths: files.map(f => f.path)
    });
    this.renderAttachedFiles();
  }

  private render(): void {
    const app = document.getElementById('app');
    if (!app) return;

    app.innerHTML = `
      <div class="container">
        ${this.renderTopBar()}
        ${this.renderMessages()}
        ${this.renderComposer()}
      </div>
    `;

    this.attachEventListeners();
    this.scrollToBottom();
  }

  private renderTopBar(): string {
    const conversation = this.getCurrentConversation();
    const conversations = this.state?.conversations || [];

    return `
      <div class="top-bar">
        <div class="conversation-selector">
          <select id="conversation-select" class="dropdown">
            ${conversations.map(c => `
              <option value="${c.id}" ${c.id === this.state?.currentConversationId ? 'selected' : ''}>
                ${this.escapeHtml(c.title)}
              </option>
            `).join('')}
            ${conversations.length === 0 ? '<option value="">No conversations</option>' : ''}
          </select>
          <button id="new-conversation-btn" class="icon-btn" title="New Conversation">
            <span class="icon">+</span>
          </button>
        </div>
        <div class="toolbar">
          <select id="mode-select" class="dropdown small">
            <option value="default" ${conversation?.mode === 'default' ? 'selected' : ''}>Default</option>
            <option value="yolo" ${conversation?.mode === 'yolo' ? 'selected' : ''}>YOLO</option>
            <option value="plan" ${conversation?.mode === 'plan' ? 'selected' : ''}>Plan</option>
            <option value="autoEdit" ${conversation?.mode === 'autoEdit' ? 'selected' : ''}>Smart</option>
          </select>
          <label class="toggle-label">
            <input type="checkbox" id="think-toggle" ${conversation?.think ? 'checked' : ''}>
            <span>Think</span>
          </label>
          <select id="model-select" class="dropdown">
            ${MODELS.map(m => `
              <option value="${m}" ${conversation?.model === m ? 'selected' : ''}>${m}</option>
            `).join('')}
          </select>
        </div>
      </div>
    `;
  }

  private renderMessages(): string {
    const conversation = this.getCurrentConversation();
    const cliAvailable = this.state?.cliAvailable ?? false;

    if (!cliAvailable) {
      return `
        <div class="messages">
          <div class="error-callout">
            <span class="icon">⚠</span>
            <div>
              <strong>IFlow SDK connection failed</strong>
              <p>
                Please ensure the iFlow CLI is installed and accessible in your PATH,
                or check the Output panel (IFlow) for details.
              </p>
            </div>
          </div>
        </div>
      `;
    }

    if (!conversation || conversation.messages.length === 0) {
      return `
        <div class="messages">
          <div class="empty-state">
            <div class="logo"><img src="${this.faviconUri}" alt="IFlow" class="logo-icon" /></div>
            <h2>Welcome to IFlow</h2>
            <p>Start a conversation by typing a message below.</p>
            <p class="hint">Use / for commands, @ to mention files</p>
          </div>
        </div>
      `;
    }

    return `
      <div class="messages" id="messages-container">
        ${conversation.messages.map(m => this.renderMessage(m)).join('')}
        ${this.state?.isStreaming ? this.renderPendingIndicator() : ''}
      </div>
    `;
  }

  private renderMessage(message: Message): string {
    const isUser = message.role === 'user';

    return `
      <div class="message ${isUser ? 'user' : 'assistant'}">
        <div class="message-header">
          <span class="role">${isUser ? 'You' : 'IFlow'}</span>
          <span class="timestamp">${this.formatTime(message.timestamp)}</span>
        </div>
        ${message.attachedFiles.length > 0 ? `
          <div class="attached-files-display">
            ${message.attachedFiles.map(f => `
              <span class="file-chip small">${this.getFileName(f.path)}</span>
            `).join('')}
          </div>
        ` : ''}
        <div class="message-content">
          ${message.blocks.map(b => this.renderBlock(b)).join('')}
        </div>
      </div>
    `;
  }

  private renderBlock(block: OutputBlock): string {
    switch (block.type) {
      case 'text':
        return `<div class="block-text">${this.renderMarkdown(block.content)}</div>`;

      case 'code':
        return `
          <div class="block-code">
            <div class="code-header">
              <span class="language">${block.language}${block.filename ? ` - ${block.filename}` : ''}</span>
              <button class="copy-btn" data-content="${this.escapeAttr(block.content)}">Copy</button>
            </div>
            <pre><code>${this.escapeHtml(block.content)}</code></pre>
          </div>
        `;

      case 'tool':
        return `
          <div class="block-tool ${block.status}">
            <div class="tool-header" data-collapsible>
              <span class="tool-icon">${block.status === 'running' ? '⏳' : block.status === 'completed' ? '✓' : '✗'}</span>
              <span class="tool-name">${this.escapeHtml(block.name)}</span>
              <span class="expand-icon">▼</span>
            </div>
            <div class="tool-content collapsed">
              <div class="tool-input">
                <strong>Input:</strong>
                <pre>${this.escapeHtml(JSON.stringify(block.input, null, 2))}</pre>
              </div>
              ${block.output ? `
                <div class="tool-output">
                  <strong>Output:</strong>
                  <pre>${this.escapeHtml(block.output)}</pre>
                </div>
              ` : ''}
            </div>
          </div>
        `;

      case 'thinking':
        return `
          <div class="block-thinking ${block.collapsed ? 'collapsed' : ''}">
            <div class="thinking-header" data-collapsible>
              <span class="thinking-icon">💭</span>
              <span>Thinking...</span>
              <span class="expand-icon">▼</span>
            </div>
            <div class="thinking-content ${block.collapsed ? 'collapsed' : ''}">
              ${this.escapeHtml(block.content)}
            </div>
          </div>
        `;

      case 'file_ref':
        return `
          <div class="block-file-ref">
            <span class="file-icon">📄</span>
            <span class="file-path">${this.escapeHtml(block.path)}</span>
            ${block.lineStart ? `<span class="line-range">:${block.lineStart}${block.lineEnd ? `-${block.lineEnd}` : ''}</span>` : ''}
          </div>
        `;

      case 'error':
        return `
          <div class="block-error">
            <span class="icon">❌</span>
            <span>${this.escapeHtml(block.message)}</span>
          </div>
        `;

      case 'warning':
        return `
          <div class="block-warning">
            <span class="icon">⚠</span>
            <span>${this.escapeHtml(block.message)}</span>
          </div>
        `;
    }
  }

  private renderPendingIndicator(): string {
    return `
      <div class="pending-indicator">
        <div class="bounce-logo"><img src="${this.faviconUri}" alt="IFlow" class="bounce-logo-icon" /></div>
        <span>Scheming...</span>
      </div>
    `;
  }

  private renderComposer(): string {
    return `
      <div class="composer">
        ${this.renderAttachedFilesHtml()}
        <div class="composer-input-row">
          <button id="attach-btn" class="icon-btn" title="Attach files">
            <span class="icon">📎</span>
          </button>
          <div class="input-wrapper">
            <textarea
              id="message-input"
              placeholder="Type a message... (/ for commands, @ for files)"
              rows="1"
            ></textarea>
            ${this.showSlashMenu ? this.renderSlashMenu() : ''}
            ${this.showMentionMenu ? this.renderMentionMenuHtml() : ''}
          </div>
          ${this.state?.isStreaming ? `
            <button id="cancel-btn" class="icon-btn danger" title="Cancel">
              <span class="icon">⏹</span>
            </button>
          ` : `
            <button id="send-btn" class="icon-btn primary" title="Send">
              <span class="icon">➤</span>
            </button>
          `}
        </div>
      </div>
    `;
  }

  private renderAttachedFilesHtml(): string {
    if (this.attachedFiles.length === 0) return '';

    return `
      <div class="attached-files" id="attached-files">
        ${this.attachedFiles.map((f, i) => `
          <div class="file-chip">
            <span class="file-name">${this.getFileName(f.path)}</span>
            <button class="remove-file" data-index="${i}">×</button>
          </div>
        `).join('')}
      </div>
    `;
  }

  private renderSlashMenu(): string {
    const filtered = SLASH_COMMANDS.filter(c =>
      c.command.toLowerCase().includes(this.slashFilter.toLowerCase())
    );

    return `
      <div class="slash-menu" id="slash-menu">
        ${filtered.map(c => `
          <div class="slash-item" data-command="${c.command}">
            <span class="command">${c.command}</span>
            <span class="description">${c.description}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  private renderMentionMenuHtml(): string {
    const filtered = this.workspaceFiles.filter(f =>
      f.name.toLowerCase().includes(this.mentionFilter.toLowerCase()) ||
      f.path.toLowerCase().includes(this.mentionFilter.toLowerCase())
    );

    return `
      <div class="mention-menu" id="mention-menu">
        ${filtered.length === 0 ? '<div class="no-results">No files found</div>' : ''}
        ${filtered.slice(0, 10).map(f => `
          <div class="mention-item" data-path="${this.escapeAttr(f.path)}">
            <span class="file-name">${this.escapeHtml(f.name)}</span>
            <span class="file-path">${this.escapeHtml(f.path)}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  private renderAttachedFiles(): void {
    const container = document.getElementById('attached-files');
    if (container) {
      container.outerHTML = this.renderAttachedFilesHtml();
      this.attachFileRemoveListeners();
    } else {
      const composer = document.querySelector('.composer');
      if (composer && this.attachedFiles.length > 0) {
        const div = document.createElement('div');
        div.innerHTML = this.renderAttachedFilesHtml();
        composer.insertBefore(div.firstElementChild!, composer.firstChild);
        this.attachFileRemoveListeners();
      }
    }
  }

  private renderMentionMenu(): void {
    const existing = document.getElementById('mention-menu');
    if (existing) {
      existing.outerHTML = this.renderMentionMenuHtml();
      this.attachMentionListeners();
    }
  }

  private attachEventListeners(): void {
    // Conversation selector
    const conversationSelect = document.getElementById('conversation-select') as HTMLSelectElement;
    conversationSelect?.addEventListener('change', () => {
      if (conversationSelect.value) {
        this.vscode.postMessage({ type: 'switchConversation', conversationId: conversationSelect.value });
      }
    });

    // New conversation button
    document.getElementById('new-conversation-btn')?.addEventListener('click', () => {
      this.vscode.postMessage({ type: 'newConversation' });
    });

    // Mode selector
    const modeSelect = document.getElementById('mode-select') as HTMLSelectElement;
    modeSelect?.addEventListener('change', () => {
      this.vscode.postMessage({ type: 'setMode', mode: modeSelect.value as ConversationMode });
    });

    // Think toggle
    const thinkToggle = document.getElementById('think-toggle') as HTMLInputElement;
    thinkToggle?.addEventListener('change', () => {
      this.vscode.postMessage({ type: 'setThink', enabled: thinkToggle.checked });
    });

    // Model selector
    const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
    modelSelect?.addEventListener('change', () => {
      this.vscode.postMessage({ type: 'setModel', model: modelSelect.value as ModelType });
    });

    // Attach button
    document.getElementById('attach-btn')?.addEventListener('click', () => {
      this.vscode.postMessage({ type: 'pickFiles' });
    });

    // Send button
    document.getElementById('send-btn')?.addEventListener('click', () => {
      this.sendMessage();
    });

    // Cancel button
    document.getElementById('cancel-btn')?.addEventListener('click', () => {
      this.vscode.postMessage({ type: 'cancelCurrent' });
    });

    // Message input
    const input = document.getElementById('message-input') as HTMLTextAreaElement;
    input?.addEventListener('input', () => {
      this.handleInputChange(input);
      this.autoResizeTextarea(input);
    });

    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (this.showSlashMenu) {
          this.executeSlashCommand();
        } else if (this.showMentionMenu) {
          this.insertMention();
        } else {
          this.sendMessage();
        }
      } else if (e.key === 'Escape') {
        this.showSlashMenu = false;
        this.showMentionMenu = false;
        this.render();
      }
    });

    // Copy buttons
    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const content = (btn as HTMLElement).dataset.content || '';
        navigator.clipboard.writeText(content);
      });
    });

    // Collapsible blocks
    document.querySelectorAll('[data-collapsible]').forEach(header => {
      header.addEventListener('click', () => {
        const content = header.nextElementSibling;
        content?.classList.toggle('collapsed');
      });
    });

    // Slash menu items
    this.attachSlashListeners();

    // Mention menu items
    this.attachMentionListeners();

    // File remove buttons
    this.attachFileRemoveListeners();
  }

  private attachSlashListeners(): void {
    document.querySelectorAll('.slash-item').forEach(item => {
      item.addEventListener('click', () => {
        const command = (item as HTMLElement).dataset.command;
        if (command) {
          this.executeCommand(command);
        }
      });
    });
  }

  private attachMentionListeners(): void {
    document.querySelectorAll('.mention-item').forEach(item => {
      item.addEventListener('click', () => {
        const path = (item as HTMLElement).dataset.path;
        if (path) {
          this.addFileFromMention(path);
        }
      });
    });
  }

  private attachFileRemoveListeners(): void {
    document.querySelectorAll('.remove-file').forEach(btn => {
      btn.addEventListener('click', () => {
        const index = parseInt((btn as HTMLElement).dataset.index || '0', 10);
        this.attachedFiles.splice(index, 1);
        this.renderAttachedFiles();
      });
    });
  }

  private handleInputChange(input: HTMLTextAreaElement): void {
    const value = input.value;
    const cursorPos = input.selectionStart;

    // Check for slash command
    if (value.startsWith('/')) {
      this.showSlashMenu = true;
      this.slashFilter = value;
      this.showMentionMenu = false;
      this.updateSlashMenu();
      return;
    }

    // Check for @ mention
    const textBeforeCursor = value.substring(0, cursorPos);
    const atMatch = textBeforeCursor.match(/@(\S*)$/);
    if (atMatch) {
      this.showMentionMenu = true;
      this.mentionFilter = atMatch[1];
      this.showSlashMenu = false;
      this.vscode.postMessage({ type: 'listWorkspaceFiles', query: this.mentionFilter });
      return;
    }

    this.showSlashMenu = false;
    this.showMentionMenu = false;
  }

  private updateSlashMenu(): void {
    const menu = document.getElementById('slash-menu');
    if (menu) {
      menu.innerHTML = SLASH_COMMANDS
        .filter(c => c.command.toLowerCase().includes(this.slashFilter.toLowerCase()))
        .map(c => `
          <div class="slash-item" data-command="${c.command}">
            <span class="command">${c.command}</span>
            <span class="description">${c.description}</span>
          </div>
        `).join('');
      this.attachSlashListeners();
    }
  }

  private executeSlashCommand(): void {
    const firstItem = document.querySelector('.slash-item') as HTMLElement;
    if (firstItem?.dataset.command) {
      this.executeCommand(firstItem.dataset.command);
    }
  }

  private executeCommand(command: string): void {
    const input = document.getElementById('message-input') as HTMLTextAreaElement;

    switch (command) {
      case '/new':
        this.vscode.postMessage({ type: 'newConversation' });
        break;
      case '/clear':
        this.vscode.postMessage({ type: 'clearConversation' });
        break;
      case '/mode':
        document.getElementById('mode-select')?.focus();
        break;
      case '/think':
        const toggle = document.getElementById('think-toggle') as HTMLInputElement;
        if (toggle) {
          toggle.checked = !toggle.checked;
          this.vscode.postMessage({ type: 'setThink', enabled: toggle.checked });
        }
        break;
      case '/model':
        document.getElementById('model-select')?.focus();
        break;
      case '/help':
        // Show help in chat
        break;
    }

    if (input) {
      input.value = '';
    }
    this.showSlashMenu = false;
    this.render();
  }

  private insertMention(): void {
    const firstItem = document.querySelector('.mention-item') as HTMLElement;
    if (firstItem?.dataset.path) {
      this.addFileFromMention(firstItem.dataset.path);
    }
  }

  private addFileFromMention(path: string): void {
    const input = document.getElementById('message-input') as HTMLTextAreaElement;
    if (!input) return;

    // Remove the @query from input
    const value = input.value;
    const cursorPos = input.selectionStart;
    const textBeforeCursor = value.substring(0, cursorPos);
    const newTextBefore = textBeforeCursor.replace(/@\S*$/, '');
    input.value = newTextBefore + value.substring(cursorPos);

    // Add file to attachments
    if (!this.attachedFiles.find(f => f.path === path)) {
      this.attachedFiles.push({ path });
      this.vscode.postMessage({ type: 'readFiles', paths: [path] });
    }

    this.showMentionMenu = false;
    this.renderAttachedFiles();
    input.focus();
  }

  private sendMessage(): void {
    const input = document.getElementById('message-input') as HTMLTextAreaElement;
    const content = input?.value.trim();

    if (!content && this.attachedFiles.length === 0) return;

    this.vscode.postMessage({
      type: 'sendMessage',
      content: content || '',
      attachedFiles: this.attachedFiles
    });

    // Clear input and attachments
    if (input) {
      input.value = '';
      this.autoResizeTextarea(input);
    }
    this.attachedFiles = [];
    this.renderAttachedFiles();
  }

  private autoResizeTextarea(textarea: HTMLTextAreaElement): void {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
  }

  private scrollToBottom(): void {
    const container = document.getElementById('messages-container');
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }

  private getCurrentConversation(): Conversation | null {
    if (!this.state?.currentConversationId) return null;
    return this.state.conversations.find(c => c.id === this.state?.currentConversationId) || null;
  }

  private getFileName(path: string): string {
    return path.split(/[/\\]/).pop() || path;
  }

  private formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private escapeAttr(text: string): string {
    return text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  private renderMarkdown(text: string): string {
    // Simple markdown rendering
    return this.escapeHtml(text)
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new IFlowApp();
});

// Also initialize immediately if DOM is already loaded
if (document.readyState !== 'loading') {
  new IFlowApp();
}
