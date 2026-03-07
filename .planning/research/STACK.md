# Stack Research — v0.2.0

## Existing Stack (No Changes Needed)

| Layer | Tech | Status |
|-------|------|--------|
| Extension Host | TypeScript + VS Code API ^1.82.0 | Stable |
| Webview | Preact + @preact/signals | Stable |
| Build | Dual webpack (extension + webview) | Stable |
| Protocol | WebSocket + JSON-RPC 2.0 (ACP) | Stable |
| State | ConversationStore → vscode.Memento | Needs adaptation for multi-panel |

## New Capabilities Required

### CWD Display (v0.1.8)
- **No new dependencies.** Uses existing `vscode.workspace.workspaceFolders` and session coordinator's `connectedCwd`.
- Webview: new Preact component `<StatusBar />` above Composer.
- Host: new `cwdUpdated` extension message + `iflow.showStatusBar` setting in `package.json contributes.configuration`.

### Slash Command Overhaul (v0.1.9)
- **No new dependencies.** Extends existing `SlashMenu.tsx` submenu pattern (already supports drill-down for `/model`, `/mode`, `/workspace`).
- `/skill`: needs CLI skill list query → new protocol messages `listSkills` / `skillsList`.
- `/mcp`: needs MCP server status query → new protocol messages `getMcpStatus` / `mcpStatusUpdated`.

### Multi-Tab Sessions (v0.2.0)
- **No new dependencies.** Uses existing `vscode.window.createWebviewPanel()` API.
- Requires `WebviewPanelSerializer` registration for panel persistence across restarts.
- `package.json` needs `"onWebviewPanel:iflowPanel"` activation event.
- State management: per-panel `WebviewHandler` instances (already the pattern for sidebar views).

## What NOT to Add

- No React (Preact is sufficient and already integrated)
- No external state management library (signals + store pattern works)
- No IPC library for cross-panel communication (simple event emitter suffices)
- No IndexedDB (Memento persistence is adequate for conversation state)
