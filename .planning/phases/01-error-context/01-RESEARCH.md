# Phase 1: Error Context - Research

**Researched:** 2026-03-02
**Domain:** Extension-host error diagnostics and ACP lifecycle error classification
**Confidence:** HIGH

## User Constraints

## Implementation Decisions

### Validation Messaging
- Use `Code + plain text` format for validation failures so each error has a stable identifier and a human-readable sentence.
- Include one immediate action step per validation error.
- Use fail-fast behavior in user-facing messaging: show the first failing validation stage.
- Keep chat concise and put richer diagnostic detail in debug logs.

### Connection and Startup Tags
- Show bracketed layer tags in user-facing errors: `[TRANSPORT_ERROR]`, `[PROTOCOL_ERROR]`, `[AUTH_ERROR]`.
- For startup failures, show only core runtime context in chat: port, timeout, and short node path; keep full command/path detail in debug output.
- Authentication failures must be explicit (`AUTH_ERROR`) and include one concrete next action.
- If classification is uncertain, use `PROTOCOL_ERROR` as deterministic fallback.

### CLI Discovery Context
- Chat should show summary-level discovery failure context (attempt count + high-level reason), while full path-by-path diagnostics stay in debug logs.
- Normalize per-path failure reasons into stable reason codes (for example `NOT_FOUND`, `NOT_EXECUTABLE`, `PERMISSION_DENIED`) instead of raw platform-specific text.
- Organize diagnostics by source category (PATH lookup, known locations, version-manager scans) for faster triage.
- Include one platform-specific recovery action in the failure guidance.

### Claude's Discretion
- Exact wording templates for chat error lines and debug entries.
- Final names/shape of internal reason codes where not constrained by existing enums.
- Exact formatting of startup short node path in user-facing errors.

## Deferred Ideas

None - discussion stayed within phase scope.

## Summary

Phase 1 should be planned as a focused error-surfacing pass over four existing runtime paths, without architecture changes: CLI discovery, pipeline preflight validation, ACP connection lifecycle, and managed process startup. The existing code already has stable integration points (`toAppError`, `normalizeErrorMessage`, `SessionCoordinator.ensureConnected`, `SendMessagePipeline.executeSingle`, `ProcessManager.startManagedProcessOnPort`) so this phase is mostly about adding structured context and preserving current flow behavior.

Primary recommendation: implement structured context as lightweight typed helpers plus message tagging, keep existing public method signatures where possible, and add test coverage for each requirement-specific error shape.

## Current State vs Required Outcomes

| Requirement | Current Behavior | Gap | Planning Note |
|---|---|---|---|
| ERR-01 | `findIFlowPathCrossPlatform()` returns `string | null`; failures are generic and mostly log-only. | No structured per-attempt diagnostics or reason codes. | Add diagnostic collector type + failure summary in chat, full attempt detail in debug logs. |
| ERR-02 | `sendMessagePipeline` has no explicit preflight validation stages for files/context/model. | No stage-coded failure (`INVALID_FILES`, `INVALID_CONTEXT`, `INVALID_MODEL`). | Add fail-fast validation function before `client.run()` and route through existing stream error path. |
| ERR-03 | `SessionCoordinator` rethrows raw errors from connect/init/auth/session. | No layer tags (`TRANSPORT_ERROR`, `PROTOCOL_ERROR`, `AUTH_ERROR`). | Tag at throw sites by lifecycle stage; fallback to `PROTOCOL_ERROR`. |
| ERR-04 | Startup failures include generic timeout/exit text; command is only in debug log. | Port/nodePath/timeout not consistently included in user-visible startup errors. | Add startup-context formatter with short node path in chat and full command in debug logs. |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---|---|---|---|
| TypeScript | 5.9.x | Host-side typing and compile-time contracts | Already used across `src/` and tests |
| Node.js built-ins (`child_process`, `fs`, `path`) | Runtime | CLI discovery and process lifecycle | Existing implementation depends on these APIs |
| `ws` | ^8.18.0 | ACP WebSocket transport/readiness probing | Existing ACP transport and process readiness checks |

### Supporting
| Library | Version | Purpose | When to Use |
|---|---|---|---|
| Mocha | ^11.7.4 | Unit tests for error behavior | Add/update requirement-level regression tests |
| Existing `errorUtils` (`toAppError`, `normalizeErrorMessage`) | In-repo | Normalized error conversion | Use for all new error message construction and wrapping |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|---|---|---|
| Message tags in existing error strings | New protocol shape for `streamError` objects | Better typing but larger cross-layer migration (out of phase scope) |
| Local helper functions in each file | Shared helper module(s) | Shared module slightly more setup, but avoids growing already oversized files |

## Architecture Patterns

### Recommended Project Structure
```
src/
├── cliDiscovery.ts                  # discovery attempts + diagnostics summary
├── webview/sendMessagePipeline.ts   # validation stages + fail-fast tagging
├── acp/sessionCoordinator.ts        # layer-tagged connect/init/auth errors
├── processManager.ts                # startup error context fields
└── errorUtils.ts                    # keep centralized normalization behavior
```

### Pattern 1: Structured Error Envelope (Message + Context)
**What:** Generate user-facing message with stable tag/code while retaining machine-readable context in details/logs.
**When to use:** All new ERR-01..ERR-04 failure branches.
**How:** Build `AppError` (or tagged `Error`) once per failure branch; avoid ad-hoc message concatenation in call sites.

### Pattern 2: Fail-Fast Validation Pipeline
**What:** Ordered preflight checks: files -> IDE context -> model.
**When to use:** Before invoking `client.run()` in `SendMessagePipeline`.
**How:** First failed stage emits `[INVALID_*]` + one action step, and exits without running ACP prompt.

