import type {
  AttachedFile,
  ConversationMode,
  ConversationState,
  IDEContext,
  ModelType,
} from './conversation';
import type { RoundFileChangeSummary } from './fileChange';
import type { StreamChunk, StreamStatusPhase } from './stream';

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
  | { type: 'setWorkspaceFolder'; uri: string }
  | { type: 'sendMessage'; content: string; attachedFiles: AttachedFile[]; ideContext?: IDEContext }
  | { type: 'toolApproval'; requestId: number; outcome: 'allow' | 'alwaysAllow' | 'reject' }
  | { type: 'questionAnswer'; requestId: number; answers: Record<string, string | string[]> }
  | { type: 'planApproval'; requestId: number; option: 'smart' | 'default' | 'keep' | 'feedback'; feedback?: string }
  | { type: 'fileChangeAction'; action: 'openDiff' | 'approve' | 'rollback'; conversationId: string; assistantMessageId: string; path: string }
  | { type: 'cancelCurrent' }
  | { type: 'recheckCli' }
  | { type: 'ready' };

// Messages from extension to webview
export type ExtensionMessage =
  | { type: 'pickedFiles'; files: { path: string; name: string }[] }
  | { type: 'workspaceFiles'; files: { path: string; name: string }[] }
  | { type: 'fileContents'; files: AttachedFile[] }
  | { type: 'stateUpdated'; state: ConversationState }
  | { type: 'roundFileChanges'; summary: RoundFileChangeSummary }
  | { type: 'streamStatus'; phase: StreamStatusPhase; elapsedMs: number }
  | { type: 'streamChunk'; chunk: StreamChunk }
  | { type: 'streamEnd' }
  | { type: 'streamError'; error: string }
  | { type: 'ideContextChanged'; context: IDEContext }
  | { type: 'settingsUpdated'; settings: { showCwdBar: boolean } };
