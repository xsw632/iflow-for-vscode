# Pitfalls Research — v0.2.0

## P1: Multi-Panel Memory Leak (Phase 7 — Multi-Tab)

**Risk:** Each panel creates independent WebviewHandler + AcpClient + SessionCoordinator. Failing to dispose any of these on panel close leaks WebSocket connections, timers, and event listeners.

**Prevention:**
- Implement `dispose()` on WebviewHandler that tears down AcpClient and SessionCoordinator
- Use `panel.onDidDispose()` to trigger cleanup
- Track all disposables in a `Disposable[]` array
- Add a memory usage log in dev mode to detect leaks early

**Phase:** 7 (Multi-Tab)

## P2: Singleton Panel Pattern Breakage (Phase 7 — Multi-Tab)

**Risk:** Current `IFlowPanel.currentPanel` static field enforces one panel. Existing code (commands, sidebar) may reference this static. Removing it without updating all consumers causes null reference errors.

**Prevention:**
- Search all references to `IFlowPanel.currentPanel` before refactoring
- Replace with `PanelManager.getActivePanel()` or `PanelManager.getAllPanels()`
- Keep backward compatibility for sidebar views (they don't use panel.ts)

**Phase:** 7 (Multi-Tab)

## P3: ConversationStore State Collision (Phase 7 — Multi-Tab)

**Risk:** Current `ConversationStore` uses shared `globalState.Memento` key space. Multiple panels writing to the same keys will overwrite each other's state.

**Prevention:**
- Namespace Memento keys by conversationId: `conversation:${id}:messages`
- Or use per-panel in-memory store with periodic persistence
- Test with 3+ concurrent panels to verify isolation

**Phase:** 7 (Multi-Tab)

## P4: TopBar Removal Breaking Sidebar (Phase 7 — Multi-Tab)

**Risk:** TopBar and ConversationPanel are used by both panel and sidebar views. Removing TopBar for multi-tab panels may break sidebar conversation switching.

**Prevention:**
- Keep TopBar for sidebar views (sidebar still needs conversation selector)
- Conditionally render TopBar based on webview context (panel vs sidebar)
- Pass a `viewMode: "panel" | "sidebar"` prop to App component

**Phase:** 7 (Multi-Tab)

## P5: Slash Command Submenu State Leak (Phase 6 — Slash Commands)

**Risk:** Slash menu already has 4 modes (commands/models/modes/workspaces). Adding 2 more (skills/mcp) increases state complexity. Async data fetching (skill list, MCP status) may render stale data if user navigates away quickly.

**Prevention:**
- Clear async results when mode changes (cancel pending requests)
- Show loading indicator while fetching
- Use `AbortController` pattern for fetch cancellation

**Phase:** 6 (Slash Commands)

## P6: CWD Update Race Condition (Phase 5 — CWD Display)

**Risk:** Session reconnection can change cwd. If the webview receives a `cwdUpdated` message while processing a previous state update, the display may flicker or show stale data.

**Prevention:**
- Use a single `cwdInfo` signal (atomic update)
- Don't debounce cwd updates (they're infrequent)
- Clear cwd display when disconnected

**Phase:** 5 (CWD Display)

## P7: WebviewPanelSerializer Registration Timing (Phase 7 — Multi-Tab)

**Risk:** If `registerWebviewPanelSerializer()` is called too late in `activate()`, VS Code may fail to restore panels after restart, losing conversation state.

**Prevention:**
- Register serializer FIRST in `activate()`, before any other async work
- Add `onWebviewPanel:iflowPanel` to `activationEvents` in package.json
- Test by opening 2+ panels, closing VS Code, reopening

**Phase:** 7 (Multi-Tab)

## P8: Setting Toggle Not Propagating (Phase 5 — CWD Display)

**Risk:** `iflow.showStatusBar` setting change might not reach the webview if the config change listener is missing or doesn't re-send the state.

**Prevention:**
- Listen to `vscode.workspace.onDidChangeConfiguration` for `iflow.showStatusBar`
- Send updated setting value to webview via `settingsUpdated` message
- Test toggling setting while extension is running

**Phase:** 5 (CWD Display)
