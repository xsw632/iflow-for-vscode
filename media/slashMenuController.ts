import type { ConversationMode, ModelType, Conversation, WebviewMessage } from '../src/protocol';
import { MODELS } from '../src/protocol';

const SLASH_COMMANDS = [
  { command: '/', description: 'Show all commands' },
  { command: '/new', description: 'Start a new conversation' },
  { command: '/clear', description: 'Clear current conversation' },
  { command: '/compact', description: 'Compress conversation context' },
  { command: '/mode', description: 'Change conversation mode' },
  { command: '/think', description: 'Toggle thinking mode' },
  { command: '/model', description: 'Change model' },
  { command: '/help', description: 'Show help' }
];

export interface SlashMenuHost {
  postMessage(msg: WebviewMessage): void;
  getCurrentConversation(): Conversation | null;
  getInputElement(): HTMLTextAreaElement | null;
  onSlashMenuClosed(): void;
}

export class SlashMenuController {
  private visible = false;
  private filter = '';
  private mode: 'commands' | 'models' | 'modes' = 'commands';
  private selectedIndex = 0;

  constructor(private host: SlashMenuHost) {}

  get isVisible(): boolean { return this.visible; }

  // ── Input handling ───────────────────────────────────────────────

  /** Returns true if the input was handled by slash menu (starts with /). */
  handleInput(value: string): boolean {
    if (!value.startsWith('/')) {
      this.visible = false;
      this.update();
      return false;
    }

    if (!this.visible) {
      this.mode = 'commands';
    }
    this.visible = true;
    this.filter = value;
    if (this.mode === 'commands') {
      this.selectedIndex = 0;
    }
    this.update();
    return true;
  }

  /** Returns true if the key was handled. */
  handleKeyDown(e: KeyboardEvent): boolean {
    if (!this.visible) { return false; }

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const items = this.getMenuItems();
      if (e.key === 'ArrowUp') {
        this.selectedIndex = (this.selectedIndex - 1 + items.length) % items.length;
      } else {
        this.selectedIndex = (this.selectedIndex + 1) % items.length;
      }
      this.update();
      return true;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.executeSelected();
      return true;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      if (this.mode !== 'commands') {
        this.mode = 'commands';
        this.selectedIndex = 0;
        this.update();
      } else {
        this.close();
      }
      return true;
    }

    return false;
  }

  // ── Rendering ────────────────────────────────────────────────────

  /** Returns the HTML string for the slash menu (for initial render). */
  renderHtml(): string {
    const items = this.getMenuItems();
    return `
      <div class="slash-menu" id="slash-menu">
        ${items.map((item, i) => `
          <div class="slash-item ${i === this.selectedIndex ? 'selected' : ''}" data-index="${i}">
            <span class="command">${item.label}</span>
            <span class="description">${item.description}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  /** Update the DOM in-place (create/remove/refresh the menu element). */
  update(): void {
    let menu = document.getElementById('slash-menu');
    if (!this.visible) {
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
    if (!menu) { return; }

    const items = this.getMenuItems();
    if (this.selectedIndex >= items.length) { this.selectedIndex = items.length - 1; }
    if (this.selectedIndex < 0) { this.selectedIndex = 0; }

    menu.innerHTML = items.map((item, i) => `
      <div class="slash-item ${i === this.selectedIndex ? 'selected' : ''}" data-index="${i}">
        <span class="command">${item.label}</span>
        <span class="description">${item.description}</span>
      </div>
    `).join('');

    this.attachListeners();
    const selected = menu.querySelector('.slash-item.selected');
    selected?.scrollIntoView({ block: 'nearest' });
  }

  /** Bind click/hover on .slash-item elements. Call after DOM update. */
  attachListeners(): void {
    document.querySelectorAll('.slash-item').forEach(item => {
      item.addEventListener('click', () => {
        const index = parseInt((item as HTMLElement).dataset.index || '0', 10);
        this.selectedIndex = index;
        this.executeSelected();
      });
      item.addEventListener('mouseenter', () => {
        const index = parseInt((item as HTMLElement).dataset.index || '0', 10);
        this.selectedIndex = index;
        document.querySelectorAll('.slash-item').forEach((el, i) => {
          el.classList.toggle('selected', i === index);
        });
      });
    });
  }

  // ── Close / reset ────────────────────────────────────────────────

  close(): void {
    this.visible = false;
    this.mode = 'commands';
    this.selectedIndex = 0;
    const input = this.host.getInputElement();
    if (input) { input.value = ''; }
    this.update();
    this.host.onSlashMenuClosed();
  }

  dispose(): void {
    this.visible = false;
  }

  // ── Private ──────────────────────────────────────────────────────

  private getMenuItems(): { label: string; description: string; value: string; action: string }[] {
    if (this.mode === 'models') {
      const currentModel = this.host.getCurrentConversation()?.model ?? 'GLM-4.7';
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
    if (this.mode === 'modes') {
      const currentMode = this.host.getCurrentConversation()?.mode ?? 'default';
      const modes = [
        { value: 'default', label: 'Chat', desc: 'Normal conversation' },
        { value: 'yolo', label: 'YOLO', desc: 'Auto-approve actions' },
        { value: 'plan', label: 'Plan', desc: 'Plan before executing' },
        { value: 'smart', label: 'Smart', desc: 'AI-driven edits' },
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
      .filter(c => c.command.toLowerCase().includes(this.filter.toLowerCase()))
      .map(c => ({
        label: c.command,
        description: c.description + (c.command === '/mode' || c.command === '/model' ? '  →' : ''),
        value: c.command,
        action: 'command'
      }));
  }

  private executeSelected(): void {
    const items = this.getMenuItems();
    const selected = items[this.selectedIndex];
    if (!selected) { return; }

    switch (selected.action) {
      case 'back':
        this.mode = 'commands';
        this.selectedIndex = 0;
        this.update();
        break;
      case 'selectModel':
        this.host.postMessage({ type: 'setModel', model: selected.value as ModelType });
        this.close();
        break;
      case 'selectMode':
        this.host.postMessage({ type: 'setMode', mode: selected.value as ConversationMode });
        this.close();
        break;
      case 'command':
        this.executeCommand(selected.value);
        break;
    }
  }

  private executeCommand(command: string): void {
    switch (command) {
      case '/new':
        this.host.postMessage({ type: 'newConversation' });
        break;
      case '/clear':
        this.host.postMessage({ type: 'clearConversation' });
        break;
      case '/compact':
        this.host.postMessage({ type: 'sendMessage', content: '/compact', attachedFiles: [] });
        break;
      case '/mode':
        this.mode = 'modes';
        this.selectedIndex = 0;
        this.update();
        return;
      case '/think': {
        const conv = this.host.getCurrentConversation();
        this.host.postMessage({ type: 'setThink', enabled: !(conv?.think ?? false) });
        break;
      }
      case '/model':
        this.mode = 'models';
        this.selectedIndex = 0;
        this.update();
        return;
      case '/help':
        break;
    }
    this.close();
  }
}
