// Webview entry point for IFlow panel.
// Orchestrates state, message routing, and delegates rendering/events.

import type {
  Conversation,
  ConversationState,
  WebviewMessage,
  ExtensionMessage
} from '../src/protocol';
import { escapeHtml } from './markdownRenderer';
import { SlashMenuController } from './slashMenuController';
import { InputController } from './inputController';
import { TEXTAREA_MIN_HEIGHT, TEXTAREA_MAX_HEIGHT, COMPOSER_MIN_INSET, COMPOSER_INSET_PADDING } from './webviewUtils';
import {
  renderTopBar,
  renderConversationPanel,
  renderMessages,
  renderComposer,
  renderBlock,
  renderPendingIndicator,
} from './appRenderer';
import type { PendingConfirmation, PendingQuestion, PendingPlanApproval } from './appRenderer';
import {
  attachTopBarListeners,
  attachModeListeners,
  attachComposerListeners,
  attachContentListeners,
  attachFileOpenListeners,
} from './eventBinder';
import type { AppHost } from './eventBinder';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// Main app class
class IFlowApp implements AppHost {
  private vscode: VsCodeApi;
  private state: ConversationState | null = null;
  private slashMenu!: SlashMenuController;
  private inputCtrl!: InputController;
  private faviconUri: string;

  private composerResizeObserver: ResizeObserver | null = null;
  private pendingConfirmation: PendingConfirmation | null = null;
  private pendingQuestion: PendingQuestion | null = null;
  private pendingPlanApproval: PendingPlanApproval | null = null;
  private clearInputOnNextRender = false;

  // AppHost public state (accessed by event binders)
  showConversationPanel = false;
  conversationSearch = '';
  showModeMenu = false;

