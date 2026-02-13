// Pure mapping logic: converts SDK messages into StreamChunks for the webview.

import { StreamChunk, AttachedFile } from './protocol';
import { ThinkingParser } from './thinkingParser';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SDKModule = any;

export interface RunOptionsLike {
  prompt: string;
  attachedFiles: AttachedFile[];
  workspaceFiles?: string[];
}

export class ChunkMapper {
  private parser: ThinkingParser | null = null;
  private inNativeThinking = false;

  constructor(
    private getSDK: () => Promise<SDKModule>,
    private log: (message: string) => void
  ) {}

  /** Reset state at the start of each run. */
  reset(): void {
    this.inNativeThinking = false;
    this.parser = new ThinkingParser();
  }

  /** Build the final prompt string with workspace and attached file context. */
  buildPrompt(options: RunOptionsLike): string {
    let prompt = '';

    if (options.workspaceFiles && options.workspaceFiles.length > 0) {
      prompt += '=== Workspace Files ===\n';
      prompt += options.workspaceFiles.join('\n');
      prompt += '\n=== End Workspace Files ===\n\n';
    }

    if (options.attachedFiles.length > 0) {
      prompt += '=== Attached Files ===\n';
      for (const file of options.attachedFiles) {
        prompt += `--- ${file.path} ---\n`;
        prompt += file.content || '';
        if (file.truncated) {
          prompt += '\n[... truncated ...]\n';
        }
        prompt += '\n';
      }
      prompt += '=== End Attached Files ===\n\n';
    }

    prompt += options.prompt;
    return prompt;
  }

  /**
   * Enrich tool input by merging data from message.content and message.locations
   * into the args object, so the webview can access file paths and content.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  enrichToolInput(message: any): Record<string, unknown> {
    const input: Record<string, unknown> = { ...(message.args || {}) };

    // Merge ToolCallContent fields (path, newText, oldText, markdown)
    if (message.content) {
      if (message.content.path && !input.file_path) {
        input.file_path = message.content.path;
      }
      if (message.content.newText != null && !input.content) {
        input.content = message.content.newText;
      }
      if (message.content.oldText != null && !input.old_string) {
        input.old_string = message.content.oldText;
      }
      if (message.content.markdown != null) {
        input._markdown = message.content.markdown;
      }
      if (message.content.type) {
        input._contentType = message.content.type;
      }
    }

    // Merge first location as file_path
    if (message.locations && message.locations.length > 0) {
      const loc = message.locations[0];
      if (loc.path && !input.file_path) {
        input.file_path = loc.path;
      }
    }

    return input;
  }

  /** Map a single SDK message into one or more StreamChunks. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async mapMessageToChunks(message: any): Promise<StreamChunk[]> {
    const sdk = await this.getSDK();
    const chunks: StreamChunk[] = [];

    switch (message.type) {
      case sdk.MessageType.ASSISTANT:
        // Handle native thought chunks from SDK
        if (message.chunk?.thought) {
          if (!this.inNativeThinking) {
            chunks.push({ chunkType: 'thinking_start' });
            this.inNativeThinking = true;
          }
          chunks.push({ chunkType: 'thinking_content', content: message.chunk.thought });
        }
        // Handle text chunks
        if (message.chunk?.text) {
          // End native thinking block if we were in one
          if (this.inNativeThinking) {
            chunks.push({ chunkType: 'thinking_end' });
            this.inNativeThinking = false;
          }
          if (this.parser) {
            const parserChunks = this.parser.parse(message.chunk.text);
            chunks.push(...parserChunks);
          } else {
            chunks.push({ chunkType: 'text', content: message.chunk.text });
          }
        }
        break;

      case sdk.MessageType.TOOL_CALL: {
        this.log(`TOOL_CALL: status=${message.status}, toolName=${message.toolName}, label=${message.label}, args=${JSON.stringify(message.args)}`);

        // Check if this is a permission confirmation request (injected by patchPermission)
        if (message.confirmation && message._requestId !== undefined) {
          // Emit tool_start so the tool appears as a running entry in the messages
          chunks.push({
            chunkType: 'tool_start',
            name: message.toolName || message.label || 'unknown',
            input: {},
            label: message.label || undefined
          });
          // Emit tool_confirmation so the webview can show the approval UI in the composer
          chunks.push({
            chunkType: 'tool_confirmation',
            requestId: message._requestId,
            toolName: message.toolName || message.label || 'unknown',
            description: message.confirmation.description || '',
            confirmationType: message.confirmation.type || 'other',
          });
          break;
        }

        // Check if this is a user question request (injected by patchQuestions)
        if (message._questionRequest && message._requestId !== undefined) {
          chunks.push({
            chunkType: 'user_question',
            requestId: message._requestId,
            questions: message._questions,
          });
          break;
        }

        // Check if this is a plan approval request (injected by patchQuestions)
        if (message._planApproval && message._requestId !== undefined) {
          chunks.push({
            chunkType: 'plan_approval',
            requestId: message._requestId,
            plan: message._plan,
          });
          break;
        }

        const enrichedInput = this.enrichToolInput(message);
        const toolName = message.toolName || message.label || 'unknown';

        if (message.status === 'pending' || message.status === 'in_progress') {
          chunks.push({
            chunkType: 'tool_start',
            name: toolName,
            input: enrichedInput,
            label: message.label || undefined
          });
        } else if (message.status === 'completed') {
          // Send an input update before completion (block is still 'running')
          // so the preview renderer has access to content/locations data
          if (Object.keys(enrichedInput).length > 0) {
            chunks.push({
              chunkType: 'tool_start',
              name: toolName,
              input: enrichedInput,
              label: message.label || undefined
            });
          }
          if (message.output) {
            chunks.push({
              chunkType: 'tool_output',
              content: message.output
            });
          }
          chunks.push({
            chunkType: 'tool_end',
            status: 'completed'
          });
        } else if (message.status === 'failed') {
          if (message.output) {
            chunks.push({
              chunkType: 'tool_output',
              content: message.output
            });
          }
          chunks.push({
            chunkType: 'tool_end',
            status: 'error'
          });
        }
        break;
      }

      case sdk.MessageType.PLAN:
        if (message.entries && Array.isArray(message.entries)) {
          chunks.push({
            chunkType: 'plan',
            entries: message.entries.map((entry: { content?: string; status?: string; priority?: string }) => ({
              content: entry.content || '',
              status: entry.status || 'pending',
              priority: entry.priority || 'medium',
            })),
          });
        }
        break;

      case sdk.MessageType.ERROR:
        chunks.push({
          chunkType: 'error',
          message: message.message || 'Unknown error'
        });
        break;

      case sdk.MessageType.TASK_FINISH:
        // Close any open native thinking block
        if (this.inNativeThinking) {
          chunks.push({ chunkType: 'thinking_end' });
          this.inNativeThinking = false;
        }
        // Task finish is handled in the run loop
        break;

      default:
        this.log(`Unknown message type: ${message.type}`);
    }

    return chunks;
  }
}
