// Message types for communication between extension and webview

export type ConversationMode = 'default' | 'yolo' | 'plan' | 'smart';

export const MODELS = [
  'GLM-4.7',
  'DeepSeek-V3.2',
  'iFlow-ROME-30BA3B(Preview)',
  'Qwen3-Coder-Plus',
  'Kimi-K2-Thinking',
  'MiniMax-M2.1',
  'Kimi-K2-0905',
  'Kimi-K2.5'
] as const;

export type ModelType = typeof MODELS[number];

// Stream chunk types from CLI output
export type StreamChunk =
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

// Output blocks in messages
export type OutputBlock =
  | { type: 'text'; content: string }
  | { type: 'code'; language: string; filename?: string; content: string }
  | { type: 'tool'; name: string; input: Record<string, unknown>; output: string; status: 'running' | 'completed' | 'error'; label?: string }
  | { type: 'thinking'; content: string; collapsed: boolean }
  | { type: 'file_ref'; path: string; lineStart?: number; lineEnd?: number }
  | { type: 'error'; message: string }
  | { type: 'warning'; message: string };

// Message in conversation
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  blocks: OutputBlock[];
  attachedFiles: AttachedFile[];
  timestamp: number;
  streaming?: boolean;
}

// Attached file
export interface AttachedFile {
  path: string;
  content?: string;
  truncated?: boolean;
}

// Conversation state
export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  mode: ConversationMode;
  think: boolean;
  model: ModelType;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationState {
  currentConversationId: string | null;
  conversations: Conversation[];
  cliAvailable: boolean;
  cliVersion: string | null;
  cliDiagnostics: string | null;
  isStreaming: boolean;
}

// Messages from webview to extension
export type WebviewMessage =
  | { type: 'pickFiles' }
  | { type: 'listWorkspaceFiles'; query: string }
  | { type: 'readFiles'; paths: string[] }
  | { type: 'openFile'; path: string }
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

// Messages from extension to webview
export type ExtensionMessage =
  | { type: 'pickedFiles'; files: { path: string; name: string }[] }
  | { type: 'workspaceFiles'; files: { path: string; name: string }[] }
  | { type: 'fileContents'; files: AttachedFile[] }
  | { type: 'stateUpdated'; state: ConversationState }
  | { type: 'streamChunk'; chunk: StreamChunk }
  | { type: 'streamEnd' }
  | { type: 'streamError'; error: string };
