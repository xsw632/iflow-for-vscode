# Features Research — v0.2.0

## CWD Display

### Table Stakes
- Show current working directory name (folder basename) with folder icon
- Show connection status indicator (connected/disconnected dot)
- Hover/tooltip shows full path
- Real-time update when cwd changes (session reconnect to different folder)
- Setting toggle to show/hide (`iflow.showStatusBar`)

### Differentiators
- Show current model name alongside cwd
- Clickable cwd to open folder in file explorer

### Anti-Features
- Token usage / cost display (not available from CLI currently)
- Full sidebar panel (user chose Composer-embedded)

### Complexity: Low
- Pure UI component + one new extension message type
- No backend changes, only surfaces existing session data

## Slash Commands (/skill + /mcp)

### Table Stakes — /skill
- `/skill` opens a submenu listing available CLI skills
- Skills fetched dynamically from running CLI session
- Selecting a skill sends it as a message to the CLI (like `/compact`)
- Keyboard navigation (arrow keys + enter)
- Filter skills by typing after `/skill `

### Table Stakes — /mcp
- `/mcp` opens a status view showing MCP server connections
- Show server name + connected/disconnected status
- Show tool count per server
- Read-only status view (no management)

### Differentiators
- `/skill` shows skill descriptions alongside names
- `/mcp` shows last error for disconnected servers

### Anti-Features
- MCP server connect/disconnect management (too complex for v1)
- Custom skill registration from webview

### Complexity: Medium
- Follows existing submenu pattern (`/model`, `/mode`)
- Needs new protocol messages for fetching skill list and MCP status
- Needs host-side integration with ACP client to query CLI

## Multi-Tab Sessions

### Table Stakes
- "+" button creates new VS Code editor tab with fresh conversation
- Each tab is independent (own messages, own session)
- Close tab disposes resources properly
- Tab title shows conversation name
- Panel persists across VS Code restart (serializer)

### Differentiators
- Tab icon matches iFlow branding
- Drag-and-drop tab reordering (VS Code native)
- Split view support (VS Code native)

### Anti-Features
- Shared CLI session across tabs (each should be independent)
- Cross-tab conversation sync
- In-webview tab bar (VS Code native tabs are better)

### Complexity: High
- Replace singleton panel pattern with panel registry (Map)
- Per-panel state isolation
- WebviewPanelSerializer for persistence
- Resource cleanup on dispose
- TopBar conversation dropdown removal (replaced by VS Code tabs)

### Dependencies
- CWD display should ship first (simpler, validates Composer area changes)
- Slash commands are independent of multi-tab
- Multi-tab requires TopBar removal which is a breaking UI change
