---
phase: 01-error-context
plan: 03
subsystem: infra
tags: [acp, session-coordinator, error-classification, regression-tests]
requires: []
provides:
  - "Lifecycle-stage ACP failure tagging in SessionCoordinator"
  - "AUTH_ERROR messages with concrete login recovery action"
  - "Regression coverage for transport/auth/protocol tags and fallback determinism"
affects: [acp-client, run-executor, send-message-pipeline]
tech-stack:
  added: []
  patterns:
    - "Stage-boundary error wrapping with bracketed layer tags"
    - "Fallback tagging for ambiguous lifecycle failures"
key-files:
  created: []
  modified:
    - src/acp/sessionCoordinator.ts
    - src/test/sessionCoordinator.test.ts
key-decisions:
  - "Tag at exact lifecycle boundaries instead of a single top-level catch to preserve stage precision."
  - "Keep original normalized error text after tags so missing-session and reconnect heuristics continue to work."
patterns-established:
  - "TRANSPORT_ERROR for startup/connect failures, AUTH_ERROR for authentication failures, PROTOCOL_ERROR for initialize/session/runtime failures."
  - "Unclassified lifecycle failures always fall back to PROTOCOL_ERROR."
requirements-completed: [ERR-03]
duration: 13min
completed: 2026-03-02
---

# Phase 01 Plan 03: Error Context Summary

**Deterministic ACP lifecycle error tagging now distinguishes transport/auth/protocol failures with actionable auth recovery guidance and protocol fallback guarantees.**

## Performance

- **Duration:** 13 min
- **Started:** 2026-03-02T13:27:35Z
- **Completed:** 2026-03-02T13:40:30Z
- **Tasks:** 3
- **Files modified:** 2

## Accomplishments
- Added stage-boundary error wrapping in `SessionCoordinator.ensureConnected` with deterministic `[TRANSPORT_ERROR]`, `[AUTH_ERROR]`, and `[PROTOCOL_ERROR]` tags.
- Added explicit auth recovery action (`iflow login`) while preserving original normalized error text used by recovery logic.
- Added regression tests covering transport/auth/protocol classification, stale-session compatibility, non-Error normalization, and ambiguous-failure protocol fallback.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add stage-boundary layer tagging for transport, protocol, and auth failures**
   - `4b41d15` (test) RED coverage for lifecycle tags
   - `cc50105` (feat) lifecycle tagging implementation
2. **Task 2: Preserve existing recovery semantics while adding tagged errors**
   - `8b6fd84` (test) stale-session and normalization regression coverage
3. **Task 3: Add explicit fallback-classification regression coverage**
   - `86e623b` (test) ambiguous lifecycle failure fallback to `PROTOCOL_ERROR`

_Note: TDD task flow used separate RED/GREEN commits for Task 1._

## Files Created/Modified
- `src/acp/sessionCoordinator.ts` - Added stage-specific tag wrapping and fallback tag enforcement.
- `src/test/sessionCoordinator.test.ts` - Added lifecycle tag, recovery-compatibility, and fallback determinism tests.

## Decisions Made
- Tagged failures at stage boundaries (startup/connect/auth/initialize/session) to avoid lossy classification from a single generic catch.
- Preserved original normalized message text inside wrapped/tagged errors so upstream `MISSING_SESSION` and reconnect behavior remains compatible.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Initial run of `npm run test:unit -- --grep "SessionCoordinator"` temporarily failed due unrelated compile issues in `cliDiscovery` tests; subsequent runs passed without modifying unrelated files.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- ERR-03 behavior is implemented and regression-protected.
- Phase 01 can continue with remaining plan execution and requirement tracking updates.

## Self-Check: PASSED

- Found summary file: `.planning/phases/01-error-context/01-03-SUMMARY.md`
- Verified task commits: `4b41d15`, `cc50105`, `8b6fd84`, `86e623b`
