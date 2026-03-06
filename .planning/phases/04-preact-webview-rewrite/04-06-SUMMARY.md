---
phase: 04-preact-webview-rewrite
plan: 06
subsystem: ui
tags: [preact, migration-guard, parity-gates, webview]
requires:
  - phase: 04-preact-webview-rewrite
    provides: legacy runtime retirement from 04-04, 04-09, and 04-10
provides:
  - static migration guard for forbidden DOM patch APIs and retired import paths
  - denylist enforcement for retired legacy media runtime modules
  - npm entrypoint and parity checklist evidence for PREACT-04 gates
affects: [04-preact-webview-rewrite, media-runtime, verification-gates]
tech-stack:
  added: []
  patterns:
    - full-surface media guard checks run as standalone npm verification gate
    - retired runtime compatibility is declaration-only where noisy legacy files must remain unstaged
key-files:
  created:
    - scripts/check-webview-preact-migration.mjs
    - .planning/phases/04-preact-webview-rewrite/04-PARITY-CHECKLIST.md
    - media/appState.d.ts
    - media/renderers/messageRenderer.d.ts
    - media/renderers/composerRenderer.d.ts
    - media/renderers/sharedRendererUtils.d.ts
  modified:
    - package.json
    - media/appLifecycle.ts (deleted)
    - media/appMessageRouter.ts (deleted)
    - media/appState.ts (deleted)
    - media/eventBinder.ts (deleted)
    - media/inputController.ts (deleted)
    - media/renderDriver.ts (deleted)
    - media/slashMenuController.ts (deleted)
    - media/webviewUtils.ts (deleted)
    - media/panels/panelControllers.ts (deleted)
    - media/renderers/messageRenderer.ts (deleted)
    - media/renderers/composerRenderer.ts (deleted)
    - media/renderers/conversationPanelRenderer.ts (deleted)
    - media/renderers/topBarRenderer.ts (deleted)
    - media/renderers/sharedRendererUtils.ts (deleted)
key-decisions:
  - "Enforced a static PREACT migration guard across media runtime sources with retired-path import denial and required TSX roots."
  - "Retired remaining denylisted legacy runtime module .ts files instead of keeping shim implementations."
  - "Used declaration-only compatibility stubs for noisy legacy file type-check dependencies without restoring retired runtime modules."
patterns-established:
  - "Run `npm run check:webview-preact` alongside compile/unit tests as PREACT durability gate."
  - "Guard scans `.ts`/`.tsx` runtime sources while excluding declaration-only shims from import/API enforcement."
requirements-completed: [PREACT-02, PREACT-04]
duration: 14m
completed: 2026-03-04
---

# Phase 04 Plan 06: Migration Guard and Parity Gates Summary

**Static PREACT migration guardrails now enforce retired runtime boundaries and parity verification gates across the webview media surface.**

## Performance

- **Duration:** 14m
- **Started:** 2026-03-04T06:38:53Z
- **Completed:** 2026-03-04T06:53:21Z
- **Tasks:** 2
- **Files modified:** 21

## Accomplishments

- Added `scripts/check-webview-preact-migration.mjs` to enforce forbidden DOM patch API bans, retired-path import bans, retired file denylist checks, and required Preact root files.
- Retired remaining legacy runtime `.ts` modules listed in the denylist so reintroduction of deprecated runtime paths is blocked by default.
- Wired `npm run check:webview-preact` and created `04-PARITY-CHECKLIST.md` with PREACT-04 user-flow evidence links across split migration summaries.
- Added declaration-only compatibility shims to keep compile/test pipelines green while respecting explicit unstaged-noise constraints on `media/streamingViewUpdater.ts`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add full-surface PREACT migration guard with legacy module denylist** - `46685fa` (feat)
2. **Task 2: Wire npm guard entrypoint and record parity evidence checklist** - `07c8671` (chore)

## Files Created/Modified

