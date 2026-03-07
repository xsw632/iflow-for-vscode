# Research Summary — v0.2.0: UX Features & Multi-Tab

## Key Findings

### Stack Additions
- **No new dependencies needed.** All three features use existing VS Code API + Preact stack.
- CWD display: new Preact component + extension message type + `package.json` setting.
- Slash commands: extends existing SlashMenu submenu pattern + new protocol messages.
- Multi-tab: replaces singleton panel with `Map<conversationId, IFlowPanel>` + `WebviewPanelSerializer`.

### Feature Table Stakes

| Feature | Table Stakes | Complexity |
|---------|-------------|------------|
| CWD Display | Folder name + connection dot + model name, setting toggle, hover full path | Low |
| /skill | Dynamic skill list from CLI, submenu picker, keyboard nav | Medium |
| /mcp | MCP server status view (name + connected/disconnected), tool count | Medium |
| Multi-Tab | VS Code editor tabs, per-panel isolation, serializer for persistence, TopBar removal | High |

### Architecture Integration

| Phase | New Files | Modified Files | Risk |
|-------|-----------|----------------|------|
| 5 (CWD) | StatusBar.tsx, statusbar.css | App.tsx, signals.ts, actions.ts, webviewMessages.ts, webviewHandler.ts, package.json | Low |
| 6 (Slash) | — | SlashMenu.tsx, webviewMessages.ts, messageHandler.ts, signals.ts, actions.ts | Medium |
| 7 (Multi-Tab) | panelManager.ts | panel.ts, extension.ts, App.tsx, store.ts, package.json | High |

### Watch Out For

1. **Memory leaks in multi-panel** — each panel owns WebSocket + handlers; must dispose all on close
2. **ConversationStore key collision** — namespace Memento keys by conversationId for multi-panel
3. **TopBar removal breaks sidebar** — keep TopBar conditionally for sidebar views
4. **Serializer registration timing** — must register FIRST in `activate()` for panel restoration
5. **Slash menu async data stale** — cancel pending fetches when user navigates away from submenu

### Build Order

1. Phase 5: CWD Display (v0.1.8) — smallest, validates Composer area
2. Phase 6: Slash Commands (v0.1.9) — independent, extends existing pattern
3. Phase 7: Multi-Tab (v0.2.0) — largest, breaking change (TopBar removal for panels)

Each phase is independently shippable as a version bump.
