---
phase: quick-streaming-perf
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - media/markdownRenderer.ts
  - media/streamingViewUpdater.ts
  - src/test/markdownRenderer.test.ts
autonomous: true
requirements: [PERF-01]

must_haves:
  truths:
    - "Streaming text updates only re-render the last changed block, not all blocks"
    - "escapeHtml does not create DOM elements — uses a static lookup table"
    - "UI does not freeze during high-frequency streaming chunks"
  artifacts:
    - path: "media/markdownRenderer.ts"
      provides: "Pure-string escapeHtml without DOM element creation"
      contains: "escapeHtml"
    - path: "media/streamingViewUpdater.ts"
      provides: "Block-level incremental DOM update for streaming"
      contains: "updateStreamingContentView"
  key_links:
    - from: "media/streamingViewUpdater.ts"
      to: "media/renderers/messageRenderer.ts"
      via: "renderBlock import"
      pattern: "renderBlock"
---

<objective>
Fix the streaming UI freeze by eliminating three performance bottlenecks:
1. `escapeHtml` creating a DOM element on every call (hundreds/sec during streaming)
2. Full innerHTML replacement of ALL blocks on every streaming chunk
3. Re-rendering unchanged blocks (only the last block is actively streaming)

Purpose: The webview freezes during streaming because each chunk triggers O(all_blocks) re-rendering with expensive DOM-based HTML escaping. This makes the extension unusable for long responses.

Output: Patched `markdownRenderer.ts` and `streamingViewUpdater.ts` with incremental rendering.
</objective>

<execution_context>
@/home/mingzhenjia/.claude/get-shit-done/workflows/execute-plan.md
@/home/mingzhenjia/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@media/markdownRenderer.ts
@media/streamingViewUpdater.ts
@media/renderers/messageRenderer.ts
@media/main.ts
@src/shared/visualUpdateScheduler.ts
@src/store/chunkReducer.ts

<interfaces>
<!-- Key types and contracts the executor needs -->

From media/markdownRenderer.ts:
```typescript
export function escapeHtml(text: string): string;
export function renderMarkdown(text: string): string;
```

From media/streamingViewUpdater.ts:
```typescript
export function updateStreamingContentView(options: {
  conversation: Conversation | null;
  fallbackRender: () => void;
  updatePendingIndicator: (container?: Element) => void;
  updateComposerStatusBar: () => void;
  scrollToBottom: () => void;
}): void;
```

From media/renderers/messageRenderer.ts:
```typescript
export function renderBlock(block: OutputBlock): string;
export function renderPendingIndicator(faviconUri: string, statusText?: string): string;
```

