// Message types for communication between extension and webview

export type ConversationMode = 'default' | 'yolo' | 'plan' | 'smart';

export const MODELS = [
  'GLM-4.7',
  'GLM-5',
  'DeepSeek-V3.2',
  'iFlow-ROME-30BA3B(Preview)',
  'Qwen3-Coder-Plus',
  'Kimi-K2-Thinking',
  'MiniMax-M2.5',
  'MiniMax-M2.1',
  'Kimi-K2-0905',
  'Kimi-K2.5'
] as const;

export type ModelType = typeof MODELS[number];

// Context window sizes per model (from iFlow CLI's model configuration)
export const MODEL_CONTEXT_SIZES: Record<ModelType, number> = {
  'GLM-4.7': 200000,
  'GLM-5': 200000,
  'DeepSeek-V3.2': 128000,
  'iFlow-ROME-30BA3B(Preview)': 256000,
  'Qwen3-Coder-Plus': 256000,
  'Kimi-K2-Thinking': 256000,
  'MiniMax-M2.5': 128000,
  'MiniMax-M2.1': 128000,
  'Kimi-K2-0905': 256000,
  'Kimi-K2.5': 262144,
};

// Stream chunk types from CLI output
export type StreamChunk =
  | { chunkType: 'text'; content: string }
  | { chunkType: 'code_start'; language: string; filename?: string }
  | { chunkType: 'code_content'; content: string }
  | { chunkType: 'code_end' }
  | { chunkType: 'tool_start'; name: string; input: Record<string, unknown>; label?: string }
  | { chunkType: 'tool_output'; content: string }
  | { chunkType: 'tool_end'; status: 'completed' | 'error' }
  | { chunkType: 'tool_confirmation'; requestId: number; toolName: string; description: string; confirmationType: string }
  | { chunkType: 'user_question'; requestId: number; questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }> }
  | { chunkType: 'plan_approval'; requestId: number; plan: string }
  | { chunkType: 'thinking_start' }
  | { chunkType: 'thinking_content'; content: string }
  | { chunkType: 'thinking_end' }
  | { chunkType: 'file_ref'; path: string; lineStart?: number; lineEnd?: number }
  | { chunkType: 'plan'; entries: Array<{ content: string; status: string; priority: string }> }
  | { chunkType: 'error'; message: string }
  | { chunkType: 'warning'; message: string };

// Output blocks in messages
export type OutputBlock =
  | { type: 'text'; content: string }
  | { type: 'code'; language: string; filename?: string; content: string }
  | { type: 'tool'; name: string; input: Record<string, unknown>; output: string; status: 'running' | 'completed' | 'error'; label?: string }
  | { type: 'thinking'; content: string; collapsed: boolean }
  | { type: 'file_ref'; path: string; lineStart?: number; lineEnd?: number }
  | { type: 'plan'; entries: Array<{ content: string; status: string; priority: string }> }
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
  sessionId?: string;
}

export interface ConversationState {
  currentConversationId: string | null;
  conversations: Conversation[];
  cliAvailable: boolean;
  cliVersion: string | null;
  cliDiagnostics: string | null;
  isStreaming: boolean;
  contextUsage?: { usedTokens: number; totalTokens: number; percent: number };
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
  | { type: 'toolApproval'; requestId: number; outcome: 'allow' | 'alwaysAllow' | 'reject' }
  | { type: 'questionAnswer'; requestId: number; answers: Record<string, string | string[]> }
  | { type: 'planApproval'; requestId: number; approved: boolean }
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
