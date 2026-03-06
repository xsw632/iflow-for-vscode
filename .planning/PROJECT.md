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

- [ ] Define the next milestone with fresh requirements and roadmap artifacts
- [ ] Decide whether message virtualization is needed based on real long-conversation profiling
- [ ] Reassess any remaining webview performance follow-up work now that the active runtime is Preact-based

### Future

<!-- Planned for subsequent milestones. -->

- [ ] Additional UX and performance work once the next milestone scope is defined

### Out of Scope

<!-- Explicit boundaries. Includes reasoning to prevent re-adding. -->

- Full host-side ACP architecture rewrite — current host stack is now stable enough to avoid churn without a dedicated milestone
- New feature expansion before the next milestone is defined

## Context

- **Shipped version:** `v0.1.7` on 2026-03-06
- **Codebase state:** Active webview runtime uses Preact + `@preact/signals`; host communication remains ACP over WebSocket + JSON-RPC 2.0
- **Verification status:** `npm run compile` passed and `npm run test:unit` passed (`337 passing`, `4 pending`) on 2026-03-06
- **Codebase size:** ~32.9k lines across `src/`, `media/`, `test/`, and `scripts/`
- **Known follow-up:** message virtualization was not shipped and should be validated with real profiling before adding it to the next milestone

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
- Host diagnostics, file-size compliance, and coverage gates all shipped in this milestone.
- The next milestone has not been defined yet, and `.planning/REQUIREMENTS.md` should be recreated fresh when planning resumes.

## Next Milestone Goals

- Create fresh milestone requirements and roadmap artifacts via `$gsd-new-milestone`
- Decide whether conversation virtualization and any remaining render-performance work should enter the next milestone
- Reassess release packaging/publish follow-through after the planning reset

---
*Last updated: 2026-03-06 after v0.1.7 milestone archive*