### Pattern 3: Lifecycle-Stage Error Tagging
**What:** Tag by connection layer where error originates.
**When to use:** `transport.connect` (`TRANSPORT_ERROR`), auth loop (`AUTH_ERROR`), initialize/session flow (`PROTOCOL_ERROR`).
**How:** Wrap and throw at stage boundary, not only in outer catch.

### Pattern 4: Concise Chat + Verbose Debug Split
**What:** Keep chat payload compact; place detailed attempt/command context in debug logs.
**When to use:** CLI discovery and startup failures.
**How:** Chat includes summary fields only; `debug()` includes per-attempt/per-command expanded context.

## Don't Hand-Roll

- Do not add new ad-hoc error normalization; use `toAppError()` and `normalizeErrorMessage()`.
- Do not redesign `ExtensionMessage` protocol shape in this phase; keep `streamError: string` and encode stable tags in message text.
- Do not bypass existing pipeline/store behavior; keep `SendMessagePipeline` as the single send/run orchestration path.
- Do not add large logic blocks to `sessionCoordinator.ts` and `processManager.ts` without helper extraction; both are already >500 lines.

## Common Pitfalls

- **Tagging too late:** If errors are only tagged in top-level catch, auth vs protocol boundaries become ambiguous.
- **Breaking missing-session recovery:** `AcpRunExecutor.connectWithRecovery()` relies on message classification for stale session recovery; keep session-not-found text detectable.
- **Over-disclosing paths in chat:** User constraints require path-by-path detail in debug logs, not chat output.
- **Inconsistent reason codes across platforms:** Normalize OS-specific errors to stable codes (`NOT_FOUND`, `NOT_EXECUTABLE`, `PERMISSION_DENIED`, etc.).
- **Message assertion fragility in tests:** Existing tests assert on message substrings; update assertions to accept new tags/context without overfitting.
- **Traceability mismatch not handled:** `.planning/REQUIREMENTS.md` traceability table still maps `ERR-*` to Phase 2 while roadmap says Phase 1.

## Code Examples

### Example A: Validation Stage Failure Shape
```ts
throw new AppError(
  "[INVALID_FILES] Attached files payload is invalid. Action: Re-attach files and retry.",
  { code: "VALIDATION_FAILED", details: { stage: "INVALID_FILES" } },
);
```

### Example B: Connection Layer Tagging
```ts
try {
  await transport.connect(connectOptions);
} catch (error) {
  throw new Error(`[TRANSPORT_ERROR] ${normalizeErrorMessage(error)}`);
}
```

### Example C: Startup Context Message
```ts
const message =
  `[STARTUP_ERROR] iFlow process startup timed out. ` +
  `port=${port}, node=${shortNodePath}, timeoutMs=${PROCESS_STARTUP_TIMEOUT_MS}. ` +
  `Action: verify iflow.nodePath and retry.`;
```

## Planning Guidance (Task Breakdown)

1. Add shared diagnostic types/helpers first (small, reusable, testable).
2. Implement ERR-01 in `cliDiscovery.ts` and wire summary usage into `ProcessManager.resolveStartMode()` error path.
3. Implement ERR-02 in `sendMessagePipeline.ts` with ordered validation helpers and tagged fail-fast errors.
4. Implement ERR-03 in `sessionCoordinator.ts` with explicit stage-based wrapping at transport/auth/protocol boundaries.
5. Implement ERR-04 in `processManager.ts`/`startupSignals.ts` with startup context formatter and short-node-path policy.
6. Update tests incrementally after each requirement area to avoid broad regression debugging.

## Test Strategy

- `src/test/cliDiscovery.test.ts`:
  - add diagnostics collector tests for reason normalization and category grouping.
- `src/test/sendMessagePipeline.test.ts`:
  - add three fail-fast tests for `INVALID_FILES`, `INVALID_CONTEXT`, `INVALID_MODEL` and order guarantee.
- `src/test/sessionCoordinator.test.ts`:
  - add transport connect failure -> `[TRANSPORT_ERROR]`.
  - add auth exhaustion -> `[AUTH_ERROR]`.
  - add initialize/session failures -> `[PROTOCOL_ERROR]`.
- `src/test/processManager.test.ts` and/or `src/test/websocket.test.ts`:
  - assert startup timeout/exit errors include `port`, short `node` path, and `timeoutMs`.
- Regression baseline observed during research:
  - `npm run test:unit -- --grep "(SendMessagePipeline|SessionCoordinator|ProcessManager|cliDiscovery|errorUtils)"`
  - 55 passing (no failures).

## Confidence by Area

- **HIGH:** Existing integration points, test harnesses, and error flow boundaries are clear and stable.
- **MEDIUM:** Exact final message templates (chat vs debug split) depend on wording choices in implementation.
- **LOW:** None identified for phase planning scope.

## Sources

- `.planning/phases/01-error-context/01-CONTEXT.md`
- `.planning/REQUIREMENTS.md`
- `.planning/STATE.md`
- `CLAUDE.md`
- `.claude/skills/openspec-apply-change/SKILL.md`
- `.claude/skills/openspec-archive-change/SKILL.md`
- `.claude/skills/openspec-explore/SKILL.md`
- `.claude/skills/openspec-propose/SKILL.md`
- `src/cliDiscovery.ts`
- `src/webview/sendMessagePipeline.ts`
- `src/acp/sessionCoordinator.ts`
- `src/processManager.ts`
- `src/errorUtils.ts`
- `src/process/startupSignals.ts`
- `src/test/cliDiscovery.test.ts`
- `src/test/sendMessagePipeline.test.ts`
- `src/test/sessionCoordinator.test.ts`
- `src/test/processManager.test.ts`
- `src/test/websocket.test.ts`
- `src/test/errorUtils.test.ts`