  constructor() {
    this.vscode = acquireVsCodeApi();
    this.faviconUri = document.getElementById('app')?.getAttribute('data-favicon-uri') || '';
    this.inputCtrl = new InputController({
      postMessage: (msg) => this.vscode.postMessage(msg),
      getInputElement: () => document.getElementById('message-input') as HTMLTextAreaElement | null,
      onAttachedFilesChanged: () => {
        attachFileOpenListeners((msg) => this.vscode.postMessage(msg));
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

  // ── AppHost implementation ─────────────────────────────────────────

  postMessage(msg: WebviewMessage): void {
    this.vscode.postMessage(msg);
  }

  getConversations(): Conversation[] {
    return this.state?.conversations || [];
  }

  getCurrentConversationId(): string | null {
    return this.state?.currentConversationId ?? null;
  }

  getCurrentConversation(): Conversation | null {
    if (!this.state?.currentConversationId) return null;
    return this.state.conversations.find(c => c.id === this.state?.currentConversationId) || null;
  }

  getPendingConfirmation(): PendingConfirmation | null {
    return this.pendingConfirmation;
  }

  clearPendingConfirmation(): void {
    this.pendingConfirmation = null;
  }

  getPendingQuestion(): PendingQuestion | null {
    return this.pendingQuestion;
  }

  clearPendingQuestion(): void {
    this.pendingQuestion = null;
  }

  getPendingPlanApproval(): PendingPlanApproval | null {
    return this.pendingPlanApproval;
  }

  clearPendingPlanApproval(): void {
    this.pendingPlanApproval = null;
  }

  autoSizeSelect(select: HTMLSelectElement): void {
    const option = select.options[select.selectedIndex];
    if (!option) return;
    const span = document.createElement('span');
    span.style.cssText = 'position:absolute;visibility:hidden;font-size:inherit;font-family:inherit;white-space:nowrap;';
    select.parentElement?.appendChild(span);
    span.textContent = option.text;
    select.style.width = (span.offsetWidth + 24) + 'px';
    span.remove();
  }

  handleInputChange(input: HTMLTextAreaElement): void {
    const value = input.value;
    const cursorPos = input.selectionStart;
    if (this.slashMenu.handleInput(value)) { return; }
    this.inputCtrl.handleInput(value, cursorPos);
  }

  autoResizeTextarea(textarea: HTMLTextAreaElement): void {
    textarea.style.height = `${TEXTAREA_MIN_HEIGHT}px`;
    if (textarea.scrollHeight > TEXTAREA_MIN_HEIGHT) {
      textarea.style.height = Math.min(textarea.scrollHeight, TEXTAREA_MAX_HEIGHT) + 'px';
    }
    this.syncMessagesBottomInset();
  }

  slashMenuHandleKeyDown(e: KeyboardEvent): boolean {
    return this.slashMenu.handleKeyDown(e);
  }

  inputCtrlHandleEnterKey(): boolean {
    return this.inputCtrl.handleEnterKey();
  }

  inputCtrlHandleEscapeKey(): void {
    this.inputCtrl.handleEscapeKey();
  }

  sendMessage(): void {
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

  // ── Message handling ───────────────────────────────────────────────

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
        } else if (message.chunk.chunkType === 'user_question') {
          this.pendingQuestion = {
            requestId: message.chunk.requestId,
            questions: message.chunk.questions,
          };
          this.render();
        } else if (message.chunk.chunkType === 'plan_approval') {
          this.pendingPlanApproval = {
            requestId: message.chunk.requestId,
            plan: message.chunk.plan,
          };
          this.render();
        }
        break;

      case 'streamEnd':
      case 'streamError':
        // No render() needed here — the stateUpdated with isStreaming=false
        // already triggers a full render.
        // Clear any pending states when the stream ends.
        this.pendingConfirmation = null;
        this.pendingQuestion = null;
        this.pendingPlanApproval = null;
        break;
    }
  }

  // ── Rendering orchestration ────────────────────────────────────────

  render(smoothScrollToBottom = false): void {
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

    const conversation = this.getCurrentConversation();
    const title = conversation ? escapeHtml(conversation.title) : 'No conversations';

    const conversationPanelHtml = renderConversationPanel({
      conversations: this.state?.conversations || [],
      search: this.conversationSearch,
      showPanel: this.showConversationPanel,
      currentConversationId: this.state?.currentConversationId ?? null
    });

    app.innerHTML = `
      <div class="container">
        ${renderTopBar(title, conversationPanelHtml)}
        ${renderMessages(conversation, this.state?.isStreaming ?? false, this.faviconUri)}
        ${renderComposer({
          conversation,
          isStreaming: this.state?.isStreaming ?? false,
          pendingConfirmation: this.pendingConfirmation,
          pendingQuestion: this.pendingQuestion,
          pendingPlanApproval: this.pendingPlanApproval,
          attachedFilesHtml: this.inputCtrl.renderAttachedFilesHtml(),
          slashMenuHtml: this.slashMenu.isVisible ? this.slashMenu.renderHtml() : '',
          mentionMenuHtml: this.inputCtrl.isMentionVisible ? this.inputCtrl.renderMentionMenuHtml() : '',
          contextUsage: this.state?.contextUsage,
          showModeMenu: this.showModeMenu
        })}
      </div>
    `;

    // Attach event listeners
    attachTopBarListeners(this);
    attachModeListeners(this);
    attachComposerListeners(this);
    attachContentListeners();
    this.slashMenu.attachListeners();
    this.inputCtrl.attachMentionListeners();
    this.inputCtrl.attachFileRemoveListeners();
    attachFileOpenListeners((msg) => this.vscode.postMessage(msg));
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
      contentEl.innerHTML = lastMsg.blocks.map(b => renderBlock(b)).join('');

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
        container.insertAdjacentHTML('beforeend', renderPendingIndicator(this.faviconUri));
      }
    } else {
      existingIndicator?.remove();
    }

    this.scrollToBottom();
  }

  // ── Layout helpers ─────────────────────────────────────────────────

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

    const inset = Math.max(COMPOSER_MIN_INSET, composer.offsetHeight + COMPOSER_INSET_PADDING);
    messages.style.paddingBottom = `${inset}px`;
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
