---
phase: 02-file-size-compliance
plan: 04
subsystem: infra
tags: [process-manager, startup-probe, websocket-readiness, size-compliance, regression-tests]
requires:
  - phase: 02-file-size-compliance-03
    provides: "Established facade-first extraction pattern and size-regression guardrails for oversized host modules"
provides:
  - "Dedicated startup probe orchestration in src/process/processStartupProbe.ts"
  - "ProcessManager reduced to 343 lines while preserving port fallback and readiness behavior"
  - "Structured startup probe result/error contract for signal/websocket readiness tests"
  - "Phase 2 closed with all four target source files below 500 lines"
affects: [process-lifecycle, websocket-readiness, phase-02-verification, milestone-closeout]
tech-stack:
  added: []
  patterns:
    - "ProcessManager remains the public lifecycle facade while startup probe orchestration lives in a focused process module"
    - "Startup probe seams expose structured readiness metadata to tests without leaking probe internals into callers"
key-files:
  created: [src/process/processStartupProbe.ts]
  modified: [src/processManager.ts, src/test/processManager.test.ts, .planning/phases/02-file-size-compliance/02-VERIFICATION.md, .planning/REQUIREMENTS.md, .planning/ROADMAP.md, .planning/STATE.md]
key-decisions:
  - "Kept ProcessManager responsible for cached discovery/start-mode orchestration and delegated spawn/readiness buffering to launchManagedProcess."
  - "Exported startManagedProcessWithProbe and ProcessStartupProbeError so the already-landed RED tests could validate ready-via metadata and structured failure details directly."
  - "Reconciled stale planning metadata with the current repo state instead of re-running already-verified Phase 04 preact migration work."
patterns-established:
  - "Oversized lifecycle facades are reduced by extracting cohesive startup/probe modules plus a thin public wrapper."
  - "Phase closeout includes explicit planning-state reconciliation when roadmap/requirements drift behind verified code."
requirements-completed: [SIZE-04]
duration: 31 min
completed: 2026-03-06
---

# Phase 2 Plan 4: File Size Compliance Summary

**Process startup probing was extracted into a focused helper module while `ProcessManager` became a 343-line facade that still preserves port fallback, ready-signal, and WebSocket readiness behavior.**

## Performance

- **Duration:** 31 min
- **Started:** 2026-03-06T05:20:00Z
- **Completed:** 2026-03-06T05:50:43Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments

- Extracted spawn/readiness/timeout/output-buffer orchestration into `src/process/processStartupProbe.ts`.
- Reduced `src/processManager.ts` to 343 lines while keeping cached discovery, fallback-port selection, and lifecycle ownership in the facade.
- Closed the full Phase 2 gate: all four oversized source files are now below 500 lines and the full unit suite passes.

## Task Commits

Each task was committed atomically where history already existed:

1. **Task 1: Add failing startup-probe extraction tests** - `2dc6c44` (test, RED)
2. **Task 2: Extract startup probe module and slim ProcessManager facade** - `c588e1f` (feat, GREEN)
3. **Task 3: Run phase gate and reconcile roadmap/requirements/state metadata** - documented in this closeout pass

## Files Created/Modified

- `src/process/processStartupProbe.ts` - Extracted startup probe module that owns spawn/readiness/error buffering and structured readiness metadata.
- `src/processManager.ts` - Thin lifecycle facade delegating startup internals to `launchManagedProcess(...)`.
- `src/test/processManager.test.ts` - Covers structured probe result/error metadata plus managed-state cleanup on exit.
- `.planning/phases/02-file-size-compliance/02-VERIFICATION.md` - Refreshed Phase 2 verification evidence to match the final line counts and test totals.
- `.planning/REQUIREMENTS.md` - Marked `SIZE-04` complete and reconciled verified Preact requirement status.
- `.planning/ROADMAP.md` - Marked Phase 2 complete and recorded Phase 4 as already verified out of band.
- `.planning/STATE.md` - Advanced current position to completed Phase 2 and captured milestone-closeout context.

## Decisions Made

- Kept `ProcessManager` as the public API boundary and extracted only the startup-probe mechanics into `src/process/processStartupProbe.ts`.
- Made the extracted probe module expose `startManagedProcessWithProbe` and `ProcessStartupProbeError` because the repository already had RED tests pinned to that structured contract.
- Preferred reconciling stale planning metadata to the verified codebase reality for Phase 4 instead of pretending the Preact migration was still pending.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Existing RED tests required a structured probe API, not a private helper**
- **Found during:** Task 2 (startup probe extraction)
- **Issue:** The repo already contained committed failing tests (`2dc6c44`) importing `startManagedProcessWithProbe` and `ProcessStartupProbeError`, so a private-only extraction would have kept the plan red.
- **Fix:** Exported a structured probe API with `readyVia`, `readinessAttempts`, and typed startup failure metadata while keeping `ProcessManager` on the slimmer `launchManagedProcess(...)` facade.
- **Files modified:** `src/process/processStartupProbe.ts`, `src/test/processManager.test.ts`
- **Verification:** `npm run test:unit -- --grep "ProcessManager|WebSocket Readiness"`
- **Committed in:** `c588e1f`

**2. [Rule 1 - Bug] Ready-signal detection raced with WebSocket fallback readiness**
- **Found during:** Task 2 (startup probe extraction)
- **Issue:** When a ready signal arrived quickly, the delayed WebSocket probe could still settle first and report `readyVia: "websocket"` instead of `signal`.
- **Fix:** Added a `readySignalSeen` guard so explicit ready output wins over the fallback probe once observed.
- **Files modified:** `src/process/processStartupProbe.ts`
- **Verification:** `npm run test:unit -- --grep "ProcessManager|WebSocket Readiness"`
- **Committed in:** `c588e1f`

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug)
**Impact on plan:** No scope creep; both changes were necessary to preserve the intended startup semantics and satisfy the already-landed RED tests.

## Issues Encountered

- Planning metadata had drifted behind the codebase: `SIZE-04` was still open and Phase 4 was still marked pending even though the repo already contained Preact migration commits and a passing `04-VERIFICATION.md`. The closeout pass reconciled those documents to the verified repo state.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 2 is complete and the full unit suite passes with all four size targets below 500 lines.
- Phase 3 was already complete, and Phase 4 was already verified from existing Preact migration work, so milestone `v0.2.0` is ready for closeout or next-milestone planning.

---
*Phase: 02-file-size-compliance*
*Completed: 2026-03-06*

## Self-Check: PASSED

- Verified `src/process/processStartupProbe.ts` and `.planning/phases/02-file-size-compliance/02-04-SUMMARY.md` exist on disk.
- Verified task commits `2dc6c44` and `c588e1f` exist in git history.
- Verified `npm run test:unit` passed and all four Phase 2 target files are below 500 lines.
