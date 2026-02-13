import * as vscode from 'vscode';
import {
  Conversation,
  ConversationState,
  ConversationMode,
  ModelType,
  Message,
  OutputBlock,
  AttachedFile,
  StreamChunk,
  MODELS,
  MODEL_CONTEXT_SIZES
} from './protocol';

const STORAGE_KEY = 'iflow.conversations';

export class ConversationStore {
  private state: ConversationState;
  private memento: vscode.Memento;
  private onStateChange: (state: ConversationState) => void;
  private suppressNotify = false;

  constructor(memento: vscode.Memento, onStateChange: (state: ConversationState) => void) {
    this.memento = memento;
    this.onStateChange = onStateChange;

    // Load saved conversations and CLI status
    const saved = memento.get<{ conversations: Conversation[]; currentId: string | null; cliAvailable?: boolean; cliVersion?: string | null }>(STORAGE_KEY);

    this.state = {
      currentConversationId: saved?.currentId || null,
      conversations: saved?.conversations || [],
      cliAvailable: true,
      cliVersion: saved?.cliVersion ?? null,
      cliDiagnostics: null,
      isStreaming: false
    };
  }

  getState(): ConversationState {
    return {
      ...this.state,
      contextUsage: this.getContextUsage(),
    };
  }

  getCurrentConversation(): Conversation | null {
    if (!this.state.currentConversationId) return null;
    return this.state.conversations.find(c => c.id === this.state.currentConversationId) || null;
  }

  setCliStatus(available: boolean, version: string | null, diagnostics?: string): void {
    this.state.cliAvailable = available;
    this.state.cliVersion = version;
    this.state.cliDiagnostics = diagnostics ?? null;
    this.save();
    this.notifyChange();
  }

  setStreaming(streaming: boolean): void {
    this.state.isStreaming = streaming;
    this.notifyChange();
  }

