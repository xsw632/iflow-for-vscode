# Roadmap: IFlow for VS Code

## Completed Milestones

- [x] `v0.1.7` Stability & Preact Migration (2026-03-02 -> 2026-03-06, 4 phases, 20 plans, 337 passing tests) — see `.planning/milestones/v0.1.7-ROADMAP.md`

## Current Milestone: v0.2.0 — UX Features & Multi-Tab

**Status:** IN PROGRESS
**Phases:** 5-7 (continuing from v0.1.7 phase 4)
**Total Requirements:** 14

### Overview

This milestone adds three independently shippable features: a CWD context display embedded in the Composer area, rebuilt slash commands with /skill and /mcp support, and multi-tab editor sessions where each panel is an independent VS Code editor tab. Each phase maps to a sub-version release.

### Phase 5: CWD Display

**Goal:** Show the current working directory above the Composer input with a setting toggle, so users always know which project folder the CLI is operating in.
**Version:** v0.1.8
**Depends on:** None
**Requirements:** CWD-01, CWD-02, CWD-03, CWD-04

**Success Criteria:**
1. User sees folder icon + folder name above the Composer input area when connected to a CLI session
2. Hovering the folder name shows the full absolute path as a tooltip
3. Setting `iflow.showStatusBar` to `false` hides the CWD display; setting it to `true` shows it
4. When the session reconnects to a different cwd, the displayed folder name updates automatically

**Implementation Notes:**
- New Preact component: `StatusBar.tsx` in `media/components/composer/`
- New CSS: `statusbar.css`
- Host sends cwd info via existing `stateUpdated` or new `cwdUpdated` message
- Register `iflow.showStatusBar` in `package.json` contributes.configuration
- Propagate setting changes to webview via `settingsUpdated` message

### Phase 6: Slash Commands

**Goal:** Add /skill and /mcp submenu modes to the existing slash command system, with dynamic data loading and keyboard navigation.
**Version:** v0.1.9
**Depends on:** None (can parallel with Phase 5)
**Requirements:** SLASH-01, SLASH-02, SLASH-03, SLASH-04, SLASH-05

**Success Criteria:**
1. Typing `/skill` in the Composer opens a submenu listing available skills fetched from the running CLI session
2. Selecting a skill from the list sends it as a command and closes the menu
3. Typing `/mcp` opens a status view showing MCP server names with connection status and tool count
4. A loading spinner appears while skill/MCP data is being fetched from the CLI
5. User can navigate submenu items with arrow keys and select with Enter

**Implementation Notes:**
- Extend existing SlashMenu component with new `skills` and `mcp` submenu modes
- Add protocol messages: `getSkills` request / `skillList` response, `getMcpStatus` request / `mcpStatus` response
- Host-side: forward requests to CLI session via ACP, return results
- Cancel pending requests when user changes submenu mode (AbortController pattern)
- Reuse existing keyboard navigation infrastructure from current slash menu

### Phase 7: Multi-Tab Sessions

**Goal:** Allow users to open multiple independent iFlow panels as VS Code editor tabs, with proper resource lifecycle and persistence across restarts.
**Version:** v0.2.0
**Depends on:** None (can parallel with Phase 5 and 6, but recommended after them)
**Requirements:** TAB-01, TAB-02, TAB-03, TAB-04, TAB-05

**Success Criteria:**
1. Clicking the iFlow icon in VS Code editor title bar opens a new independent iFlow editor tab
2. Two or more iFlow tabs can be open simultaneously, each with their own conversation state, AcpClient, and session
3. Closing an iFlow tab disposes its WebSocket connection, WebviewHandler, and all associated resources without affecting other tabs
4. After closing and reopening VS Code, previously open iFlow tabs are restored with their conversation state
5. The [+] button inside each tab's TopBar creates a new conversation within that tab (existing behavior unchanged)

**Implementation Notes:**
- Replace singleton `IFlowPanel.currentPanel` with `PanelManager` using `Map<panelId, IFlowPanel>`
- Each panel gets its own `WebviewHandler` + `AcpClient` + `SessionCoordinator` (existing pattern, already independent)
- Register `WebviewPanelSerializer` in `activate()` (first, before other async work)
- Add `onWebviewPanel:iflowPanel` to `activationEvents` in `package.json`
- Change `openPanel` command to always create a new panel (not reuse existing)
- Namespace Memento persistence keys by panelId to prevent state collision
- Implement `panel.onDidDispose()` cleanup for all resources
- TopBar and ConversationPanel remain unchanged in all views

## Requirement Coverage

| REQ-ID | Phase | Covered |
|--------|-------|---------|
| CWD-01 | 5 | yes |
| CWD-02 | 5 | yes |
| CWD-03 | 5 | yes |
| CWD-04 | 5 | yes |
| SLASH-01 | 6 | yes |
| SLASH-02 | 6 | yes |
| SLASH-03 | 6 | yes |
| SLASH-04 | 6 | yes |
| SLASH-05 | 6 | yes |
| TAB-01 | 7 | yes |
| TAB-02 | 7 | yes |
| TAB-03 | 7 | yes |
| TAB-04 | 7 | yes |
| TAB-05 | 7 | yes |

**Coverage: 14/14 (100%)**

---
*Last updated: 2026-03-07 — Milestone v0.2.0 roadmap created*
