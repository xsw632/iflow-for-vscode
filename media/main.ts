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
  | { chunkType: 'tool_start'; name: string; input: Record<string, unknown>; label?: string }
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
  | { type: 'tool'; name: string; input: Record<string, unknown>; output: string; status: 'running' | 'completed' | 'error'; label?: string }
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
  cliDiagnostics: string | null;
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
  | { type: 'recheckCli' }
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

  private showConversationPanel = false;
  private conversationSearch = '';
  private showModeMenu = false;
  private slashSelectedIndex = 0;
  private slashMenuMode: 'commands' | 'models' | 'modes' = 'commands';

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
      case 'stateUpdated': {
        const previousConversationId = this.state?.currentConversationId ?? null;
        const wasStreaming = this.state?.isStreaming ?? false;
        this.state = message.state;
        const conversationChanged = previousConversationId !== (this.state.currentConversationId ?? null);
        if (this.state.isStreaming && wasStreaming) {
          // During streaming, only update the last message instead of full DOM rebuild
          this.updateStreamingContent();
        } else {
          // Only smooth-scroll when switching/new conversation.
          this.render(conversationChanged);
        }
        break;
      }

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
        this.renderAttachedFiles();
        break;

      case 'streamChunk':
        // Streaming updates are handled by stateUpdated to avoid duplicate scroll work.
        break;

      case 'streamEnd':
      case 'streamError':
        // No render() needed here — the stateUpdated with isStreaming=false
        // already triggers a full render.
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

  private render(smoothScrollToBottom = false): void {
    const app = document.getElementById('app');
    if (!app) return;

    // Hide during DOM rebuild to prevent visible scroll-from-top flash
    app.style.visibility = 'hidden';

    app.innerHTML = `
      <div class="container">
        ${this.renderTopBar()}
        ${this.renderMessages()}
        ${this.renderComposer()}
      </div>
    `;

    this.attachEventListeners();
    this.scrollToBottom(smoothScrollToBottom);

    // Restore visibility after scroll position is set
    requestAnimationFrame(() => {
      app.style.visibility = 'visible';
    });
  }

  /**
   * Incremental update during streaming: only update the last assistant message
   * and the pending indicator, avoiding a full DOM rebuild.
   */
  private updateStreamingContent(): void {
    const conversation = this.getCurrentConversation();
    if (!conversation) {
      this.render();
      return;
    }

    const container = document.getElementById('messages-container');
    if (!container) {
      this.render();
      return;
    }

    const messages = conversation.messages;
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== 'assistant') {
      this.render();
      return;
    }

    // Update the last assistant message content
    const msgElements = container.querySelectorAll('.message');
    const lastMsgEl = msgElements[msgElements.length - 1];
    if (!lastMsgEl || !lastMsgEl.classList.contains('assistant')) {
      this.render();
      return;
    }

    const contentEl = lastMsgEl.querySelector('.message-content');
    if (contentEl) {
      contentEl.innerHTML = lastMsg.blocks.map(b => this.renderBlock(b)).join('');

      // Re-attach collapsible listeners for this message only
      lastMsgEl.querySelectorAll('[data-collapsible]').forEach(header => {
        header.addEventListener('click', () => {
          const next = header.nextElementSibling;
          next?.classList.toggle('collapsed');
        });
      });

      // Re-attach copy button listeners for this message only
      lastMsgEl.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const copyContent = (btn as HTMLElement).dataset.content || '';
          navigator.clipboard.writeText(copyContent);
        });
      });
    }

    // Update pending indicator
    const existingIndicator = container.querySelector('.pending-indicator');
    if (this.state?.isStreaming) {
      if (!existingIndicator) {
        container.insertAdjacentHTML('beforeend', this.renderPendingIndicator());
      }
    } else {
      existingIndicator?.remove();
    }

    this.scrollToBottom();
  }

  // Top Bar - conversation selector (left) + new chat button (right)
  private renderTopBar(): string {
    const conversations = this.state?.conversations || [];
    const current = this.getCurrentConversation();
    const title = current ? this.escapeHtml(current.title) : 'No conversations';

    return `
      <div class="top-bar">
        <div class="conversation-selector">
          <button id="conversation-trigger" class="conversation-trigger" title="Switch conversation">
            <span>${title}</span>
            <span class="chevron">▼</span>
          </button>
          ${this.renderConversationPanel(conversations)}
        </div>
        <div class="toolbar">
           <button id="new-conversation-top-btn" class="icon-btn" title="New Chat">
             <span class="icon">+</span>
           </button>
        </div>
      </div>
    `;
  }

  private renderConversationPanel(conversations: Conversation[]): string {
    const filtered = conversations.filter(c =>
      this.conversationSearch === '' ||
      c.title.toLowerCase().includes(this.conversationSearch.toLowerCase())
    );

    // Group by date
    const now = Date.now();
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const yesterdayStart = todayStart - 86400000;

    const groups: { label: string; items: Conversation[] }[] = [];
    const today: Conversation[] = [];
    const yesterday: Conversation[] = [];
    const earlier: Conversation[] = [];

    for (const c of filtered) {
      if (c.updatedAt >= todayStart) {
        today.push(c);
      } else if (c.updatedAt >= yesterdayStart) {
        yesterday.push(c);
      } else {
        earlier.push(c);
      }
    }

    if (today.length > 0) groups.push({ label: 'Today', items: today });
    if (yesterday.length > 0) groups.push({ label: 'Yesterday', items: yesterday });
    if (earlier.length > 0) groups.push({ label: 'Earlier', items: earlier });

    return `
      <div class="conversation-panel ${this.showConversationPanel ? '' : 'hidden'}" id="conversation-panel">
        <div class="conversation-panel-search">
          <input type="text" id="conversation-search" placeholder="Search sessions..." value="${this.escapeAttr(this.conversationSearch)}" />
        </div>
        <div class="conversation-panel-list">
          ${groups.length === 0 ? '<div class="conversation-panel-empty">No conversations found</div>' : ''}
          ${groups.map(g => `
            <div class="conversation-group-label">${g.label}</div>
            ${g.items.map(c => `
              <div class="conversation-item ${c.id === this.state?.currentConversationId ? 'active' : ''}" data-id="${c.id}">
                <div class="conversation-item-info">
                  <div class="conversation-item-title">${this.escapeHtml(c.title)}</div>
                  <div class="conversation-item-meta">
                    <span>${c.messages.length} messages</span>
                  </div>
                </div>
                <span class="conversation-item-time">${this.timeAgo(c.updatedAt, now)}</span>
                <button class="conversation-item-delete" data-delete-id="${c.id}" title="Delete">&times;</button>
              </div>
            `).join('')}
          `).join('')}
        </div>
      </div>
    `;
  }

  private timeAgo(timestamp: number, now: number): string {
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }

  private getModeLabel(mode: ConversationMode): string {
    switch (mode) {
      case 'default': return 'Chat';
      case 'yolo': return 'YOLO';
      case 'plan': return 'Plan';
      case 'autoEdit': return 'Smart';
      default: return 'Chat';
    }
  }

  private renderModePopup(mode: ConversationMode, isThinking: boolean): string {
    return `
      <div class="mode-popup ${this.showModeMenu ? '' : 'hidden'}" id="mode-popup">
        <div class="mode-option ${mode === 'default' ? 'active' : ''}" data-mode="default">
          <span class="mode-option-label">Chat</span>
          <span class="mode-option-desc">Normal conversation</span>
        </div>
        <div class="mode-option ${mode === 'yolo' ? 'active' : ''}" data-mode="yolo">
          <span class="mode-option-label">YOLO</span>
          <span class="mode-option-desc">Auto-approve actions</span>
        </div>
        <div class="mode-option ${mode === 'plan' ? 'active' : ''}" data-mode="plan">
          <span class="mode-option-label">Plan</span>
          <span class="mode-option-desc">Plan before executing</span>
        </div>
        <div class="mode-option ${mode === 'autoEdit' ? 'active' : ''}" data-mode="autoEdit">
          <span class="mode-option-label">Smart</span>
          <span class="mode-option-desc">AI-driven edits</span>
        </div>
        <div class="mode-popup-divider"></div>
        <div class="mode-option think-option" id="think-option">
          <span class="mode-option-label">🧠 Thinking</span>
          <div class="toggle-switch ${isThinking ? 'active' : ''}">
            <div class="toggle-knob"></div>
          </div>
        </div>
      </div>
    `;
  }

  private autoSizeSelect(select: HTMLSelectElement): void {
    const option = select.options[select.selectedIndex];
    if (!option) return;
    const span = document.createElement('span');
    span.style.cssText = 'position:absolute;visibility:hidden;font-size:inherit;font-family:inherit;white-space:nowrap;';
    select.parentElement?.appendChild(span);
    span.textContent = option.text;
    select.style.width = (span.offsetWidth + 24) + 'px';
    span.remove();
  }

  private renderMessages(): string {
    const conversation = this.getCurrentConversation();

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
              <span class="tool-summary">${this.escapeHtml(this.getToolSummary(block))}</span>
              <span class="expand-icon">▼</span>
            </div>
            <div class="tool-content collapsed">
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

  private getToolSummary(block: Extract<OutputBlock, { type: 'tool' }>): string {
    // Use label if available (human-readable summary from SDK)
    if (block.label) {
      return block.label;
    }
    // Extract meaningful summary from input args based on tool name
    const input = block.input;
    if (!input || Object.keys(input).length === 0) return '';

    // Common file-related tools: show the file path
    const filePath = input.file_path || input.path || input.filePath;
    if (typeof filePath === 'string') return filePath;

    // Command tools: show the command
    const command = input.command || input.cmd;
    if (typeof command === 'string') {
      return command.length > 80 ? command.substring(0, 77) + '...' : command;
    }

    // Fallback: show first string value
    for (const val of Object.values(input)) {
      if (typeof val === 'string' && val.length > 0) {
        return val.length > 80 ? val.substring(0, 77) + '...' : val;
      }
    }
    return '';
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
    const conversation = this.getCurrentConversation();
    const isThinking = conversation?.think ?? false;
    const currentModel = conversation?.model ?? 'GLM-4.7';

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
              placeholder="Message iFlow..."
              rows="1"
            ></textarea>
            ${this.showSlashMenu ? this.renderSlashMenu() : ''}
            ${this.showMentionMenu ? this.renderMentionMenuHtml() : ''}
          </div>
          ${this.state?.isStreaming ? `
            <button id="cancel-btn" class="icon-btn danger" title="Stop">
              <span class="icon">⏹</span>
            </button>
          ` : `
            <button id="send-btn" class="icon-btn primary" title="Send">
              <span class="icon">➤</span>
            </button>
          `}
        </div>
        <div class="composer-status-bar">
          <div class="status-left">
             <div class="status-item mode-selector-wrapper">
                <button id="mode-trigger" class="mode-trigger">
                  <span>${this.getModeLabel(conversation?.mode || 'default')}</span>
                  <span class="chevron">▾</span>
                </button>
                ${this.renderModePopup(conversation?.mode || 'default', isThinking)}
             </div>
             ${isThinking ? '<span class="thinking-chip">🧠 Thinking</span>' : ''}
             <div class="status-item">
               <select id="model-select" class="dropdown-mini" title="Select Model">
                 ${MODELS.map(m => `
                   <option value="${m}" ${currentModel === m ? 'selected' : ''}>${m}</option>
                 `).join('')}
               </select>
             </div>
          </div>
        </div>
      </div>
    `;
  }

  private renderAttachedFilesHtml(): string {
    if (this.attachedFiles.length === 0) return '';

    return `
      <div class="attached-files" id="attached-files">
        ${this.attachedFiles.map((f, i) => `
          <div class="file-chip ${f.content === undefined ? 'loading' : ''}">
            <span class="file-name">${this.getFileName(f.path)}</span>
            ${f.content === undefined ? '<span class="file-loading-indicator">⏳</span>' : ''}
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
    // Conversation panel trigger
    document.getElementById('conversation-trigger')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showConversationPanel = !this.showConversationPanel;
      const panel = document.getElementById('conversation-panel');
      if (panel) {
        panel.classList.toggle('hidden', !this.showConversationPanel);
        if (this.showConversationPanel) {
          const searchInput = document.getElementById('conversation-search') as HTMLInputElement;
          searchInput?.focus();
        }
      }
    });

    // Conversation panel search
    const searchInput = document.getElementById('conversation-search') as HTMLInputElement;
    searchInput?.addEventListener('input', () => {
      this.conversationSearch = searchInput.value;
      // Re-render just the panel list
      const panel = document.getElementById('conversation-panel');
      if (panel) {
        const conversations = this.state?.conversations || [];
        panel.outerHTML = this.renderConversationPanel(conversations);
        const newPanel = document.getElementById('conversation-panel');
        if (newPanel) {
          newPanel.classList.remove('hidden');
          this.showConversationPanel = true;
          this.attachConversationPanelListeners();
          // Re-focus search input and restore cursor
          const newSearch = document.getElementById('conversation-search') as HTMLInputElement;
          if (newSearch) {
            newSearch.focus();
            newSearch.selectionStart = newSearch.selectionEnd = newSearch.value.length;
          }
        }
      }
    });

    // Conversation panel item clicks
    this.attachConversationPanelListeners();

    // Close panel when clicking outside
    document.addEventListener('click', (e) => {
      if (this.showConversationPanel) {
        const panel = document.getElementById('conversation-panel');
        const trigger = document.getElementById('conversation-trigger');
        if (panel && trigger && !panel.contains(e.target as Node) && !trigger.contains(e.target as Node)) {
          this.showConversationPanel = false;
          panel.classList.add('hidden');
        }
      }
    });

    // New conversation button (top bar)
    document.getElementById('new-conversation-top-btn')?.addEventListener('click', () => {
      this.vscode.postMessage({ type: 'newConversation' });
    });

    // Mode trigger button
    document.getElementById('mode-trigger')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showModeMenu = !this.showModeMenu;
      const popup = document.getElementById('mode-popup');
      if (popup) {
        popup.classList.toggle('hidden', !this.showModeMenu);
      }
    });

    // Mode options in popup
    document.querySelectorAll('.mode-option[data-mode]').forEach(item => {
      item.addEventListener('click', () => {
        const mode = (item as HTMLElement).dataset.mode as ConversationMode;
        this.showModeMenu = false;
        this.vscode.postMessage({ type: 'setMode', mode });
      });
    });

    // Think toggle in mode popup
    document.getElementById('think-option')?.addEventListener('click', () => {
      const conv = this.getCurrentConversation();
      const newThink = !(conv?.think ?? false);
      this.vscode.postMessage({ type: 'setThink', enabled: newThink });
    });

    // Close mode popup on outside click
    document.addEventListener('click', (e) => {
      if (this.showModeMenu) {
        const popup = document.getElementById('mode-popup');
        const trigger = document.getElementById('mode-trigger');
        if (popup && trigger && !popup.contains(e.target as Node) && !trigger.contains(e.target as Node)) {
          this.showModeMenu = false;
          popup.classList.add('hidden');
        }
      }
    });

    // Model selector (auto-sized)
    const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
    if (modelSelect) {
      this.autoSizeSelect(modelSelect);
      modelSelect.addEventListener('change', () => {
        this.vscode.postMessage({ type: 'setModel', model: modelSelect.value as ModelType });
        this.autoSizeSelect(modelSelect);
      });
    }

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
      // Arrow key navigation for slash menu
      if (this.showSlashMenu && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const items = this.getSlashMenuItems();
        if (e.key === 'ArrowUp') {
          this.slashSelectedIndex = (this.slashSelectedIndex - 1 + items.length) % items.length;
        } else {
          this.slashSelectedIndex = (this.slashSelectedIndex + 1) % items.length;
        }
        this.updateSlashMenu();
        return;
      }
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
        if (this.showSlashMenu && this.slashMenuMode !== 'commands') {
          // Go back to commands list
          this.slashMenuMode = 'commands';
          this.slashSelectedIndex = 0;
          this.updateSlashMenu();
        } else {
          this.showSlashMenu = false;
          this.showMentionMenu = false;
          this.updateSlashMenu();
          this.render();
        }
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
        const index = parseInt((item as HTMLElement).dataset.index || '0', 10);
        this.slashSelectedIndex = index;
        this.executeSlashCommand();
      });
      item.addEventListener('mouseenter', () => {
        const index = parseInt((item as HTMLElement).dataset.index || '0', 10);
        this.slashSelectedIndex = index;
        // Update highlight without rebuilding
        document.querySelectorAll('.slash-item').forEach((el, i) => {
          el.classList.toggle('selected', i === index);
        });
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

  private attachConversationPanelListeners(): void {
    // Click on conversation items
    document.querySelectorAll('.conversation-item').forEach(item => {
      item.addEventListener('click', (e) => {
        // Don't switch if clicking the delete button
        if ((e.target as HTMLElement).closest('.conversation-item-delete')) return;
        const id = (item as HTMLElement).dataset.id;
        if (id) {
          this.showConversationPanel = false;
          this.conversationSearch = '';
          this.vscode.postMessage({ type: 'switchConversation', conversationId: id });
        }
      });
    });

    // Delete conversation buttons
    document.querySelectorAll('.conversation-item-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = (btn as HTMLElement).dataset.deleteId;
        if (id) {
          this.vscode.postMessage({ type: 'deleteConversation', conversationId: id });
        }
      });
    });
  }

  private handleInputChange(input: HTMLTextAreaElement): void {
    const value = input.value;
    const cursorPos = input.selectionStart;

    // Check for slash command
    if (value.startsWith('/')) {
      if (!this.showSlashMenu) {
        this.slashMenuMode = 'commands';
      }
      this.showSlashMenu = true;
      this.slashFilter = value;
      this.showMentionMenu = false;
      if (this.slashMenuMode === 'commands') {
        this.slashSelectedIndex = 0;
      }
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
    this.updateSlashMenu();
  }

  private updateSlashMenu(): void {
    let menu = document.getElementById('slash-menu');
    if (!this.showSlashMenu) {
      menu?.remove();
      return;
    }
    const wrapper = document.querySelector('.input-wrapper');
    if (!menu && wrapper) {
      menu = document.createElement('div');
      menu.id = 'slash-menu';
      menu.className = 'slash-menu';
      wrapper.appendChild(menu);
    }
    if (!menu) return;

    const items = this.getSlashMenuItems();
    if (this.slashSelectedIndex >= items.length) this.slashSelectedIndex = items.length - 1;
    if (this.slashSelectedIndex < 0) this.slashSelectedIndex = 0;

    menu.innerHTML = items.map((item, i) => `
      <div class="slash-item ${i === this.slashSelectedIndex ? 'selected' : ''}" data-index="${i}">
        <span class="command">${item.label}</span>
        <span class="description">${item.description}</span>
      </div>
    `).join('');

    this.attachSlashListeners();
    const selected = menu.querySelector('.slash-item.selected');
    selected?.scrollIntoView({ block: 'nearest' });
  }

  private getSlashMenuItems(): { label: string; description: string; value: string; action: string }[] {
    if (this.slashMenuMode === 'models') {
      const currentModel = this.getCurrentConversation()?.model ?? 'GLM-4.7';
      return [
        { label: '←', description: 'Back to commands', value: 'back', action: 'back' },
        ...(MODELS as readonly string[]).map(m => ({
          label: m,
          description: m === currentModel ? '✓ Current' : '',
          value: m,
          action: 'selectModel'
        }))
      ];
    }
    if (this.slashMenuMode === 'modes') {
      const currentMode = this.getCurrentConversation()?.mode ?? 'default';
      const modes = [
        { value: 'default', label: 'Chat', desc: 'Normal conversation' },
        { value: 'yolo', label: 'YOLO', desc: 'Auto-approve actions' },
        { value: 'plan', label: 'Plan', desc: 'Plan before executing' },
        { value: 'autoEdit', label: 'Smart', desc: 'AI-driven edits' },
      ];
      return [
        { label: '←', description: 'Back to commands', value: 'back', action: 'back' },
        ...modes.map(m => ({
          label: m.label,
          description: (m.value === currentMode ? '✓ ' : '') + m.desc,
          value: m.value,
          action: 'selectMode'
        }))
      ];
    }
    // Commands mode
    return SLASH_COMMANDS
      .filter(c => c.command.toLowerCase().includes(this.slashFilter.toLowerCase()))
      .map(c => ({
        label: c.command,
        description: c.description + (c.command === '/mode' || c.command === '/model' ? '  →' : ''),
        value: c.command,
        action: 'command'
      }));
  }

  private executeSlashCommand(): void {
    const items = this.getSlashMenuItems();
    const selected = items[this.slashSelectedIndex];
    if (!selected) return;

    switch (selected.action) {
      case 'back':
        this.slashMenuMode = 'commands';
        this.slashSelectedIndex = 0;
        this.updateSlashMenu();
        break;
      case 'selectModel':
        this.vscode.postMessage({ type: 'setModel', model: selected.value as ModelType });
        this.closeSlashMenu();
        break;
      case 'selectMode':
        this.vscode.postMessage({ type: 'setMode', mode: selected.value as ConversationMode });
        this.closeSlashMenu();
        break;
      case 'command':
        this.executeCommand(selected.value);
        break;
    }
  }

  private closeSlashMenu(): void {
    this.showSlashMenu = false;
    this.slashMenuMode = 'commands';
    this.slashSelectedIndex = 0;
    const input = document.getElementById('message-input') as HTMLTextAreaElement;
    if (input) input.value = '';
    this.updateSlashMenu();
  }

  private executeCommand(command: string): void {
    switch (command) {
      case '/new':
        this.vscode.postMessage({ type: 'newConversation' });
        break;
      case '/clear':
        this.vscode.postMessage({ type: 'clearConversation' });
        break;
      case '/mode':
        this.slashMenuMode = 'modes';
        this.slashSelectedIndex = 0;
        this.updateSlashMenu();
        return;
      case '/think': {
        const conv = this.getCurrentConversation();
        this.vscode.postMessage({ type: 'setThink', enabled: !(conv?.think ?? false) });
        break;
      }
      case '/model':
        this.slashMenuMode = 'models';
        this.slashSelectedIndex = 0;
        this.updateSlashMenu();
        return;
      case '/help':
        // Show help in chat
        break;
    }

    this.closeSlashMenu();
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

    // Prevent sending while file contents are still loading
    if (this.attachedFiles.length > 0 && this.attachedFiles.some(f => f.content === undefined)) {
      return;
    }

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
    textarea.style.height = '28px';
    if (textarea.scrollHeight > 28) {
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }
  }

  private scrollToBottom(smooth = false): void {
    const container = document.getElementById('messages-container');
    if (container) {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto'
      });
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
    const lines = text.split('\n');
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code block
      const fenceMatch = line.match(/^```(\w*)/);
      if (fenceMatch) {
        const lang = fenceMatch[1] || '';
        const codeLines: string[] = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('```')) {
          codeLines.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++; // skip closing ```
        const code = this.escapeHtml(codeLines.join('\n'));
        result.push(`<div class="block-code"><div class="code-header"><span class="language">${lang}</span></div><pre><code>${code}</code></pre></div>`);
        continue;
      }

      // Horizontal rule
      if (/^(\s*[-*_]\s*){3,}$/.test(line)) {
        result.push('<hr>');
        i++;
        continue;
      }

      // Headers
      const headerMatch = line.match(/^(#{1,6})\s+(.+)/);
      if (headerMatch) {
        const level = headerMatch[1].length;
        result.push(`<h${level}>${this.renderInline(headerMatch[2])}</h${level}>`);
        i++;
        continue;
      }

      // Table: detect header row followed by separator row
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*[-:]+[-| :]*$/.test(lines[i + 1])) {
        const tableLines: string[] = [];
        while (i < lines.length && lines[i].includes('|')) {
          tableLines.push(lines[i]);
          i++;
        }
        result.push(this.renderTable(tableLines));
        continue;
      }

      // Blockquote
      if (line.startsWith('>')) {
        const quoteLines: string[] = [];
        while (i < lines.length && lines[i].startsWith('>')) {
          quoteLines.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        result.push(`<blockquote>${this.renderMarkdown(quoteLines.join('\n'))}</blockquote>`);
        continue;
      }

      // Unordered list
      if (/^\s*[-*+]\s+/.test(line)) {
        const listItems: string[] = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          listItems.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
          i++;
        }
        result.push('<ul>' + listItems.map(item => `<li>${this.renderInline(item)}</li>`).join('') + '</ul>');
        continue;
      }

      // Ordered list
      if (/^\s*\d+\.\s+/.test(line)) {
        const listItems: string[] = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          listItems.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
          i++;
        }
        result.push('<ol>' + listItems.map(item => `<li>${this.renderInline(item)}</li>`).join('') + '</ol>');
        continue;
      }

      // Empty line
      if (line.trim() === '') {
        i++;
        continue;
      }

      // Paragraph
      const paraLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== '' && !lines[i].match(/^(#{1,6}\s|```|>\s|[-*+]\s|\d+\.\s|\s*[-*_]\s*[-*_]\s*[-*_])/) && !lines[i].includes('|')) {
        paraLines.push(lines[i]);
        i++;
      }
      result.push(`<p>${this.renderInline(paraLines.join('\n'))}</p>`);
    }

    return result.join('\n');
  }

  private renderInline(text: string): string {
    return this.escapeHtml(text)
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\n/g, '<br>');
  }

  private renderTable(lines: string[]): string {
    const parseRow = (row: string): string[] => {
      return row.split('|').map(c => c.trim()).filter((_, i, arr) => {
        // Remove empty first/last cells from leading/trailing pipes
        if (i === 0 && arr[0] === '') return false;
        if (i === arr.length - 1 && arr[arr.length - 1] === '') return false;
        return true;
      });
    };

    if (lines.length < 2) return this.escapeHtml(lines.join('\n'));

    const headers = parseRow(lines[0]);
    // lines[1] is the separator row, skip it
    const bodyRows = lines.slice(2).map(parseRow);

    let html = '<table><thead><tr>';
    for (const h of headers) {
      html += `<th>${this.renderInline(h)}</th>`;
    }
    html += '</tr></thead><tbody>';
    for (const row of bodyRows) {
      html += '<tr>';
      for (const cell of row) {
        html += `<td>${this.renderInline(cell)}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    return html;
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
