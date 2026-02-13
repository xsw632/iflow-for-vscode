// Webview entry point for IFlow panel

import type {
  ConversationMode,
  ModelType,
  OutputBlock,
  Message,
  Conversation,
  ConversationState,
  WebviewMessage,
  ExtensionMessage
} from '../src/protocol';
import { MODELS } from '../src/protocol';
import { escapeHtml, renderMarkdown } from './markdownRenderer';
import { getToolHeadline, renderToolDetailPreview, getFileName, getFileIcon } from './toolRenderers';
import { SlashMenuController } from './slashMenuController';
import { InputController } from './inputController';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// Main app class
class IFlowApp {
  private vscode: VsCodeApi;
  private state: ConversationState | null = null;
  private slashMenu!: SlashMenuController;
  private inputCtrl!: InputController;
  private faviconUri: string;

  private showConversationPanel = false;
  private conversationSearch = '';
  private showModeMenu = false;
  private composerResizeObserver: ResizeObserver | null = null;
  private pendingConfirmation: { requestId: number; toolName: string; description: string } | null = null;
  private clearInputOnNextRender = false;

  constructor() {
    this.vscode = acquireVsCodeApi();
    this.faviconUri = document.getElementById('app')?.getAttribute('data-favicon-uri') || '';
    this.inputCtrl = new InputController({
      postMessage: (msg) => this.vscode.postMessage(msg),
      getInputElement: () => document.getElementById('message-input') as HTMLTextAreaElement | null,
      onAttachedFilesChanged: () => {
        this.attachFileOpenListeners();
        this.syncMessagesBottomInset();
      }
    });
    this.slashMenu = new SlashMenuController({
      postMessage: (msg) => this.vscode.postMessage(msg),
      getCurrentConversation: () => this.getCurrentConversation(),
      getInputElement: () => document.getElementById('message-input') as HTMLTextAreaElement | null,
      onSlashMenuClosed: () => {
        this.clearInputOnNextRender = true;
        this.render();
      }
    });
    this.setupMessageHandler();
    this.setupDocumentClickHandler();
    this.render();
    this.vscode.postMessage({ type: 'ready' });
  }

  private setupMessageHandler(): void {
    window.addEventListener('message', (event) => {
      const message = event.data as ExtensionMessage;
      this.handleMessage(message);
    });
  }