- `scripts/check-webview-preact-migration.mjs` - Static migration guard for APIs, imports, denylisted files, and required runtime roots.
- `package.json` - Adds `check:webview-preact` gate command.
- `.planning/phases/04-preact-webview-rewrite/04-PARITY-CHECKLIST.md` - PREACT-04 parity checklist and split-summary evidence map.
- `media/*.ts` legacy runtime files (listed in frontmatter) - Removed retired runtime modules now denied by guard.
- `media/appState.d.ts`, `media/renderers/*.d.ts` - Declaration-only shims for noisy legacy file type compatibility.

## Decisions Made

- Chose strict retired-file enforcement for legacy `.ts` runtime modules instead of preserving throw/no-op shims.
- Preserved user-noise constraints by avoiding edits/staging to `media/streamingViewUpdater.ts` and handling compile impact via declaration shims.
- Scoped guard source scanning to runtime `.ts`/`.tsx` files and excluded `.d.ts` declarations to avoid false-positive retired-import failures.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Existing denylisted legacy modules prevented guard success**
- **Found during:** Task 1
- **Issue:** Multiple explicit denylist files still existed in `media/`, which would make the new migration gate fail immediately.
- **Fix:** Removed all remaining denylisted legacy runtime `.ts` files except the explicitly constrained noisy file path.
- **Files modified:** `media/appLifecycle.ts`, `media/appMessageRouter.ts`, `media/appState.ts`, `media/eventBinder.ts`, `media/inputController.ts`, `media/renderDriver.ts`, `media/slashMenuController.ts`, `media/webviewUtils.ts`, `media/panels/panelControllers.ts`, `media/renderers/messageRenderer.ts`, `media/renderers/composerRenderer.ts`, `media/renderers/conversationPanelRenderer.ts`, `media/renderers/topBarRenderer.ts`, `media/renderers/sharedRendererUtils.ts`
- **Verification:** `node scripts/check-webview-preact-migration.mjs`
- **Committed in:** `46685fa`

**2. [Rule 3 - Blocking] Noisy legacy file type-check imports broke compile after runtime retirement**
- **Found during:** Task 2 verification
- **Issue:** `media/streamingViewUpdater.ts` still imports removed legacy modules and webpack type-checks this file, causing compile errors.
- **Fix:** Added declaration-only compatibility stubs (`.d.ts`) for required legacy import paths while keeping retired `.ts` runtime files deleted.
- **Files modified:** `media/appState.d.ts`, `media/renderers/messageRenderer.d.ts`, `media/renderers/composerRenderer.d.ts`, `media/renderers/sharedRendererUtils.d.ts`
- **Verification:** `npm run compile && npm run test:unit && npm run check:webview-preact`
- **Committed in:** `07c8671`

**3. [Rule 1 - Bug] Guard falsely flagged retired imports in declaration-only compatibility files**
- **Found during:** Task 2 verification
- **Issue:** The initial guard included `.d.ts` files in source scans, incorrectly treating declaration shims as runtime retired-path imports.
- **Fix:** Updated guard file collection to exclude `.d.ts` from scan scope.
- **Files modified:** `scripts/check-webview-preact-migration.mjs`
- **Verification:** `npm run check:webview-preact`
- **Committed in:** `07c8671`

---

**Total deviations:** 3 auto-fixed (2 blocking, 1 bug)
**Impact on plan:** Deviations were required to satisfy the intended PREACT durability gate while preserving explicit local-noise staging constraints.

## Issues Encountered

- `npm run test:unit` initially picked up stale generated `out/test/test/webview/*` artifacts from prior runs; cleared `out/test` before rerunning verification.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- PREACT migration durability now has a dedicated static guard command and parity evidence artifact.
- Phase 04 can close with compile/unit/guard gates in place and requirement IDs PREACT-02 and PREACT-04 explicitly tracked.

---
*Phase: 04-preact-webview-rewrite*
*Completed: 2026-03-04*

## Self-Check: PASSED

- FOUND: `.planning/phases/04-preact-webview-rewrite/04-06-SUMMARY.md`
- FOUND: `46685fa`
- FOUND: `07c8671`