From src/protocol/stream.ts (OutputBlock types):
```typescript
type OutputBlock =
  | { type: "text"; content: string }
  | { type: "code"; language: string; filename?: string; content: string }
  | { type: "tool"; name: string; input: any; output: string; status: string; label?: string; toolCallId?: string }
  | { type: "thinking"; content: string; collapsed: boolean }
  | { type: "file_ref"; path: string; lineStart?: number; lineEnd?: number }
  | { type: "error"; message: string }
  | { type: "warning"; message: string }
  | { type: "plan"; entries: Array<{ content: string; status: string; priority: string }> };
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Replace DOM-based escapeHtml with pure string lookup</name>
  <files>media/markdownRenderer.ts, src/test/markdownRenderer.test.ts</files>
  <behavior>
    - Test 1: escapeHtml("&") returns "&amp;"
    - Test 2: escapeHtml("<script>") returns "&lt;script&gt;"
    - Test 3: escapeHtml('"hello"') returns "&quot;hello&quot;"
    - Test 4: escapeHtml("'test'") returns "&#39;test&#39;"
    - Test 5: escapeHtml("normal text") returns "normal text" unchanged
    - Test 6: escapeHtml("<div class=\"foo\">&bar</div>") escapes all special chars
    - Test 7: escapeHtml("") returns "" for empty string
    - Test 8: renderMarkdown preserves existing behavior (regression check on a sample with bold, code, list, heading)
  </behavior>
  <action>
    Replace the DOM-based `escapeHtml` implementation that creates `document.createElement('div')` on every call with a pure string replacement using a static regex + lookup map:

    ```typescript
    const HTML_ESCAPE_MAP: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    const HTML_ESCAPE_RE = /[&<>"']/g;

    export function escapeHtml(text: string): string {
      return text.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch]);
    }
    ```

    This eliminates DOM element creation during streaming. The regex + map approach is the standard high-performance pattern (used by React, lodash, etc.).

    IMPORTANT: Do NOT change the `renderMarkdown` function or `renderInline` function signatures or behavior. Only replace the `escapeHtml` implementation.

    For the test file: Create `src/test/markdownRenderer.test.ts` if it does not exist. The test needs to work in a Node.js environment (no DOM), which is exactly WHY we are removing the DOM dependency from escapeHtml. Use the project's existing test pattern (look at other test files like `src/test/chunkReducer.test.ts` for import style).

    Note: Since `escapeHtml` is exported from `media/markdownRenderer.ts` (a webview file), the test may need to import it directly. Check if existing tests import from `media/` or if a re-export is needed. If the webpack/test setup does not support importing from `media/`, create a shared utility at `src/shared/escapeHtml.ts` and have `media/markdownRenderer.ts` import from there. Check the tsconfig and test setup first.
  </action>
  <verify>
    <automated>npm run test:unit -- --grep "escapeHtml"</automated>
  </verify>
  <done>escapeHtml uses pure string replacement with no DOM dependency. All existing renderMarkdown behavior preserved. Tests pass.</done>
</task>

<task type="auto">
  <name>Task 2: Add incremental block-level DOM update to streaming view</name>
  <files>media/streamingViewUpdater.ts</files>
  <action>
    Refactor `updateStreamingContentView` to only re-render the LAST block instead of re-rendering ALL blocks via innerHTML replacement.

    Current bottleneck (line 44):
    ```typescript
    contentEl.innerHTML = lastMessage.blocks.map((block) => renderBlock(block)).join("");
    ```
    This re-renders EVERY block (text, code, tool, thinking) on every streaming chunk, even though only the last block is changing during streaming.

    New approach — track rendered block count and only update the last block:

    1. Add a module-level variable `let lastRenderedBlockCount = 0;` to track how many blocks have been rendered in the current streaming message.

    2. In `updateStreamingContentView`, compare `lastMessage.blocks.length` with `lastRenderedBlockCount`:
       - If blocks were ADDED (new block appeared, e.g., text -> code transition): append only the new blocks as HTML to the container using `insertAdjacentHTML('beforeend', ...)`, then update the last block's content.
       - If block count is the SAME (content appended to existing last block): find the last child element in `contentEl` and update only ITS innerHTML with `renderBlock(lastMessage.blocks[lastMessage.blocks.length - 1])`.
       - If blocks DECREASED or message changed (edge case): fall back to full re-render.

    3. Reset `lastRenderedBlockCount = 0` when:
       - `fallbackRender` is called (full render resets everything)
       - The message element doesn't exist (new message started)
       - The assistant message changed (different message ID — compare via a stored `lastMessageId`)

    4. Add a module-level `let lastMessageId = "";` to detect when the streaming message changes.

    Implementation sketch:
    ```typescript
    let lastRenderedBlockCount = 0;
    let lastStreamingMessageId = "";

    export function resetStreamingState(): void {
      lastRenderedBlockCount = 0;
      lastStreamingMessageId = "";
    }

    export function updateStreamingContentView(options: { ... }): void {
      // ... existing null checks ...

      const lastMessage = conversation.messages[conversation.messages.length - 1];
      // ... existing checks ...

      // Detect message change
      if (lastMessage.id !== lastStreamingMessageId) {
        lastStreamingMessageId = lastMessage.id;
        lastRenderedBlockCount = 0;
      }

      const contentEl = lastMessageEl.querySelector(".message-content");
      if (!contentEl) {
        options.fallbackRender();
        return;
      }

      const totalBlocks = lastMessage.blocks.length;

      if (lastRenderedBlockCount === 0 || totalBlocks < lastRenderedBlockCount) {
        // Full re-render of content (first render or block removal)
        contentEl.innerHTML = lastMessage.blocks.map(b => renderBlock(b)).join("");
        lastRenderedBlockCount = totalBlocks;
      } else if (totalBlocks > lastRenderedBlockCount) {
        // New blocks added — update last rendered block + append new ones
        const lastRenderedChild = contentEl.children[lastRenderedBlockCount - 1];
        if (lastRenderedChild && lastRenderedBlockCount > 0) {
          lastRenderedChild.outerHTML = renderBlock(lastMessage.blocks[lastRenderedBlockCount - 1]);
        }
        const newBlocksHtml = lastMessage.blocks
          .slice(lastRenderedBlockCount)
          .map(b => renderBlock(b))
          .join("");
        contentEl.insertAdjacentHTML("beforeend", newBlocksHtml);
        lastRenderedBlockCount = totalBlocks;
      } else {
        // Same block count — only update the last block
        const lastChild = contentEl.lastElementChild;
        if (lastChild) {
          lastChild.outerHTML = renderBlock(lastMessage.blocks[totalBlocks - 1]);
        }
      }

      options.updatePendingIndicator(container);
      options.updateComposerStatusBar();
      options.scrollToBottom();
    }
    ```

    IMPORTANT: Also call `resetStreamingState()` in `media/main.ts` inside the `render()` method (which does full re-renders). The `render()` method already calls `this.visualUpdateScheduler.cancelAll()` — add `resetStreamingState()` import and call right after it. This ensures the incremental state is properly reset when a full render occurs.

    Update `media/main.ts` to:
    - Import `resetStreamingState` from `./streamingViewUpdater`
    - Call `resetStreamingState()` at the start of the `render()` method (line ~254, right after `this.visualUpdateScheduler.cancelAll()`)
  </action>
  <verify>
    <automated>npm run compile</automated>
  </verify>
  <done>Streaming updates only re-render the last changed block. New blocks are appended incrementally. Full re-render is reserved for message changes and edge cases. The compile succeeds with no errors.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <what-built>
    Two streaming performance optimizations:
    1. Pure-string escapeHtml (eliminates DOM element creation during streaming)
    2. Incremental block-level rendering (only re-renders the last active block instead of all blocks)

    Together these should eliminate the UI freeze during streaming responses.
  </what-built>
  <how-to-verify>
    1. Run `npm run compile` — should succeed
    2. Run `npm run test:unit` — all tests should pass
    3. Open VS Code with the extension loaded (F5 to launch Extension Development Host)
    4. Start a conversation that produces a long response (e.g., "Write a detailed tutorial about TypeScript generics with code examples")
    5. During streaming, verify:
       - The UI remains responsive (can scroll, click, type in input)
       - Text appears smoothly without freezing or stuttering
       - Code blocks render correctly with syntax highlighting
       - Tool call blocks (if any) render with correct status icons
       - Thinking blocks collapse/expand correctly
    6. After streaming completes, verify the full message renders correctly
    7. Compare behavior with the previous version — the freeze should be gone
  </how-to-verify>
  <resume-signal>Type "approved" if streaming is smooth, or describe any remaining issues</resume-signal>
</task>

</tasks>

<verification>
- `npm run compile` succeeds
- `npm run test:unit` passes (including new escapeHtml tests)
- No DOM element creation in escapeHtml (grep for createElement in markdownRenderer.ts returns 0 results)
- Streaming updates only touch the last block (verified via code review of streamingViewUpdater.ts)
</verification>

<success_criteria>
- Streaming UI does not freeze during long responses
- escapeHtml is a pure function with no DOM dependency
- Only the last active block is re-rendered during streaming (not all blocks)
- All existing tests pass, new escapeHtml tests pass
- Compile succeeds without errors
</success_criteria>

<output>
After completion, create `.planning/quick/1-streaming-performance-fix-please-help-me/1-SUMMARY.md`
</output>
