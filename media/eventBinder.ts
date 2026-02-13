// DOM event binding functions for the IFlow webview.
// Extracted from IFlowApp to separate rendering from event attachment.

import type { ConversationMode, ModelType, Conversation, WebviewMessage } from '../src/protocol';
import { renderConversationPanel } from './appRenderer';
import type { PendingConfirmation, PendingQuestion, PendingPlanApproval } from './appRenderer';

/** Interface that IFlowApp implements to supply state and actions to event binders. */
export interface AppHost {
  postMessage(msg: WebviewMessage): void;
  render(): void;
  sendMessage(): void;

  // Mutable UI state
  showConversationPanel: boolean;
  conversationSearch: string;
  showModeMenu: boolean;

  // State access
  getConversations(): Conversation[];
  getCurrentConversationId(): string | null;
  getCurrentConversation(): Conversation | null;
  getPendingConfirmation(): PendingConfirmation | null;
  clearPendingConfirmation(): void;
  getPendingQuestion(): PendingQuestion | null;
  clearPendingQuestion(): void;
  getPendingPlanApproval(): PendingPlanApproval | null;
  clearPendingPlanApproval(): void;

  // DOM helpers
  autoSizeSelect(select: HTMLSelectElement): void;
  handleInputChange(input: HTMLTextAreaElement): void;
  autoResizeTextarea(textarea: HTMLTextAreaElement): void;

  // Controller delegates
  slashMenuHandleKeyDown(e: KeyboardEvent): boolean;
  inputCtrlHandleEnterKey(): boolean;
  inputCtrlHandleEscapeKey(): void;
}

// ── Top bar ─────────────────────────────────────────────────────────

export function attachTopBarListeners(host: AppHost): void {
  document.getElementById('conversation-trigger')?.addEventListener('click', (e) => {
    e.stopPropagation();
    host.showConversationPanel = !host.showConversationPanel;
    const panel = document.getElementById('conversation-panel');
    if (panel) {
      panel.classList.toggle('hidden', !host.showConversationPanel);
      if (host.showConversationPanel) {
        const searchInput = document.getElementById('conversation-search') as HTMLInputElement;
        searchInput?.focus();
      }
    }
  });

  const searchInput = document.getElementById('conversation-search') as HTMLInputElement;
  searchInput?.addEventListener('input', () => {
    host.conversationSearch = searchInput.value;
    const panel = document.getElementById('conversation-panel');
    if (panel) {
      const conversations = host.getConversations();
      panel.outerHTML = renderConversationPanel({
        conversations,
        search: host.conversationSearch,
        showPanel: true,
        currentConversationId: host.getCurrentConversationId()
      });
      const newPanel = document.getElementById('conversation-panel');
      if (newPanel) {
        newPanel.classList.remove('hidden');
        host.showConversationPanel = true;
        attachConversationPanelListeners(host);
        const newSearch = document.getElementById('conversation-search') as HTMLInputElement;
        if (newSearch) {
          newSearch.focus();
          newSearch.selectionStart = newSearch.selectionEnd = newSearch.value.length;
        }
      }
    }
  });

  attachConversationPanelListeners(host);

  document.getElementById('new-conversation-top-btn')?.addEventListener('click', () => {
    host.postMessage({ type: 'newConversation' });
  });
}

// ── Mode / model selectors ──────────────────────────────────────────

export function attachModeListeners(host: AppHost): void {
  document.getElementById('mode-trigger')?.addEventListener('click', (e) => {
    e.stopPropagation();
    host.showModeMenu = !host.showModeMenu;
    const popup = document.getElementById('mode-popup');
    if (popup) {
      popup.classList.toggle('hidden', !host.showModeMenu);
    }
  });

  document.querySelectorAll('.mode-option[data-mode]').forEach(item => {
    item.addEventListener('click', () => {
      const mode = (item as HTMLElement).dataset.mode as ConversationMode;
      host.showModeMenu = false;
      host.postMessage({ type: 'setMode', mode });
    });
  });

  document.getElementById('think-option')?.addEventListener('click', () => {
    const conv = host.getCurrentConversation();
    const newThink = !(conv?.think ?? false);
    host.postMessage({ type: 'setThink', enabled: newThink });
  });

  const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
  if (modelSelect) {
    host.autoSizeSelect(modelSelect);
    modelSelect.addEventListener('change', () => {
      host.postMessage({ type: 'setModel', model: modelSelect.value as ModelType });
      host.autoSizeSelect(modelSelect);
    });
  }
}

