import type { AttachedFile, WebviewMessage } from '../src/protocol';
import { escapeHtml } from './markdownRenderer';
import { getFileName, getFileIcon } from './fileUtils';
import { escapeAttr } from './webviewUtils';

export interface InputHost {
  postMessage(msg: WebviewMessage): void;
  getInputElement(): HTMLTextAreaElement | null;
  onAttachedFilesChanged(): void;
}

export class InputController {
  private attachedFiles: AttachedFile[] = [];
  private showMentionMenu = false;
  private mentionFilter = '';
  private workspaceFiles: { path: string; name: string }[] = [];

  constructor(private host: InputHost) {}

  // ── Getters ──────────────────────────────────────────────────────

  get isMentionVisible(): boolean { return this.showMentionMenu; }

  getAttachedFiles(): AttachedFile[] { return this.attachedFiles; }

  hasLoadingFiles(): boolean {
    return this.attachedFiles.some(f => f.content === undefined);
  }

  // ── File handling ────────────────────────────────────────────────

  handlePickedFiles(files: { path: string; name: string }[]): void {
    for (const file of files) {
      if (!this.attachedFiles.find(f => f.path === file.path)) {
        this.attachedFiles.push({ path: file.path });
      }
    }
    this.host.postMessage({
      type: 'readFiles',
      paths: files.map(f => f.path)
    });
    this.renderAttachedFiles();
  }

  handleFileContents(files: AttachedFile[]): void {
    for (const file of files) {
      const existing = this.attachedFiles.find(f => f.path === file.path);
      if (existing) {
        existing.content = file.content;
        existing.truncated = file.truncated;
      }
    }
    this.renderAttachedFiles();
  }

  setWorkspaceFiles(files: { path: string; name: string }[]): void {
    this.workspaceFiles = files;
    this.updateMentionMenu();
  }

  // ── Input handling ───────────────────────────────────────────────

  /** Returns true if @mention was detected in the input. */
  handleInput(value: string, cursorPos: number): boolean {
    const textBeforeCursor = value.substring(0, cursorPos);
    const atMatch = textBeforeCursor.match(/@(\S*)$/);
    if (atMatch) {
      this.showMentionMenu = true;
      this.mentionFilter = atMatch[1];
      this.host.postMessage({ type: 'listWorkspaceFiles', query: this.mentionFilter });
      return true;
    }
    this.showMentionMenu = false;
    return false;
  }

  /** Handle Enter key — insert mention if menu is visible. Returns true if handled. */
  handleEnterKey(): boolean {
    if (!this.showMentionMenu) { return false; }
    this.insertMention();
    return true;
  }

  /** Handle Escape key — close mention menu if visible. Returns true if handled. */
  handleEscapeKey(): boolean {
    if (!this.showMentionMenu) { return false; }
    this.showMentionMenu = false;
    return true;
  }

  // ── Send support ─────────────────────────────────────────────────

  canSend(content: string): boolean {
    if (!content && this.attachedFiles.length === 0) { return false; }
    if (this.attachedFiles.length > 0 && this.hasLoadingFiles()) { return false; }
    return true;
  }

  /** Remove and return all attached files (for sending). */
  consumeAttachedFiles(): AttachedFile[] {
    const files = [...this.attachedFiles];
    this.attachedFiles = [];
    this.renderAttachedFiles();
    return files;
  }

  // ── Rendering ────────────────────────────────────────────────────

  renderAttachedFilesHtml(): string {
    if (this.attachedFiles.length === 0) { return ''; }

    return `
      <div class="attached-files" id="attached-files">
        ${this.attachedFiles.map((f, i) => `
          <div class="file-chip ${f.content === undefined ? 'loading' : ''}">
            <button class="file-open-btn" data-open-file-path="${escapeAttr(f.path)}" title="Open ${escapeAttr(getFileName(f.path))}">
              <span class="file-icon">${getFileIcon(f.path)}</span>
              <span class="file-name">${escapeHtml(getFileName(f.path))}</span>
            </button>
            ${f.content === undefined ? '<span class="file-loading-indicator">⏳</span>' : ''}
            <button class="remove-file" data-index="${i}">×</button>
          </div>
        `).join('')}
      </div>
    `;
  }

  renderMentionMenuHtml(): string {
    const filtered = this.workspaceFiles.filter(f =>
      f.name.toLowerCase().includes(this.mentionFilter.toLowerCase()) ||
      f.path.toLowerCase().includes(this.mentionFilter.toLowerCase())
    );

    return `
      <div class="mention-menu" id="mention-menu">
        ${filtered.length === 0 ? '<div class="no-results">No files found</div>' : ''}
        ${filtered.slice(0, 10).map(f => `
          <div class="mention-item" data-path="${escapeAttr(f.path)}">
            <span class="file-name">${escapeHtml(f.name)}</span>
            <span class="file-path">${escapeHtml(f.path)}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  renderAttachedFiles(): void {
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
    this.host.onAttachedFilesChanged();
  }

  updateMentionMenu(): void {
    const existing = document.getElementById('mention-menu');
    if (existing) {
      existing.outerHTML = this.renderMentionMenuHtml();
      this.attachMentionListeners();
    }
  }

  // ── Listeners ────────────────────────────────────────────────────

  attachMentionListeners(): void {
    document.querySelectorAll('.mention-item').forEach(item => {
      item.addEventListener('click', () => {
        const path = (item as HTMLElement).dataset.path;
        if (path) {
          this.addFileFromMention(path);
        }
      });
    });
  }

  attachFileRemoveListeners(): void {
    document.querySelectorAll('.remove-file').forEach(btn => {
      btn.addEventListener('click', () => {
        const index = parseInt((btn as HTMLElement).dataset.index || '0', 10);
        this.attachedFiles.splice(index, 1);
        this.renderAttachedFiles();
      });
    });
  }

  dispose(): void {
    this.attachedFiles = [];
    this.showMentionMenu = false;
  }

  // ── Private ──────────────────────────────────────────────────────

  private insertMention(): void {
    const firstItem = document.querySelector('.mention-item') as HTMLElement;
    if (firstItem?.dataset.path) {
      this.addFileFromMention(firstItem.dataset.path);
    }
  }

  private addFileFromMention(filePath: string): void {
    const input = this.host.getInputElement();
    if (!input) { return; }

    // Remove the @query from input
    const value = input.value;
    const cursorPos = input.selectionStart;
    const textBeforeCursor = value.substring(0, cursorPos);
    const newTextBefore = textBeforeCursor.replace(/@\S*$/, '');
    input.value = newTextBefore + value.substring(cursorPos);

    // Add file to attachments
    if (!this.attachedFiles.find(f => f.path === filePath)) {
      this.attachedFiles.push({ path: filePath });
      this.host.postMessage({ type: 'readFiles', paths: [filePath] });
    }

    this.showMentionMenu = false;
    this.renderAttachedFiles();
    input.focus();
  }
}
