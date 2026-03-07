# IFlow for VS Code

## What This Is

A VS Code extension that integrates the iFlow CLI into the editor, providing a chat panel with streaming responses, tool call rendering, file change review, and plan mode orchestration. Communication uses a custom ACP stack (WebSocket + JSON-RPC 2.0) without SDK dependency, and the active webview runtime now renders through Preact components.

## Core Value

Users can interact with iFlow AI directly in VS Code with real-time streaming responses and full tool integration, without leaving the editor.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

- ✓ ACP communication stack (WebSocket + JSON-RPC 2.0 transport, protocol, client) — v0.1.x
- ✓ Chat panel + sidebar with streaming AI responses — v0.1.x
- ✓ Session management and conversation persistence — v0.1.x
- ✓ Tool call rendering (edit preview, command output, todo/plan) — v0.1.x
- ✓ File change review and rewind — v0.1.x
- ✓ Plan mode orchestration — v0.1.x
- ✓ Question/approval interaction panels — v0.1.x
- ✓ Cross-platform CLI discovery — v0.1.x
- ✓ IDE context sync (active file, selection) — v0.1.x
- ✓ Structured error diagnostics across CLI discovery, pipeline validation, startup, and ACP lifecycle errors — v0.1.7
- ✓ Host-side size compliance for `acpRunExecutor.ts`, `sessionCoordinator.ts`, `webviewHandler.ts`, and `processManager.ts` — v0.1.7
- ✓ Coverage gates for `cliDiscovery.ts`, `portDiscovery.ts`, `jsonFileStore.ts`, and 80%+ overall coverage — v0.1.7
- ✓ Preact-based webview runtime with component-driven chat, composer, panels, and message rendering — v0.1.7

### Active

<!-- Current scope. Building toward these. -->

- [ ] CWD 显示 — Composer 内嵌式，类 Cursor 风格，带设置开关 (v0.1.8)
- [ ] Slash Command 重修 — /skill (CLI 技能选择器) + /mcp (MCP 服务器状态视图) (v0.1.9)
- [ ] 多标签页 — 每个会话独立 VS Code 编辑器 Tab，支持 + 新建 (v0.2.0)

### Future

<!-- Planned for subsequent milestones. -->

- [ ] Message virtualization (需基于真实长对话 profiling 验证必要性)
- [ ] Additional UX and performance work

### Out of Scope

<!-- Explicit boundaries. Includes reasoning to prevent re-adding. -->

- Full host-side ACP architecture rewrite — current host stack is now stable enough to avoid churn without a dedicated milestone
- Webview sidebar panel (选择了 Composer 内嵌方式替代)

## Current Milestone: v0.2.0 — UX Features & Multi-Tab

**Goal:** Add CWD context display, rebuilt slash commands (/skill, /mcp), and multi-tab editor sessions to the chat panel.

**Target features:**
- CWD display in Composer area (Cursor-style, with enable/disable setting) → v0.1.8
- Slash command overhaul: /skill picker + /mcp status → v0.1.9
- Multi-tab sessions: each conversation opens as independent VS Code editor tab → v0.2.0

## Context

- **Shipped version:** `v0.1.7` on 2026-03-06
- **Codebase state:** Active webview runtime uses Preact + `@preact/signals`; host communication remains ACP over WebSocket + JSON-RPC 2.0
- **Verification status:** `npm run compile` passed and `npm run test:unit` passed (`337 passing`, `4 pending`) on 2026-03-06
- **Codebase size:** ~32.9k lines across `src/`, `media/`, `test/`, and `scripts/`
- **Known follow-up:** message virtualization deferred — validate with real profiling before adding

## Constraints

- **VS Code API:** ^1.82.0 — extension host environment
- **Node.js:** v22+ required for iFlow CLI
- **Bundle:** Dual webpack bundles (extension + webview), must keep separate
- **Backward compat:** Facade + re-export pattern must be preserved for existing imports

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| No SDK dependency | Full control over ACP protocol, avoid version coupling | ✓ Good |
| Vanilla webview (no framework) | Started simple, but scaling limits were reached | Replaced in v0.1.7 |
| Dual webpack bundle | VS Code requires separate extension host + webview builds | ✓ Good |
| Immutable state management | Pure reducers in store/, prevents hidden side effects | ✓ Good |
| Preact for active webview runtime | Full runtime replacement was safer than incremental DOM patching | ✓ Good |

## Current State

- Milestone `v0.1.7` is archived under `.planning/milestones/`.
- The active webview runtime is component-based and no longer depends on the old imperative rendering pipeline.
- Host diagnostics, file-size compliance, and coverage gates all shipped in that milestone.
- Milestone v0.2.0 is now active, focused on UX features and multi-tab support.

## Next Milestone Goals

- Deliver CWD display (v0.1.8), slash command overhaul (v0.1.9), and multi-tab sessions (v0.2.0)
- Each sub-version is one phase deliverable

---
*Last updated: 2026-03-07 — Milestone v0.2.0 started*