// ── Composer ─────────────────────────────────────────────────────────

export function attachComposerListeners(host: AppHost): void {
  // If the approval panel is showing, attach approval-specific listeners instead
  if (host.getPendingConfirmation()) {
    attachApprovalListeners(host);
    return;
  }

  // If the question panel is showing, attach question-specific listeners
  if (host.getPendingQuestion()) {
    attachQuestionListeners(host);
    return;
  }

  // If the plan approval panel is showing, attach plan-specific listeners
  if (host.getPendingPlanApproval()) {
    attachPlanApprovalListeners(host);
    return;
  }

  document.getElementById('attach-btn')?.addEventListener('click', () => {
    host.postMessage({ type: 'pickFiles' });
  });

  document.getElementById('send-btn')?.addEventListener('click', () => {
    host.sendMessage();
  });

  document.getElementById('cancel-btn')?.addEventListener('click', () => {
    host.postMessage({ type: 'cancelCurrent' });
  });

  const input = document.getElementById('message-input') as HTMLTextAreaElement;
  input?.addEventListener('input', () => {
    host.handleInputChange(input);
    host.autoResizeTextarea(input);
  });

  input?.addEventListener('keydown', (e) => {
    if (host.slashMenuHandleKeyDown(e)) { return; }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (host.inputCtrlHandleEnterKey()) { return; }
      host.sendMessage();
    } else if (e.key === 'Escape') {
      host.inputCtrlHandleEscapeKey();
      host.render();
    }
  });
}

// ── Approval panel ──────────────────────────────────────────────────