  /** Single document-level click handler (registered once, not per-render). */
  private setupDocumentClickHandler(): void {
    document.addEventListener('click', (e) => {
      // Close conversation panel on outside click
      if (this.showConversationPanel) {
        const panel = document.getElementById('conversation-panel');
        const trigger = document.getElementById('conversation-trigger');
        if (panel && trigger && !panel.contains(e.target as Node) && !trigger.contains(e.target as Node)) {
          this.showConversationPanel = false;
          panel.classList.add('hidden');
        }
      }
      // Close mode popup on outside click
      if (this.showModeMenu) {
        const popup = document.getElementById('mode-popup');
        const trigger = document.getElementById('mode-trigger');
        if (popup && trigger && !popup.contains(e.target as Node) && !trigger.contains(e.target as Node)) {
          this.showModeMenu = false;
          popup.classList.add('hidden');
        }
      }
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
          if (conversationChanged) {
            this.clearInputOnNextRender = true;
          }
          this.render(conversationChanged);
        }
        break;
      }

      case 'pickedFiles':
        this.inputCtrl.handlePickedFiles(message.files);
        break;

      case 'workspaceFiles':
        this.inputCtrl.setWorkspaceFiles(message.files);
        break;

      case 'fileContents':
        this.inputCtrl.handleFileContents(message.files);
        break;

      case 'streamChunk':
        // Streaming updates are handled by stateUpdated to avoid duplicate scroll work.
        // Exception: tool_confirmation needs to transform the composer into an approval UI.
        if (message.chunk.chunkType === 'tool_confirmation') {
          this.pendingConfirmation = {
            requestId: message.chunk.requestId,
            toolName: message.chunk.toolName,
            description: message.chunk.description,
          };
          this.render();
        }
        break;

      case 'streamEnd':
      case 'streamError':
        // No render() needed here — the stateUpdated with isStreaming=false
        // already triggers a full render.
        // Clear any pending confirmation when the stream ends.
        this.pendingConfirmation = null;
        break;
    }
  }

  private render(smoothScrollToBottom = false): void {
    const app = document.getElementById('app');
    if (!app) return;

    // Save current input state before DOM rebuild
    const prevInput = document.getElementById('message-input') as HTMLTextAreaElement;
    const savedValue = this.clearInputOnNextRender ? '' : (prevInput?.value ?? '');
    const savedSelStart = prevInput?.selectionStart ?? 0;
    const savedSelEnd = prevInput?.selectionEnd ?? 0;
    this.clearInputOnNextRender = false;

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
    this.setupComposerLayoutObserver();

    // Restore input state after DOM rebuild
    if (savedValue) {
      const newInput = document.getElementById('message-input') as HTMLTextAreaElement;
      if (newInput) {
        newInput.value = savedValue;
        newInput.selectionStart = savedSelStart;
        newInput.selectionEnd = savedSelEnd;
        this.autoResizeTextarea(newInput);
      }
    }

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

  private setupComposerLayoutObserver(): void {
    this.composerResizeObserver?.disconnect();
    this.composerResizeObserver = null;

    const composer = document.querySelector('.composer') as HTMLElement | null;
    if (!composer) {
      return;
    }

    if (typeof ResizeObserver === 'undefined') {
      this.syncMessagesBottomInset();
      return;
    }

    this.composerResizeObserver = new ResizeObserver(() => {
      this.syncMessagesBottomInset();
    });
    this.composerResizeObserver.observe(composer);
    this.syncMessagesBottomInset();
  }

  private syncMessagesBottomInset(): void {
    const messages = (document.getElementById('messages-container') || document.querySelector('.messages')) as HTMLElement | null;
    const composer = document.querySelector('.composer') as HTMLElement | null;
    if (!messages || !composer) {
      return;
    }

    const minInset = 140;
    const inset = Math.max(minInset, composer.offsetHeight + 24);
    messages.style.paddingBottom = `${inset}px`;
  }

  // Top Bar - conversation selector (left) + new chat button (right)
  private renderTopBar(): string {
    const conversations = this.state?.conversations || [];
    const current = this.getCurrentConversation();
    const title = current ? escapeHtml(current.title) : 'No conversations';

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
                  <div class="conversation-item-title">${escapeHtml(c.title)}</div>
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
      case 'smart': return 'Smart';
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
        <div class="mode-option ${mode === 'smart' ? 'active' : ''}" data-mode="smart">
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
        <div class="messages" id="messages-container">
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
              <button class="file-chip small file-open-btn" data-open-file-path="${this.escapeAttr(f.path)}" title="Open ${this.escapeAttr(getFileName(f.path))}">
                <span class="file-icon">${getFileIcon(f.path)}</span>
                <span class="file-name">${escapeHtml(getFileName(f.path))}</span>
              </button>
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
        return `<div class="block-text">${renderMarkdown(block.content)}</div>`;

      case 'code':
        return `
          <div class="block-code">
            <div class="code-header">
              <span class="language">${block.language}${block.filename ? ` - ${block.filename}` : ''}</span>
              <button class="copy-btn" data-content="${this.escapeAttr(block.content)}">Copy</button>
            </div>
            <pre><code>${escapeHtml(block.content)}</code></pre>
          </div>
        `;

      case 'tool':
        {
          const detailPreview = renderToolDetailPreview(block);
        return `
          <div class="tool-entry">
            <div class="block-tool ${block.status}">
              <span class="tool-icon ${block.status}">${block.status === 'running' ? '⏳' : block.status === 'completed' ? '✓' : '✗'}</span>
              <span class="tool-headline">${escapeHtml(getToolHeadline(block))}</span>
            </div>
            ${detailPreview}
          </div>
        `;
        }

      case 'thinking':
        return `
          <div class="block-thinking ${block.collapsed ? 'collapsed' : ''}">
            <div class="thinking-header" data-collapsible>
              <span class="thinking-icon">💭</span>
              <span>Thinking...</span>
              <span class="expand-icon">▼</span>
            </div>
            <div class="thinking-content ${block.collapsed ? 'collapsed' : ''}">
              ${escapeHtml(block.content)}
            </div>
          </div>
        `;

      case 'file_ref':
        return `
          <div class="block-file-ref">
            <span class="file-icon">📄</span>
            <span class="file-path">${escapeHtml(block.path)}</span>
            ${block.lineStart ? `<span class="line-range">:${block.lineStart}${block.lineEnd ? `-${block.lineEnd}` : ''}</span>` : ''}
          </div>
        `;

      case 'error':
        return `
          <div class="block-error">
            <span class="icon">❌</span>
            <span>${escapeHtml(block.message)}</span>
          </div>
        `;

      case 'warning':
        return `
          <div class="block-warning">
            <span class="icon">⚠</span>
            <span>${escapeHtml(block.message)}</span>
          </div>
        `;
    }
  }

  private renderPendingIndicator(): string {
    return `
      <div class="pending-indicator">
        <div class="bounce-logo"><img src="${this.faviconUri}" alt="IFlow" class="bounce-logo-icon" /></div>
        <span>Flowing...</span>
      </div>
    `;
  }

  private renderComposer(): string {
    // When a tool call needs approval, replace the composer with a selection panel
    if (this.pendingConfirmation) {
      return this.renderApprovalPanel();
    }

    const conversation = this.getCurrentConversation();
    const isThinking = conversation?.think ?? false;
    const currentModel = conversation?.model ?? 'GLM-4.7';

    return `
      <div class="composer">
        ${this.inputCtrl.renderAttachedFilesHtml()}
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
            ${this.slashMenu.isVisible ? this.slashMenu.renderHtml() : ''}
            ${this.inputCtrl.isMentionVisible ? this.inputCtrl.renderMentionMenuHtml() : ''}
          </div>
          ${this.state?.isStreaming ? `
            <button id="cancel-btn" class="icon-btn danger stop-btn" title="Stop">
              <span class="stop-glyph" aria-hidden="true"></span>
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
          ${this.renderContextUsage()}
        </div>
      </div>
    `;
  }

  private renderContextUsage(): string {
    const usage = this.state?.contextUsage;
    if (!usage) return '';
    const percent = usage.percent;
    const colorClass = percent >= 80 ? 'context-high' : percent >= 50 ? 'context-mid' : 'context-low';
    const label = percent === 0 && usage.usedTokens > 0 ? '<1%' : `${percent}%`;
    const piePath = this.getPieSlicePath(18, 18, 16, percent, usage.usedTokens);
    return `
      <div class="status-right">
        <div class="context-usage ${colorClass}" title="${usage.usedTokens.toLocaleString()} / ${usage.totalTokens.toLocaleString()} tokens">
          <svg class="context-pie" width="16" height="16" viewBox="0 0 36 36">
            <circle cx="18" cy="18" r="16" fill="var(--vscode-widget-border, rgba(128,128,128,0.3))"/>
            ${piePath ? `<path d="${piePath}" fill="currentColor"/>` : ''}
          </svg>
          <span>${label}</span>
        </div>
      </div>
    `;
  }

  private getPieSlicePath(cx: number, cy: number, r: number, percent: number, usedTokens: number): string {
    if (usedTokens === 0) return '';
    if (percent >= 100) {
      return `M${cx - r},${cy} a${r},${r} 0 1,1 ${r * 2},0 a${r},${r} 0 1,1 -${r * 2},0`;
    }
    const clampedPercent = Math.max(percent, 0.5);
    const angle = (clampedPercent / 100) * 360;
    const rad = (angle - 90) * Math.PI / 180;
    const x = cx + r * Math.cos(rad);
    const y = cy + r * Math.sin(rad);
    const largeArc = angle > 180 ? 1 : 0;
    return `M${cx},${cy} L${cx},${cy - r} A${r},${r} 0 ${largeArc},1 ${x.toFixed(2)},${y.toFixed(2)} Z`;
  }

  private renderApprovalPanel(): string {
    const conf = this.pendingConfirmation!;
    const toolLabel = escapeHtml(conf.toolName);
    return `
      <div class="composer approval-panel">
        <div class="approval-question">Allow <strong>${toolLabel}</strong>?</div>
        <div class="approval-options">
          <button class="approval-option" data-approval="allow">
            <span class="approval-key">1</span>
            <span class="approval-label">Yes</span>
          </button>
          <button class="approval-option" data-approval="alwaysAllow">
            <span class="approval-key">2</span>
            <span class="approval-label">Yes, allow all edits this session</span>
          </button>
          <button class="approval-option" data-approval="reject">
            <span class="approval-key">3</span>
            <span class="approval-label">No</span>
          </button>
          <div class="approval-option feedback-option">
            <span class="approval-key">4</span>
            <input
              type="text"
              id="approval-feedback-input"
              class="approval-feedback-input"
              placeholder="Tell IFlow what to do instead..."
            />
          </div>
        </div>
        <div class="approval-hint">Esc to cancel</div>
      </div>
    `;
  }

  private attachEventListeners(): void {
    this.attachTopBarListeners();
    this.attachModeListeners();
    this.attachComposerListeners();
    this.attachContentListeners();
    this.slashMenu.attachListeners();
    this.inputCtrl.attachMentionListeners();
    this.inputCtrl.attachFileRemoveListeners();
    this.attachFileOpenListeners();
  }

  private attachTopBarListeners(): void {
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

    const searchInput = document.getElementById('conversation-search') as HTMLInputElement;
    searchInput?.addEventListener('input', () => {
      this.conversationSearch = searchInput.value;
      const panel = document.getElementById('conversation-panel');
      if (panel) {
        const conversations = this.state?.conversations || [];
        panel.outerHTML = this.renderConversationPanel(conversations);
        const newPanel = document.getElementById('conversation-panel');
        if (newPanel) {
          newPanel.classList.remove('hidden');
          this.showConversationPanel = true;
          this.attachConversationPanelListeners();
          const newSearch = document.getElementById('conversation-search') as HTMLInputElement;
          if (newSearch) {
            newSearch.focus();
            newSearch.selectionStart = newSearch.selectionEnd = newSearch.value.length;
          }
        }
      }
    });

    this.attachConversationPanelListeners();

    document.getElementById('new-conversation-top-btn')?.addEventListener('click', () => {
      this.vscode.postMessage({ type: 'newConversation' });
    });
  }

  private attachModeListeners(): void {
    document.getElementById('mode-trigger')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showModeMenu = !this.showModeMenu;
      const popup = document.getElementById('mode-popup');
      if (popup) {
        popup.classList.toggle('hidden', !this.showModeMenu);
      }
    });

    document.querySelectorAll('.mode-option[data-mode]').forEach(item => {
      item.addEventListener('click', () => {
        const mode = (item as HTMLElement).dataset.mode as ConversationMode;
        this.showModeMenu = false;
        this.vscode.postMessage({ type: 'setMode', mode });
      });
    });

    document.getElementById('think-option')?.addEventListener('click', () => {
      const conv = this.getCurrentConversation();
      const newThink = !(conv?.think ?? false);
      this.vscode.postMessage({ type: 'setThink', enabled: newThink });
    });

    const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
    if (modelSelect) {
      this.autoSizeSelect(modelSelect);
      modelSelect.addEventListener('change', () => {
        this.vscode.postMessage({ type: 'setModel', model: modelSelect.value as ModelType });
        this.autoSizeSelect(modelSelect);
      });
    }
  }

  private attachComposerListeners(): void {
    // If the approval panel is showing, attach approval-specific listeners instead
    if (this.pendingConfirmation) {
      this.attachApprovalListeners();
      return;
    }

    document.getElementById('attach-btn')?.addEventListener('click', () => {
      this.vscode.postMessage({ type: 'pickFiles' });
    });

    document.getElementById('send-btn')?.addEventListener('click', () => {
      this.sendMessage();
    });

    document.getElementById('cancel-btn')?.addEventListener('click', () => {
      this.vscode.postMessage({ type: 'cancelCurrent' });
    });

    const input = document.getElementById('message-input') as HTMLTextAreaElement;
    input?.addEventListener('input', () => {
      this.handleInputChange(input);
      this.autoResizeTextarea(input);
    });

    input?.addEventListener('keydown', (e) => {
      if (this.slashMenu.handleKeyDown(e)) { return; }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (this.inputCtrl.handleEnterKey()) { return; }
        this.sendMessage();
      } else if (e.key === 'Escape') {
        this.inputCtrl.handleEscapeKey();
        this.render();
      }
    });
  }

  private attachApprovalListeners(): void {
    const conf = this.pendingConfirmation;
    if (!conf) return;

    const handleApproval = (outcome: 'allow' | 'alwaysAllow' | 'reject') => {
      this.vscode.postMessage({ type: 'toolApproval', requestId: conf.requestId, outcome });
      if (outcome === 'alwaysAllow') {
        this.vscode.postMessage({ type: 'setMode', mode: 'smart' });
      }
      this.pendingConfirmation = null;
      this.render();
    };

    // Click handlers for the 3 button options
    document.querySelectorAll('.approval-option[data-approval]').forEach(btn => {
      btn.addEventListener('click', () => {
        const outcome = (btn as HTMLElement).dataset.approval as 'allow' | 'alwaysAllow' | 'reject';
        handleApproval(outcome);
      });
    });

    // Feedback input: Enter to reject + send feedback text
    const feedbackInput = document.getElementById('approval-feedback-input') as HTMLInputElement;
    feedbackInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        // Reject the tool call
        this.vscode.postMessage({ type: 'toolApproval', requestId: conf.requestId, outcome: 'reject' });
        this.pendingConfirmation = null;
        this.render();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleApproval('reject');
      }
    });

    // Global keyboard shortcuts: 1/2/3/Esc
    const keyHandler = (e: KeyboardEvent) => {
      // Don't intercept if focus is on the feedback input
      if (document.activeElement === feedbackInput) return;

      if (e.key === '1') { e.preventDefault(); handleApproval('allow'); }
      else if (e.key === '2') { e.preventDefault(); handleApproval('alwaysAllow'); }
      else if (e.key === '3') { e.preventDefault(); handleApproval('reject'); }
      else if (e.key === 'Escape') { e.preventDefault(); handleApproval('reject'); }
      else if (e.key === '4') {
        e.preventDefault();
        feedbackInput?.focus();
      }
    };
    document.addEventListener('keydown', keyHandler);

    // Clean up when approval panel is removed (next render will not re-attach)
    const observer = new MutationObserver(() => {
      if (!document.querySelector('.approval-panel')) {
        document.removeEventListener('keydown', keyHandler);
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  private attachContentListeners(): void {
    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const content = (btn as HTMLElement).dataset.content || '';
        navigator.clipboard.writeText(content);
      });
    });

    document.querySelectorAll('[data-collapsible]').forEach(header => {
      header.addEventListener('click', () => {
        const content = header.nextElementSibling;
        content?.classList.toggle('collapsed');
      });
    });
  }

  private attachFileOpenListeners(): void {
    document.querySelectorAll('[data-open-file-path]').forEach(btn => {
      if ((btn as HTMLElement).dataset.openBound === '1') {
        return;
      }
      (btn as HTMLElement).dataset.openBound = '1';
      btn.addEventListener('click', () => {
        const path = (btn as HTMLElement).dataset.openFilePath;
        if (!path) return;
        this.vscode.postMessage({ type: 'openFile', path });
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
    if (this.slashMenu.handleInput(value)) {
      return;
    }

    // Check for @ mention
    this.inputCtrl.handleInput(value, cursorPos);
  }

  private sendMessage(): void {
    const input = document.getElementById('message-input') as HTMLTextAreaElement;
    const content = input?.value.trim() || '';

    if (!this.inputCtrl.canSend(content)) { return; }

    const attachedFiles = this.inputCtrl.consumeAttachedFiles();
    this.vscode.postMessage({
      type: 'sendMessage',
      content,
      attachedFiles
    });

    // Clear input
    if (input) {
      input.value = '';
      this.autoResizeTextarea(input);
    }
  }

  private autoResizeTextarea(textarea: HTMLTextAreaElement): void {
    textarea.style.height = '28px';
    if (textarea.scrollHeight > 28) {
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }
    this.syncMessagesBottomInset();
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

  private formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  private escapeAttr(text: string): string {
    return text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  dispose(): void {
    this.composerResizeObserver?.disconnect();
    this.composerResizeObserver = null;
    this.slashMenu.dispose();
    this.inputCtrl.dispose();
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

