# Roadmap: IFlow for VS Code v0.2.0

**Created:** 2026-03-02
**Milestone:** v0.2.0 Stability & Preact Migration
**Core Value:** Users can interact with iFlow AI directly in VS Code with real-time streaming responses and full tool integration

## Phase Overview

| # | Phase | Goal | Requirements | Success Criteria |
|---|-------|------|--------------|------------------|
| 1 | Error Context | Add structured diagnostic context to all error paths | ERR-01, ERR-02, ERR-03, ERR-04 | 4 |
| 2 | File Size Compliance | Split 4 oversized files below 500-line convention limit | SIZE-01, SIZE-02, SIZE-03, SIZE-04 | 6 |
| 3 | Test Coverage | Fill coverage gaps and reach 80%+ overall | TEST-01, TEST-02, TEST-03, TEST-04 | 4 |
| 4 | Preact Webview Rewrite | Full rewrite of webview (media/) using Preact | PREACT-01, PREACT-02, PREACT-03, PREACT-04 | 5 |

## Plan Progress

| Phase | Plans Complete | Latest Completed Plan | Status |
|---|---|---|---|
| 1 — Error Context | 3/3 | 01-03 (2026-03-02) | Complete |
| 2 — File Size Compliance | 1/4 | 02-01 (2026-03-03) | In Progress |
| 3 — Test Coverage | 0/0 | — | Pending |
| 4 — Preact Webview Rewrite | 0/0 | — | Pending |

## Phase Details

### Phase 1: Error Context

**Goal:** Add structured error context to CLI discovery, pipeline validation, connection failures, and process startup so users and developers can diagnose issues without guessing.

**Requirements:** ERR-01, ERR-02, ERR-03, ERR-04

**Success Criteria:**
1. CLI discovery failure message lists all paths tried and the reason each failed
2. Pipeline validation error includes the specific failing step (INVALID_FILES, INVALID_CONTEXT, INVALID_MODEL)
3. Connection error is tagged with layer (TRANSPORT_ERROR, PROTOCOL_ERROR, AUTH_ERROR)
4. Process startup error includes port number, node path used, and timeout value

**Key files:**
- `src/cliDiscovery.ts` — accumulate path attempts, include in error
- `src/webview/sendMessagePipeline.ts` — wrap validation stages with error codes
- `src/acp/sessionCoordinator.ts` — tag errors by layer
- `src/processManager.ts` — add structured context to startup errors

**Dependencies:** None — can start immediately.

---

### Phase 2: File Size Compliance

**Goal:** Split the 4 files exceeding 500 lines into focused modules while preserving the facade + re-export backward compatibility pattern.

**Requirements:** SIZE-01, SIZE-02, SIZE-03, SIZE-04

**Success Criteria:**
1. acpRunExecutor.ts is below 500 lines with recovery logic extracted to acpRunRecovery.ts
2. sessionCoordinator.ts is below 500 lines with recovery extracted to sessionRecoveryHandler.ts
3. webviewHandler.ts is below 500 lines with handlers extracted (messageHandler, fileChangeHandler)
4. processManager.ts is below 500 lines with startup probe extracted to processStartupProbe.ts
5. All existing imports continue to work (re-exports preserved)
6. All existing tests pass without modification

**Key files:**
- `src/acp/client/acpRunExecutor.ts` (562 lines) → split
- `src/acp/sessionCoordinator.ts` (532 lines) → split
- `src/webviewHandler.ts` (509 lines) → split
- `src/processManager.ts` (504 lines) → split

**Dependencies:** Should run after Phase 1 (error context changes touch some of the same files).

---

### Phase 3: Test Coverage

**Goal:** Fill test coverage gaps in critical infrastructure files and reach 80%+ overall project coverage.

**Requirements:** TEST-01, TEST-02, TEST-03, TEST-04

**Success Criteria:**
1. cliDiscovery.ts coverage is above 60% (mock cp.exec, fs.existsSync for platform fallbacks)
2. portDiscovery.ts coverage is above 60% (mock port allocation, availability checks)
3. jsonFileStore.ts coverage is above 60% (mock fs for I/O errors, concurrent access)
4. Overall project coverage is 80.0% or higher (currently 78.4%)

**Key files:**
- `test/unit/cliDiscovery.test.ts` — new/expanded
- `test/unit/portDiscovery.test.ts` — new/expanded
- `test/unit/jsonFileStore.test.ts` — new/expanded
- Additional test files for other low-coverage modules as needed

**Dependencies:** Should run after Phase 2 (file splits may change import paths in tests).

---

### Phase 4: Preact Webview Rewrite

**Goal:** Full rewrite of the webview (media/ directory) using Preact with component model, virtual DOM, and hooks-based state management. Extension host side (src/) stays unchanged — the postMessage contract is preserved.

**Requirements:** PREACT-01, PREACT-02, PREACT-03, PREACT-04

**Success Criteria:**
1. All media/ files rewritten using Preact components (JSX)
2. Virtual DOM handles all rendering — no manual innerHTML or insertAdjacentHTML
3. State management uses Preact hooks or signals (Claude's discretion)
4. All existing functionality preserved: chat, streaming, tool previews, panels, file changes, slash menu, plan mode
5. Webpack webview bundle updated for JSX/TSX compilation

**Key changes:**
- Add `preact` and `@preact/signals` (or equivalent) dependencies
- Update `tsconfig.webview.json` for JSX
- Update `webpack.config.js` for TSX compilation
- Rewrite all `media/` files as Preact components
- Replace `media/renderers/*.ts` (string templates) with component tree
- Replace `media/panels/*.ts` (DOM controllers) with Preact panel components
- Replace `media/eventBinder.ts` with declarative event handling in JSX
- CSS approach: Claude's discretion (plain CSS or CSS Modules)

**Dependencies:** Should run after Phase 3 (all stability and quality work done first, clean baseline).

---

## Build Order

```
Phase 1 (Error Context) ──→ Phase 2 (File Size) ──→ Phase 3 (Test Coverage) ──→ Phase 4 (Preact Rewrite)
```

Phase 1 can start immediately.
Phase 2 depends on Phase 1 (shared file modifications).
Phase 3 depends on Phase 2 (file splits affect test imports).
Phase 4 depends on Phase 3 (stable, tested baseline before rewrite).

---

*Roadmap created: 2026-03-02*
*Milestone: v0.2.0 Stability & Preact Migration*
