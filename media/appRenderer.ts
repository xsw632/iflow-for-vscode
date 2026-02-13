// Pure HTML rendering functions for the IFlow webview.
// These are stateless functions that produce HTML strings from data.

import type {
  ConversationMode,
  OutputBlock,
  Message,
  Conversation,
} from '../src/protocol';
import { MODELS } from '../src/protocol';
import { escapeHtml, renderMarkdown } from './markdownRenderer';
import { getToolHeadline, renderToolDetailPreview } from './toolRenderers';
import { getFileName, getFileIcon } from './fileUtils';
import { escapeAttr } from './webviewUtils';

export interface PendingConfirmation {
  requestId: number;
  toolName: string;
  description: string;
}

export interface PendingQuestion {
  requestId: number;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
}

export interface PendingPlanApproval {
  requestId: number;
  plan: string;
}

// ── Utility helpers ─────────────────────────────────────────────────

function timeAgo(timestamp: number, now: number): string {
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getModeLabel(mode: ConversationMode): string {
  switch (mode) {
    case 'default': return 'Chat';
    case 'yolo': return 'YOLO';
    case 'plan': return 'Plan';
    case 'smart': return 'Smart';
    default: return 'Chat';
  }
}

function getPieSlicePath(cx: number, cy: number, r: number, percent: number, usedTokens: number): string {
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

// ── Top bar ─────────────────────────────────────────────────────────

export function renderTopBar(title: string, conversationPanelHtml: string): string {
  return `
    <div class="top-bar">
      <div class="conversation-selector">
        <button id="conversation-trigger" class="conversation-trigger" title="Switch conversation">
          <span>${title}</span>
          <span class="chevron">▼</span>
        </button>
        ${conversationPanelHtml}
      </div>
      <div class="toolbar">
         <button id="new-conversation-top-btn" class="icon-btn" title="New Chat">
           <span class="icon">+</span>
         </button>
      </div>
    </div>
  `;
}

export function renderConversationPanel(opts: {
  conversations: Conversation[];
  search: string;
  showPanel: boolean;
  currentConversationId: string | null;
}): string {
  const { conversations, search, showPanel, currentConversationId } = opts;
  const filtered = conversations.filter(c =>
    search === '' ||
    c.title.toLowerCase().includes(search.toLowerCase())
  );

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
    <div class="conversation-panel ${showPanel ? '' : 'hidden'}" id="conversation-panel">
      <div class="conversation-panel-search">
        <input type="text" id="conversation-search" placeholder="Search sessions..." value="${escapeAttr(search)}" />
      </div>
      <div class="conversation-panel-list">
        ${groups.length === 0 ? '<div class="conversation-panel-empty">No conversations found</div>' : ''}
        ${groups.map(g => `
          <div class="conversation-group-label">${g.label}</div>
          ${g.items.map(c => `
            <div class="conversation-item ${c.id === currentConversationId ? 'active' : ''}" data-id="${c.id}">
              <div class="conversation-item-info">
                <div class="conversation-item-title">${escapeHtml(c.title)}</div>
                <div class="conversation-item-meta">
                  <span>${c.messages.length} messages</span>
                </div>
              </div>
              <span class="conversation-item-time">${timeAgo(c.updatedAt, now)}</span>
              <button class="conversation-item-delete" data-delete-id="${c.id}" title="Delete">&times;</button>
            </div>
          `).join('')}
        `).join('')}
      </div>
    </div>
  `;
}

// ── Mode popup ──────────────────────────────────────────────────────

function renderModePopup(mode: ConversationMode, isThinking: boolean, showModeMenu: boolean): string {
  return `
    <div class="mode-popup ${showModeMenu ? '' : 'hidden'}" id="mode-popup">
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

// ── Messages ────────────────────────────────────────────────────────

export function renderMessages(conversation: Conversation | null, isStreaming: boolean, faviconUri: string): string {
  if (!conversation || conversation.messages.length === 0) {
    return `
      <div class="messages" id="messages-container">
        <div class="empty-state">
          <div class="logo"><img src="${faviconUri}" alt="IFlow" class="logo-icon" /></div>
          <h2>Welcome to IFlow</h2>
          <p>Start a conversation by typing a message below.</p>
          <p class="hint">Use / for commands, @ to mention files</p>
        </div>
      </div>
    `;
  }

  return `
    <div class="messages" id="messages-container">
      ${conversation.messages.map(m => renderMessage(m)).join('')}
      ${isStreaming ? renderPendingIndicator(faviconUri) : ''}
    </div>
  `;
}

function renderMessage(message: Message): string {
  const isUser = message.role === 'user';

  return `
    <div class="message ${isUser ? 'user' : 'assistant'}">
      <div class="message-header">
        <span class="role">${isUser ? 'You' : 'IFlow'}</span>
        <span class="timestamp">${formatTime(message.timestamp)}</span>
      </div>
      ${message.attachedFiles.length > 0 ? `
        <div class="attached-files-display">
          ${message.attachedFiles.map(f => `
            <button class="file-chip small file-open-btn" data-open-file-path="${escapeAttr(f.path)}" title="Open ${escapeAttr(getFileName(f.path))}">
              <span class="file-icon">${getFileIcon(f.path)}</span>
              <span class="file-name">${escapeHtml(getFileName(f.path))}</span>
            </button>
          `).join('')}
        </div>
      ` : ''}
      <div class="message-content">
        ${message.blocks.map(b => renderBlock(b)).join('')}
      </div>
    </div>
  `;
}

export function renderBlock(block: OutputBlock): string {
  switch (block.type) {
    case 'text':
      return `<div class="block-text">${renderMarkdown(block.content)}</div>`;

    case 'code':
      return `
        <div class="block-code">
          <div class="code-header">
            <span class="language">${block.language}${block.filename ? ` - ${block.filename}` : ''}</span>
            <button class="copy-btn" data-content="${escapeAttr(block.content)}">Copy</button>
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

    case 'plan':
      return renderPlanBlock(block.entries);

    case 'warning':
      return `
        <div class="block-warning">
          <span class="icon">⚠</span>
          <span>${escapeHtml(block.message)}</span>
        </div>
      `;
  }
}

function renderPlanBlock(entries: Array<{ content: string; status: string; priority: string }>): string {
  const completed = entries.filter(e => e.status === 'completed').length;
  const total = entries.length;

  const entriesHtml = entries.map(entry => {
    let icon: string;
    let statusClass: string;
    switch (entry.status) {
      case 'completed':
        icon = '✓';
        statusClass = 'completed';
        break;
      case 'in_progress':
        icon = '⏳';
        statusClass = 'in-progress';
        break;
      default:
        icon = '○';
        statusClass = 'pending';
    }
    return `
      <div class="plan-entry ${statusClass}">
        <span class="plan-entry-icon ${statusClass}">${icon}</span>
        <span class="plan-entry-text">${escapeHtml(entry.content)}</span>
      </div>
    `;
  }).join('');

  return `
    <div class="block-plan">
      <div class="plan-header">
        <span class="plan-icon">📋</span>
        <span class="plan-title">Execution Plan</span>
        <span class="plan-progress">${completed}/${total}</span>
      </div>
      <div class="plan-entries">
        ${entriesHtml}
      </div>
    </div>
  `;
}

export function renderPendingIndicator(faviconUri: string): string {
  return `
    <div class="pending-indicator">
      <div class="bounce-logo"><img src="${faviconUri}" alt="IFlow" class="bounce-logo-icon" /></div>
      <span>Flowing...</span>
    </div>
  `;
}

// ── Composer ────────────────────────────────────────────────────────

export function renderComposer(opts: {
  conversation: Conversation | null;
  isStreaming: boolean;
  pendingConfirmation: PendingConfirmation | null;
  pendingQuestion: PendingQuestion | null;
  pendingPlanApproval: PendingPlanApproval | null;
  attachedFilesHtml: string;
  slashMenuHtml: string;
  mentionMenuHtml: string;
  contextUsage: { percent: number; usedTokens: number; totalTokens: number } | undefined;
  showModeMenu: boolean;
}): string {
  if (opts.pendingConfirmation) {
    return renderApprovalPanel(opts.pendingConfirmation);
  }

  if (opts.pendingQuestion) {
    return renderQuestionPanel(opts.pendingQuestion);
  }

  if (opts.pendingPlanApproval) {
    return renderPlanApprovalPanel(opts.pendingPlanApproval);
  }

  const conversation = opts.conversation;
  const isThinking = conversation?.think ?? false;
  const currentModel = conversation?.model ?? 'GLM-4.7';

  return `
    <div class="composer">
      ${opts.attachedFilesHtml}
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
          ${opts.slashMenuHtml}
          ${opts.mentionMenuHtml}
        </div>
        ${opts.isStreaming ? `
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
                <span>${getModeLabel(conversation?.mode || 'default')}</span>
                <span class="chevron">▾</span>
              </button>
              ${renderModePopup(conversation?.mode || 'default', isThinking, opts.showModeMenu)}
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
        ${renderContextUsage(opts.contextUsage)}
      </div>
    </div>
  `;
}

function renderContextUsage(usage: { percent: number; usedTokens: number; totalTokens: number } | undefined): string {
  if (!usage) return '';
  const percent = usage.percent;
  const colorClass = percent >= 80 ? 'context-high' : percent >= 50 ? 'context-mid' : 'context-low';
  const label = percent === 0 && usage.usedTokens > 0 ? '<1%' : `${percent}%`;
  const piePath = getPieSlicePath(18, 18, 16, percent, usage.usedTokens);
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

function renderApprovalPanel(conf: PendingConfirmation): string {
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

function renderQuestionPanel(pq: PendingQuestion): string {
  // Render each question with its options
  const questionsHtml = pq.questions.map((q, qIdx) => {
    let keyIndex = 1;
    const optionsHtml = q.options.map((opt) => {
      const key = keyIndex++;
      return `
        <button class="approval-option question-option" data-question-idx="${qIdx}" data-option-label="${escapeAttr(opt.label)}">
          <span class="approval-key">${key}</span>
          <span class="approval-label">${escapeHtml(opt.label)}</span>
          ${opt.description ? `<span class="option-description">${escapeHtml(opt.description)}</span>` : ''}
        </button>
      `;
    }).join('');

    // "Other" free-text input as last option
    const otherKey = keyIndex;
    const otherHtml = `
      <div class="approval-option feedback-option">
        <span class="approval-key">${otherKey}</span>
        <input
          type="text"
          class="approval-feedback-input question-other-input"
          data-question-idx="${qIdx}"
          placeholder="Other..."
        />
      </div>
    `;

    return `
      <div class="question-item" data-question-idx="${qIdx}" data-question-header="${escapeAttr(q.header)}">
        <div class="question-text">${escapeHtml(q.question)}</div>
        <div class="approval-options">
          ${optionsHtml}
          ${otherHtml}
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="composer question-panel" data-request-id="${pq.requestId}">
      ${questionsHtml}
      <div class="approval-hint">Esc to cancel</div>
    </div>
  `;
}

function renderPlanApprovalPanel(pp: PendingPlanApproval): string {
  const planContentHtml = pp.plan
    ? `<div class="plan-content">${renderMarkdown(pp.plan)}</div>`
    : '';

  return `
    <div class="composer plan-approval-panel" data-request-id="${pp.requestId}">
      <div class="plan-approval-question">Approve this plan?</div>
      ${planContentHtml}
      <div class="approval-options">
        <button class="approval-option" data-plan-approval="approve">
          <span class="approval-key">1</span>
          <span class="approval-label">Approve</span>
        </button>
        <button class="approval-option" data-plan-approval="reject">
          <span class="approval-key">2</span>
          <span class="approval-label">Reject</span>
        </button>
      </div>
      <div class="approval-hint">Esc to reject</div>
    </div>
  `;
}