  newConversation(): Conversation {
    const conversation: Conversation = {
      id: this.generateId(),
      title: 'New Conversation',
      messages: [],
      mode: 'default',
      think: false,
      model: MODELS[0],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.state.conversations.unshift(conversation);
    this.state.currentConversationId = conversation.id;
    this.save();
    this.notifyChange();
    return conversation;
  }

  switchConversation(conversationId: string): void {
    const conversation = this.state.conversations.find(c => c.id === conversationId);
    if (conversation) {
      this.state.currentConversationId = conversationId;
      this.save();
      this.notifyChange();
    }
  }

  deleteConversation(conversationId: string): void {
    const index = this.state.conversations.findIndex(c => c.id === conversationId);
    if (index !== -1) {
      this.state.conversations.splice(index, 1);
      if (this.state.currentConversationId === conversationId) {
        this.state.currentConversationId = this.state.conversations[0]?.id || null;
      }
      this.save();
      this.notifyChange();
    }
  }

  clearCurrentConversation(): void {
    const conversation = this.getCurrentConversation();
    if (conversation) {
      conversation.messages = [];
      conversation.title = 'New Conversation';
      conversation.sessionId = undefined;
      conversation.updatedAt = Date.now();
      this.save();
      this.notifyChange();
    }
  }

  setMode(mode: ConversationMode): void {
    const conversation = this.getCurrentConversation();
    if (conversation) {
      conversation.mode = mode;
      conversation.updatedAt = Date.now();
      this.save();
      this.notifyChange();
    }
  }

  setThink(enabled: boolean): void {
    const conversation = this.getCurrentConversation();
    if (conversation) {
      conversation.think = enabled;
      conversation.updatedAt = Date.now();
      this.save();
      this.notifyChange();
    }
  }

  setModel(model: ModelType): void {
    const conversation = this.getCurrentConversation();
    if (conversation) {
      conversation.model = model;
      conversation.updatedAt = Date.now();
      this.save();
      this.notifyChange();
    }
  }

  setSessionId(sessionId: string): void {
    const conversation = this.getCurrentConversation();
    if (conversation) {
      conversation.sessionId = sessionId;
      this.save();
    }
  }

  addUserMessage(content: string, attachedFiles: AttachedFile[]): Message {
    let conversation = this.getCurrentConversation();
    if (!conversation) {
      conversation = this.newConversation();
    }

    const message: Message = {
      id: this.generateId(),
      role: 'user',
      content,
      blocks: [{ type: 'text', content }],
      attachedFiles,
      timestamp: Date.now()
    };

    conversation.messages.push(message);

    // Update title from first user message
    if (conversation.messages.filter(m => m.role === 'user').length === 1) {
      conversation.title = this.deriveTitle(content);
    }

    conversation.updatedAt = Date.now();
    this.save();
    this.notifyChange();
    return message;
  }

  startAssistantMessage(): Message {
    const conversation = this.getCurrentConversation();
    if (!conversation) {
      throw new Error('No current conversation');
    }

    const message: Message = {
      id: this.generateId(),
      role: 'assistant',
      content: '',
      blocks: [],
      attachedFiles: [],
      timestamp: Date.now(),
      streaming: true
    };

    conversation.messages.push(message);
    conversation.updatedAt = Date.now();
    this.notifyChange();
    return message;
  }

  appendToAssistantMessage(chunk: StreamChunk): void {
    const conversation = this.getCurrentConversation();
    if (!conversation) return;

    const message = conversation.messages[conversation.messages.length - 1];
    if (!message || message.role !== 'assistant') return;

    this.applyChunkToMessage(message, chunk);
    this.notifyChange();
  }

  endAssistantMessage(): void {
    const conversation = this.getCurrentConversation();
    if (!conversation) return;

    const message = conversation.messages[conversation.messages.length - 1];
    if (!message || message.role !== 'assistant') return;

    message.streaming = false;

    // Collapse thinking blocks
    for (const block of message.blocks) {
      if (block.type === 'thinking') {
        block.collapsed = true;
      }
    }

    conversation.updatedAt = Date.now();
    this.save();
    this.notifyChange();
  }

  /** Find the last block of a given type, or null if the last block is a different type. */
  private findLastBlock<T extends OutputBlock['type']>(
    blocks: OutputBlock[],
    type: T
  ): Extract<OutputBlock, { type: T }> | null {
    const last = blocks[blocks.length - 1];
    if (last?.type === type) {
      return last as Extract<OutputBlock, { type: T }>;
    }
    return null;
  }

  private applyChunkToMessage(message: Message, chunk: StreamChunk): void {
    const blocks = message.blocks;

    switch (chunk.chunkType) {
      case 'text': {
        const lastText = this.findLastBlock(blocks, 'text');
        if (lastText) {
          lastText.content += chunk.content;
        } else {
          blocks.push({ type: 'text', content: chunk.content });
        }
        message.content += chunk.content;
        break;
      }

      case 'code_start':
        blocks.push({
          type: 'code',
          language: chunk.language,
          filename: chunk.filename,
          content: ''
        });
        break;

      case 'code_content': {
        const codeBlock = this.findLastBlock(blocks, 'code');
        if (codeBlock) { codeBlock.content += chunk.content; }
        break;
      }

      case 'code_end':
        // Code block is already complete
        break;

      case 'tool_start': {
        // If the last block is a running tool with the same name, update it
        // (SDK sends pending first, then in_progress with actual args/label)
        const lastTool = this.findLastBlock(blocks, 'tool');
        if (lastTool && lastTool.status === 'running' && lastTool.name === chunk.name) {
          if (chunk.input && Object.keys(chunk.input).length > 0) {
            lastTool.input = { ...lastTool.input, ...chunk.input };
          }
          if (chunk.label) {
            lastTool.label = chunk.label;
          }
        } else {
          blocks.push({
            type: 'tool',
            name: chunk.name,
            input: chunk.input,
            output: '',
            status: 'running',
            label: chunk.label
          });
        }
        break;
      }

      case 'tool_output': {
        const toolBlock = this.findLastBlock(blocks, 'tool');
        if (toolBlock) { toolBlock.output += chunk.content; }
        break;
      }

      case 'tool_end': {
        const toolBlock = this.findLastBlock(blocks, 'tool');
        if (toolBlock) { toolBlock.status = chunk.status; }
        break;
      }

      case 'thinking_start':
        blocks.push({
          type: 'thinking',
          content: '',
          collapsed: false
        });
        break;

      case 'thinking_content': {
        const thinkingBlock = this.findLastBlock(blocks, 'thinking');
        if (thinkingBlock) { thinkingBlock.content += chunk.content; }
        break;
      }

      case 'thinking_end': {
        const thinkingBlock = this.findLastBlock(blocks, 'thinking');
        if (thinkingBlock) { thinkingBlock.collapsed = true; }
        break;
      }

      case 'file_ref':
        blocks.push({
          type: 'file_ref',
          path: chunk.path,
          lineStart: chunk.lineStart,
          lineEnd: chunk.lineEnd
        });
        break;

      case 'tool_confirmation':
        // Handled directly by the webview (composer becomes approval UI).
        // No block added — the tool_start chunk already added a running tool block.
        break;

      case 'plan': {
        // Plan updates are full snapshots — replace any existing plan block
        const existingPlanIdx = blocks.findIndex(b => b.type === 'plan');
        const planBlock: OutputBlock = { type: 'plan', entries: chunk.entries };
        if (existingPlanIdx !== -1) {
          blocks[existingPlanIdx] = planBlock;
        } else {
          blocks.push(planBlock);
        }
        break;
      }

      case 'error':
        blocks.push({ type: 'error', message: chunk.message });
        break;

      case 'warning':
        blocks.push({ type: 'warning', message: chunk.message });
        break;
    }
  }

  private getContextUsage(): { usedTokens: number; totalTokens: number; percent: number } {
    const conversation = this.getCurrentConversation();
    if (!conversation) {
      return { usedTokens: 0, totalTokens: 128000, percent: 0 };
    }

    const totalTokens = MODEL_CONTEXT_SIZES[conversation.model] || 128000;
    let usedTokens = 0;

    for (const msg of conversation.messages) {
      usedTokens += this.estimateTokens(msg.content);
      for (const block of msg.blocks) {
        if (block.type === 'tool' && block.output) {
          usedTokens += this.estimateTokens(block.output);
        }
      }
      if (msg.attachedFiles) {
        for (const file of msg.attachedFiles) {
          if (file.content) {
            usedTokens += this.estimateTokens(file.content);
          }
        }
      }
    }

    const percent = totalTokens > 0 ? Math.min(100, Math.round((usedTokens / totalTokens) * 100)) : 0;
    return { usedTokens, totalTokens, percent };
  }

  private estimateTokens(text: string): number {
    if (!text) return 0;
    let tokens = 0;
    for (const ch of text) {
      // CJK characters: roughly 0.5 tokens per character (2 chars per token)
      if (ch.charCodeAt(0) > 0x2E80) {
        tokens += 0.5;
      } else {
        // Latin/ASCII: roughly 0.25 tokens per character (4 chars per token)
        tokens += 0.25;
      }
    }
    return Math.ceil(tokens);
  }

  private deriveTitle(content: string): string {
    // Take first line or first 50 chars
    const firstLine = content.split('\n')[0].trim();
    if (firstLine.length <= 50) {
      return firstLine || 'New Conversation';
    }
    return firstLine.substring(0, 47) + '...';
  }

  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
  }

  private save(): void {
    this.memento.update(STORAGE_KEY, {
      conversations: this.state.conversations,
      currentId: this.state.currentConversationId,
      cliAvailable: this.state.cliAvailable,
      cliVersion: this.state.cliVersion
    });
  }

  private notifyChange(): void {
    if (!this.suppressNotify) {
      this.onStateChange(this.getState());
    }
  }

  /**
   * Batch multiple store operations into a single notification.
   * Suppresses notifyChange during fn(), then fires one notification at the end.
   */
  batchUpdate(fn: () => void): void {
    this.suppressNotify = true;
    fn();
    this.suppressNotify = false;
    this.notifyChange();
  }
}
