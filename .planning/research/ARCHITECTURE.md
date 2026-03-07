# Architecture Research — v0.2.0

## Existing Architecture (Relevant Parts)

```
Extension Host (src/)
├── extension.ts        — registers commands, views
├── panel.ts            — SINGLETON IFlowPanel (static currentPanel)
├── sidebarProvider.ts  — WebviewViewProvider (independent handlers)
├── webviewHandler.ts   — owns ConversationStore + AcpClient + SessionCoordinator
├── store.ts            — ConversationStore (persists to Memento)
├── webview/
│   ├── messageRouter.ts   — routes postMessage to handlers
│   └── messageHandler.ts  — handler implementations
└── protocol/
    └── webviewMessages.ts — typed message envelopes

Webview (media/)
├── main.tsx            — bootstrap, message listener
├── components/
│   ├── App.tsx         — container: TopBar → MessageList → Composer
│   ├── topbar/
│   │   ├── TopBar.tsx           — conversation selector + [+] button
│   │   └── ConversationPanel.tsx — dropdown list grouped by date
│   └── composer/
│       ├── Composer.tsx  — input, "/" detection, send
│       └── SlashMenu.tsx — command menu (9 commands, 4 submenu modes)
└── store/
    ├── signals.ts      — conversationState, currentConversation
    └── actions.ts      — handleExtensionMessage → signal updates
```

## Integration Plan

### Phase 5: CWD Display (v0.1.8)

**New Components:**
- `media/components/composer/StatusBar.tsx` — Preact component showing cwd + model + connection dot
- `media/styles/statusbar.css` — styling

**Modified Files:**
- `media/components/App.tsx` — add `<StatusBar />` between MessageList and Composer
- `media/store/signals.ts` — add `cwdInfo` signal
- `media/store/actions.ts` — handle `cwdUpdated` message
- `src/protocol/webviewMessages.ts` — add `cwdUpdated` ExtensionMessage type
- `src/webviewHandler.ts` — send cwdUpdated when session connects/cwd changes
- `package.json` — add `iflow.showStatusBar` configuration

**Data Flow:**
```
SessionCoordinator.ensureConnected()
  → connectedCwd available
  → webviewHandler sends { type: "cwdUpdated", cwd: "/path", folderName: "proj" }
  → media/store/actions.ts updates cwdInfo signal
  → StatusBar.tsx re-renders
```

### Phase 6: Slash Command Overhaul (v0.1.9)

**Modified Files:**
- `media/components/composer/SlashMenu.tsx` — add `/skill` and `/mcp` commands + submenu modes
- `src/protocol/webviewMessages.ts` — add `listSkills`, `getMcpStatus` WebviewMessage types + `skillsList`, `mcpStatusUpdated` ExtensionMessage types
- `src/webview/messageHandler.ts` — add handlers for listSkills, getMcpStatus
- `media/store/signals.ts` — add `availableSkills`, `mcpStatus` signals
- `media/store/actions.ts` — handle `skillsList`, `mcpStatusUpdated` messages

**Data Flow (/skill):**
```
User types /skill → SlashMenu mode="skills"
  → postMessage({ type: "listSkills" })
  → webviewHandler → AcpClient queries CLI for skills
  → ExtensionMessage({ type: "skillsList", skills: [...] })
  → availableSkills signal updated → SlashMenu re-renders list
  → User selects skill → postMessage({ type: "sendMessage", content: "/skill:name" })
```

**Data Flow (/mcp):**
```
User types /mcp → SlashMenu mode="mcp"
  → postMessage({ type: "getMcpStatus" })
  → webviewHandler → AcpClient queries CLI for MCP status
  → ExtensionMessage({ type: "mcpStatusUpdated", servers: [...] })
  → mcpStatus signal updated → SlashMenu re-renders status view
```

### Phase 7: Multi-Tab Sessions (v0.2.0)

**New Files:**
- `src/panelManager.ts` — replaces singleton `panel.ts`, manages Map<conversationId, IFlowPanel>

**Modified Files:**
- `src/panel.ts` — refactor from singleton to instance-based, or replace with panelManager
- `src/extension.ts` — register WebviewPanelSerializer, update command handlers
- `media/components/App.tsx` — remove TopBar (VS Code tabs replace it)
- `media/components/topbar/` — remove or repurpose (no longer needed for panel mode)
- `src/store.ts` — per-conversation state isolation
- `package.json` — add `onWebviewPanel:iflowPanel` activation event

**Panel Lifecycle:**
```
User clicks [+] or command:openPanel
  → panelManager.createPanel(newConversationId)
  → createWebviewPanel("iflowPanel", title, ViewColumn.Active)
  → new WebviewHandler(panel.webview, conversationId)
  → handler.bindWebview() + initial stateUpdated
  → panel.onDidDispose → cleanup handler, remove from Map

VS Code restart:
  → onWebviewPanel:iflowPanel activates extension
  → WebviewPanelSerializer.deserializeWebviewPanel(panel, state)
  → restore handler from saved conversationId
```

**State Isolation:**
```
PanelManager
  ├── panels: Map<conversationId, { panel, handler }>
  ├── globalStore: settings, workspace folders (shared)
  └── per-panel: each handler has own ConversationStore slice
```

## Suggested Build Order

1. **Phase 5 (CWD)** — smallest scope, validates Composer area changes
2. **Phase 6 (Slash)** — independent of multi-tab, extends existing pattern
3. **Phase 7 (Multi-Tab)** — largest scope, requires TopBar removal + panel refactor

This order minimizes risk: each phase is independently shippable.
