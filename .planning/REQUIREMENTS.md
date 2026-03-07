# Requirements — Milestone v0.2.0: UX Features & Multi-Tab

## v1 Requirements

### CWD Display (v0.1.8)

- [ ] **CWD-01**: User can see the current working directory folder name with a folder icon displayed above the Composer input area
- [ ] **CWD-02**: User can hover the CWD display to see the full absolute path as a tooltip
- [ ] **CWD-03**: User can enable or disable the CWD status bar via the `iflow.showStatusBar` setting in VS Code settings
- [ ] **CWD-04**: CWD display updates automatically when the session reconnects to a different working directory

### Slash Commands (v0.1.9)

- [ ] **SLASH-01**: User can type `/skill` to open a submenu listing available CLI skills fetched dynamically from the running session
- [ ] **SLASH-02**: User can select a skill from the `/skill` submenu to send it as a command to the CLI
- [ ] **SLASH-03**: User can type `/mcp` to open a status view showing MCP server names, connection status, and tool count per server
- [ ] **SLASH-04**: User sees a loading indicator while skill list or MCP status data is being fetched
- [ ] **SLASH-05**: User can navigate `/skill` and `/mcp` submenus with arrow keys and confirm with Enter

### Multi-Tab Sessions (v0.2.0)

- [ ] **TAB-01**: User can click the iFlow icon in VS Code's editor title bar to open a new independent iFlow editor tab (panel)
- [ ] **TAB-02**: User can have multiple iFlow editor tabs open simultaneously, each with independent state (own conversations, AcpClient, session)
- [ ] **TAB-03**: Closing an iFlow editor tab properly releases all resources (WebSocket connections, handlers, timers)
- [ ] **TAB-04**: Open iFlow editor tabs are restored when VS Code restarts (WebviewPanelSerializer)
- [ ] **TAB-05**: The [+] button inside each tab's TopBar continues to create new conversations within that tab (existing behavior preserved)

## Future Requirements

- [ ] Message virtualization for long conversations (deferred — needs real profiling)
- [ ] CWD status bar: connection status dot indicator
- [ ] CWD status bar: current model name display
- [ ] Sidebar view TopBar compatibility (conditional rendering for panel vs sidebar)

## Out of Scope

| Item | Reasoning |
|------|-----------|
| MCP server connect/disconnect management | Too complex for status-only v1 |
| Custom skill registration from webview | Skills come from CLI, not user-defined |
| Cross-tab conversation sync | Each tab is intentionally independent |
| In-webview tab bar replacing TopBar | TopBar stays; multi-tab is VS Code native editor tabs |
| Full host-side ACP rewrite | Stable enough without dedicated milestone |

## Traceability

| REQ-ID | Phase | Plan |
|--------|-------|------|
| CWD-01 | 5 | — |
| CWD-02 | 5 | — |
| CWD-03 | 5 | — |
| CWD-04 | 5 | — |
| SLASH-01 | 6 | — |
| SLASH-02 | 6 | — |
| SLASH-03 | 6 | — |
| SLASH-04 | 6 | — |
| SLASH-05 | 6 | — |
| TAB-01 | 7 | — |
| TAB-02 | 7 | — |
| TAB-03 | 7 | — |
| TAB-04 | 7 | — |
| TAB-05 | 7 | — |
