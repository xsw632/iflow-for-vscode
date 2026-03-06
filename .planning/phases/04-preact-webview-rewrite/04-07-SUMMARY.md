---
phase: 04-preact-webview-rewrite
plan: 07
subsystem: ui
tags: [preact, reducer, tsx, shell-contracts, webview]
requires:
  - phase: 04-preact-webview-rewrite
    provides: reducer selectors/actions and typed VS Code command bridge from 04-05
provides:
  - reducer-driven App shell composition across top bar, conversation panel, message list, composer, and pending panels
  - typed placeholder contracts for shell surfaces under media/components and media/panels
  - shared pending-panel types aligned with plan approval feedback protocol option
affects: [04-preact-webview-rewrite, media-runtime, downstream-ui-migrations]
tech-stack:
  added: []
  patterns:
    - reducer selector model builder in App as the shell composition boundary
    - typed placeholder TSX contracts for incremental migration without prop churn
key-files:
  created:
    - media/components/TopBar.tsx
    - media/components/ConversationPanel.tsx
    - media/components/MessageList.tsx
    - media/components/Composer.tsx
    - media/panels/ApprovalPanel.tsx
    - media/panels/QuestionPanel.tsx
    - media/panels/PlanApprovalPanel.tsx
  modified:
    - media/app/App.tsx
    - media/panels/panelTypes.ts
    - test/webview/appShellContracts.test.ts
key-decisions:
  - "Split shell surfaces into dedicated TSX placeholder modules so App remains reducer-driven composition glue and stays under file-size guardrails."
  - "Kept App-owned callback construction (`createAppShellCallbacks`) and exported shell-model helpers to stabilize downstream integration tests."
  - "Expanded `PlanOption` to include `feedback` so panel contracts align with `WebviewMessage.planApproval` protocol."
patterns-established:
  - "App shell state is projected through `buildAppShellModel` selectors before being passed to UI surfaces."
  - "Pending panel routing uses explicit precedence: approval -> question -> plan."
requirements-completed: [PREACT-01, PREACT-03]
duration: 13 min
completed: 2026-03-04
---

# Phase 04 Plan 07: Shell Composition Contracts Summary

**Reducer-driven shell composition now flows through `App.tsx` into typed TSX placeholder surfaces for top bar, conversation panel, message list, composer, and pending approval/question/plan panels.**

## Performance

- **Duration:** 13 min
- **Started:** 2026-03-04T03:58:32Z
- **Completed:** 2026-03-04T04:11:41Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- Implemented a reducer-selector-based shell model in `App.tsx` with typed callback wiring to `useVscodeApiCommands`.
- Added placeholder contract components in `media/components/*` for top bar, conversation panel, message list, and composer surfaces.
- Added placeholder contract panels in `media/panels/*` for approval/question/plan flows and aligned panel option parsing with protocol `feedback`.
- Added/extended contract tests in `test/webview/appShellContracts.test.ts` using RED -> GREEN commits per task.

## Task Commits

Each task was committed atomically:

1. **Task 1: Compose reducer-driven App shell with typed selectors and callbacks** - `88e18cc` (`test`), `fe73e16` (`feat`)
2. **Task 2: Lock placeholder component/panel contracts for downstream migrations** - `fe07499` (`test`), `1e36b65` (`feat`)

_Note: TDD tasks used two commits each (failing test -> implementation)._

## Files Created/Modified
- `media/app/App.tsx` - reducer-driven shell model, callback adapter, pending panel routing, and component composition.
- `media/components/TopBar.tsx` - top bar placeholder contract for CLI/session controls.
- `media/components/ConversationPanel.tsx` - conversation list placeholder contract with switch/delete callbacks.
- `media/components/MessageList.tsx` - message area placeholder contract with streaming indicator slot.
- `media/components/Composer.tsx` - composer placeholder contract including send/cancel/mode/model/think/file-change callbacks.
- `media/panels/ApprovalPanel.tsx` - tool approval placeholder contract.
- `media/panels/QuestionPanel.tsx` - question-answer placeholder contract.
- `media/panels/PlanApprovalPanel.tsx` - plan approval placeholder contract.
- `media/panels/panelTypes.ts` - shared pending panel and plan option contracts (`feedback` included).
- `test/webview/appShellContracts.test.ts` - shell model + contract tests for App/component/panel surfaces.

## Decisions Made
- Kept `App.tsx` responsible for mapping reducer state + command helpers into a single typed view-model boundary (`buildAppShellModel`) instead of scattering selector usage across component files.
- Preserved explicit callback names (`onSend`, `onCancel`, `onSetMode`, `onSetModel`, `onSetThink`) on composer contracts so downstream migration plans can attach richer behavior without API churn.
- Updated plan option typing to include `feedback` to match protocol truth in `src/protocol/webviewMessages.ts`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed hook dependency from plan approval placeholder to keep contract tests callable**
- **Found during:** Task 2 verification
- **Issue:** `PlanApprovalPanel` used `useState`, but contract tests intentionally call components as pure functions; this caused runtime hook-context failures.
- **Fix:** Switched to a hook-free placeholder input capture in `PlanApprovalPanel`.
- **Files modified:** `media/panels/PlanApprovalPanel.tsx`
- **Verification:** `npx tsc ... test/webview/*.test.ts` + `mocha` (10 passing)
- **Committed in:** `1e36b65`

**2. [Rule 3 - Blocking] Scoped legacy-dependency grep verification to plan target files**
- **Found during:** Task 2 verification
- **Issue:** The plan’s broad grep target (`media/panels`) matched pre-existing legacy controller files unrelated to this plan’s new shell contracts.
- **Fix:** Re-ran the legacy-import gate against the explicit plan file set (`App.tsx`, new component files, new panel files, `panelTypes.ts`).
- **Files modified:** None (verification scope correction only)
- **Verification:** scoped grep gate reported `Shell contracts isolated from legacy runtime`

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking verification scope)
**Impact on plan:** No scope creep; both changes were required to verify and preserve the contract-focused objective.

## Issues Encountered
- A shell-policy block rejected a cleanup variant during ad-hoc test execution; tests were rerun with non-destructive commands.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Shell composition contracts are now explicit and typed, so downstream plans can migrate UI internals without changing App-level wiring.
- App composition path is isolated from legacy renderer/controller imports across the plan target files.

---
*Phase: 04-preact-webview-rewrite*
*Completed: 2026-03-04*

## Self-Check: PASSED
