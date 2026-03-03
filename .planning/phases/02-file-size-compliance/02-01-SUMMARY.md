---
phase: 02-file-size-compliance
plan: 01
subsystem: acp
tags: [acp, session-recovery, inactivity-guard, test-regression, size-compliance]
requires:
  - phase: 01-error-context
    provides: "Deterministic ACP error lifecycle behavior preserved by recovery flow extraction"
provides:
  - "Dedicated recovery/inactivity execution module at src/acp/client/acpRunRecovery.ts"
  - "Thin AcpRunExecutor orchestration facade under SIZE-01 limit"
  - "Regression checks for recovery branches and deterministic executor line-count guard"
affects: [02-file-size-compliance-02, acp-client-runtime, acp-regression-suite]
tech-stack:
  added: []
  patterns:
    - "Dependency-carried recovery helpers without hidden module globals"
    - "Facade delegation with preserved mutable runExecutor dependency seam"
    - "Requirement guard test asserting executor line-count stays below 500 lines"
key-files:
  created: [src/acp/client/acpRunRecovery.ts]
  modified: [src/acp/client/acpRunExecutor.ts, src/test/acpClient.test.ts]
key-decisions:
  - "Kept AcpRunExecutor constructor/API and deps seam unchanged while extracting recovery logic into helper functions."
  - "Added stable-token recovery prompt assertions and a line-count guard in AcpClient tests to lock SIZE-01 behavior."
patterns-established:
  - "Run execution facade delegates connect/prompt recovery lifecycle to a focused helper module."
  - "File-size compliance is enforced by regression tests, not manual checks."
requirements-completed: [SIZE-01]
duration: 3 min
completed: 2026-03-03
---

# Phase 2 Plan 1: File Size Compliance Summary

**ACP run recovery/inactivity handling was extracted into a dedicated module while keeping executor runtime behavior stable and enforcing executor size under 500 lines.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-03T13:04:23Z
- **Completed:** 2026-03-03T13:07:48Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments
- Created `src/acp/client/acpRunRecovery.ts` to own connect retry, prompt retry, inactivity race, and post-cancel recovery prompting logic.
- Reduced `src/acp/client/acpRunExecutor.ts` to orchestration-only behavior that delegates recovery mechanics and keeps test seams intact.
- Added focused AcpClient regressions for recovery-branch behavior and a deterministic line-count guard for SIZE-01.

## Task Commits

Each task was committed atomically:

1. **Task 1: Extract run recovery and inactivity workflow into dedicated module** - `d308d7f` (feat)
2. **Task 2: Reduce executor to thin facade while preserving dependency seam** - `cc6c664` (refactor)
3. **Task 3: Requirement-focused regression and line-count guard for SIZE-01** - `486ceea` (test)

## Files Created/Modified
- `src/acp/client/acpRunRecovery.ts` - Extracted recovery/inactivity execution helpers with explicit dependency injection.
- `src/acp/client/acpRunExecutor.ts` - Refactored to a thin orchestration facade delegating recovery logic.
- `src/test/acpClient.test.ts` - Added recovery-branch and file-size compliance regression coverage.

## Decisions Made
- Preserved existing `AcpRunExecutor` class API and mutable dependency seam used by `(client as any).runExecutor.deps.*` tests.
- Locked recovery prompt stability with token-level assertions (`<system-reminder>`, `automatically cancelled`) instead of brittle full-string matching.
- Enforced SIZE-01 with an automated line-count test (`<500`) for `acpRunExecutor.ts`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed recovery-branch assertion harness to capture overridden prompt payloads**
- **Found during:** Task 3
- **Issue:** New regression assertion expected prompt requests from `fakeProtocol.requests`, but the per-test `sendRequest` override bypassed that recorder.
- **Fix:** Captured prompt payloads explicitly in the override and asserted recovery prompt tokens against the captured array.
- **Files modified:** `src/test/acpClient.test.ts`
- **Verification:** `npm run test:unit -- --grep "AcpClient"` and `wc -l src/acp/client/acpRunExecutor.ts`
- **Committed in:** `486ceea`

**2. [Rule 3 - Blocking] Unblocked STATE/ROADMAP progress updates when gsd-tools parser did not match current STATE schema**
- **Found during:** Post-task state update
- **Issue:** `state advance-plan`, `state update-progress`, `state record-metric`, and `state record-session` returned parse errors because expected sections/fields were absent in existing `STATE.md` format.
- **Fix:** Kept decision/requirements updates through gsd-tools, then manually updated current position/session/progress tables in `STATE.md` and plan progress row in `ROADMAP.md`.
- **Files modified:** `.planning/STATE.md`, `.planning/ROADMAP.md`
- **Verification:** Manual file inspection confirms Phase 2 shows `1/4` plans complete and current position points to next plan (`02`).
- **Committed in:** `505121b`

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** No product scope change; fixes were required to stabilize regression assertions and preserve planning metadata continuity.

## Authentication Gates
None.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
SIZE-01 is now covered by code structure and regression guards. Phase `02-02` can build on this extraction without reintroducing monolithic executor logic.

---
*Phase: 02-file-size-compliance*
*Completed: 2026-03-03*

## Self-Check: PASSED

- Verified required files exist on disk.
- Verified all task commit hashes are present in git history.
