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
  MODELS
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
    return this.state;
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

  private applyChunkToMessage(message: Message, chunk: StreamChunk): void {
    const blocks = message.blocks;

    switch (chunk.chunkType) {
      case 'text': {
        const lastBlock = blocks[blocks.length - 1];
        if (lastBlock?.type === 'text') {
          lastBlock.content += chunk.content;
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
        const codeBlock = blocks[blocks.length - 1];
        if (codeBlock?.type === 'code') {
          codeBlock.content += chunk.content;
        }
        break;
      }

      case 'code_end':
        // Code block is already complete
        break;

      case 'tool_start': {
        // If the last block is a running tool with the same name, update it
        // (SDK sends pending first, then in_progress with actual args/label)
        const lastToolBlock = blocks[blocks.length - 1];
        if (lastToolBlock?.type === 'tool' && lastToolBlock.status === 'running' && lastToolBlock.name === chunk.name) {
          if (chunk.input && Object.keys(chunk.input).length > 0) {
            lastToolBlock.input = chunk.input;
          }
          if (chunk.label) {
            lastToolBlock.label = chunk.label;
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
        const toolBlock = blocks[blocks.length - 1];
        if (toolBlock?.type === 'tool') {
          toolBlock.output += chunk.content;
        }
        break;
      }

      case 'tool_end': {
        const toolEndBlock = blocks[blocks.length - 1];
        if (toolEndBlock?.type === 'tool') {
          toolEndBlock.status = chunk.status;
        }
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
        const thinkingBlock = blocks[blocks.length - 1];
        if (thinkingBlock?.type === 'thinking') {
          thinkingBlock.content += chunk.content;
        }
        break;
      }

      case 'thinking_end': {
        const thinkingEndBlock = blocks[blocks.length - 1];
        if (thinkingEndBlock?.type === 'thinking') {
          thinkingEndBlock.collapsed = true;
        }
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

      case 'error':
        blocks.push({ type: 'error', message: chunk.message });
        break;

      case 'warning':
        blocks.push({ type: 'warning', message: chunk.message });
        break;
    }
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
      this.onStateChange(this.state);
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