function attachApprovalListeners(host: AppHost): void {
  const conf = host.getPendingConfirmation();
  if (!conf) return;

  const handleApproval = (outcome: 'allow' | 'alwaysAllow' | 'reject') => {
    host.postMessage({ type: 'toolApproval', requestId: conf.requestId, outcome });
    if (outcome === 'alwaysAllow') {
      host.postMessage({ type: 'setMode', mode: 'smart' });
    }
    host.clearPendingConfirmation();
    host.render();
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
      host.postMessage({ type: 'toolApproval', requestId: conf.requestId, outcome: 'reject' });
      host.clearPendingConfirmation();
      host.render();
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

// ── Question panel ───────────────────────────────────────────────

function attachQuestionListeners(host: AppHost): void {
  const pq = host.getPendingQuestion();
  if (!pq) return;

  const handleSubmitAnswers = (answers: Record<string, string | string[]>) => {
    host.postMessage({ type: 'questionAnswer', requestId: pq.requestId, answers });
    host.clearPendingQuestion();
    host.render();
  };

  const handleCancel = () => {
    // Submit empty answers on cancel
    const answers: Record<string, string> = {};
    for (const q of pq.questions) {
      answers[q.header] = '';
    }
    handleSubmitAnswers(answers);
  };

  // For single-question single-select: clicking an option immediately submits
  const isSingleQuestionSingleSelect = pq.questions.length === 1 && !pq.questions[0].multiSelect;

  // Click handlers for option buttons
  document.querySelectorAll('.question-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLElement;
      const qIdx = parseInt(el.dataset.questionIdx || '0', 10);
      const optionLabel = el.dataset.optionLabel || '';

      if (isSingleQuestionSingleSelect) {
        const answers: Record<string, string> = {};
        answers[pq.questions[qIdx].header] = optionLabel;
        handleSubmitAnswers(answers);
      } else {
        // Toggle selection state for multi-question or multi-select
        el.classList.toggle('selected');
      }
    });
  });

  // "Other" input: Enter to submit
  document.querySelectorAll('.question-other-input').forEach(input => {
    (input as HTMLInputElement).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const el = input as HTMLInputElement;
        const qIdx = parseInt(el.dataset.questionIdx || '0', 10);
        const value = el.value.trim();
        if (!value) return;

        if (isSingleQuestionSingleSelect) {
          const answers: Record<string, string> = {};
          answers[pq.questions[qIdx].header] = value;
          handleSubmitAnswers(answers);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    });
  });

  // Global keyboard shortcuts
  const otherInput = document.querySelector('.question-other-input') as HTMLInputElement | null;
  const keyHandler = (e: KeyboardEvent) => {
    if (document.activeElement && (document.activeElement as HTMLElement).classList?.contains('question-other-input')) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
      return;
    }

    // Number keys to select options (only for single-question single-select)
    if (isSingleQuestionSingleSelect) {
      const q = pq.questions[0];
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= q.options.length) {
        e.preventDefault();
        const answers: Record<string, string> = {};
        answers[q.header] = q.options[num - 1].label;
        handleSubmitAnswers(answers);
      } else if (num === q.options.length + 1) {
        // Focus the "Other" input
        e.preventDefault();
        otherInput?.focus();
      }
    }
  };
  document.addEventListener('keydown', keyHandler);

  // Clean up when panel is removed
  const observer = new MutationObserver(() => {
    if (!document.querySelector('.question-panel')) {
      document.removeEventListener('keydown', keyHandler);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// ── Plan approval panel ──────────────────────────────────────────

function attachPlanApprovalListeners(host: AppHost): void {
  const pp = host.getPendingPlanApproval();
  if (!pp) return;

  const handleApproval = (approved: boolean) => {
    host.postMessage({ type: 'planApproval', requestId: pp.requestId, approved });
    host.clearPendingPlanApproval();
    host.render();
  };

  // Click handlers
  document.querySelectorAll('[data-plan-approval]').forEach(btn => {
    btn.addEventListener('click', () => {
      const approval = (btn as HTMLElement).dataset.planApproval;
      handleApproval(approval === 'approve');
    });
  });

  // Global keyboard shortcuts
  const keyHandler = (e: KeyboardEvent) => {
    if (e.key === '1') { e.preventDefault(); handleApproval(true); }
    else if (e.key === '2') { e.preventDefault(); handleApproval(false); }
    else if (e.key === 'Escape') { e.preventDefault(); handleApproval(false); }
  };
  document.addEventListener('keydown', keyHandler);

  // Clean up when panel is removed
  const observer = new MutationObserver(() => {
    if (!document.querySelector('.plan-approval-panel')) {
      document.removeEventListener('keydown', keyHandler);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// ── Content listeners (copy, collapsible) ───────────────────────────

export function attachContentListeners(): void {
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

// ── File open listeners ─────────────────────────────────────────────

export function attachFileOpenListeners(postMessage: (msg: WebviewMessage) => void): void {
  document.querySelectorAll('[data-open-file-path]').forEach(btn => {
    if ((btn as HTMLElement).dataset.openBound === '1') {
      return;
    }
    (btn as HTMLElement).dataset.openBound = '1';
    btn.addEventListener('click', () => {
      const path = (btn as HTMLElement).dataset.openFilePath;
      if (!path) return;
      postMessage({ type: 'openFile', path });
    });
  });
}

// ── Conversation panel listeners ────────────────────────────────────

export function attachConversationPanelListeners(host: AppHost): void {
  // Click on conversation items
  document.querySelectorAll('.conversation-item').forEach(item => {
    item.addEventListener('click', (e) => {
      // Don't switch if clicking the delete button
      if ((e.target as HTMLElement).closest('.conversation-item-delete')) return;
      const id = (item as HTMLElement).dataset.id;
      if (id) {
        host.showConversationPanel = false;
        host.conversationSearch = '';
        host.postMessage({ type: 'switchConversation', conversationId: id });
      }
    });
  });

  // Delete conversation buttons
  document.querySelectorAll('.conversation-item-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = (btn as HTMLElement).dataset.deleteId;
      if (id) {
        host.postMessage({ type: 'deleteConversation', conversationId: id });
      }
    });
  });
}
