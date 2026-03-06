# Phase 2: File Size Compliance - Research

**Researched:** 2026-03-02  
**Domain:** TypeScript module decomposition with backward-compatible facades/re-exports  
**Confidence:** HIGH

## User Constraints

- Phase goal is fixed: split the 4 oversized files while preserving behavior.
- Requirement IDs in scope are fixed: `SIZE-01`, `SIZE-02`, `SIZE-03`, `SIZE-04`.
- Backward compatibility is required: keep existing import paths stable via facade + re-export pattern where files are moved.
- Keep to project conventions from `CLAUDE.md`: source files should stay under 500 lines (tests excluded), and existing contracts (`protocol`, ACP lifecycle, webview host contracts) must not change.
- No `02-CONTEXT.md` exists; planning must derive constraints from REQUIREMENTS/STATE/ROADMAP.
- Project-local skills (`.claude/skills/openspec-*`) reinforce incremental, scoped changes with clear task sequencing and explicit progress checks; plan should follow that style.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|---|---|---|
| SIZE-01 | `acpRunExecutor.ts` split below 500 lines (extract recovery/inactivity logic) | Extract prompt/recovery flow into `src/acp/client/acpRunRecovery.ts` and keep executor as orchestration facade. |
| SIZE-02 | `sessionCoordinator.ts` split below 500 lines (extract recovery handler) | Move reusable recovery/tagging/session-reload logic into `src/acp/sessionRecoveryHandler.ts` and keep coordinator as lifecycle facade. |
| SIZE-03 | `webviewHandler.ts` split below 500 lines (extract message/file change handlers) | Move callback-map construction and file-change action handling into focused webview modules; keep `WebviewHandler` public class path unchanged. |
| SIZE-04 | `processManager.ts` split below 500 lines (extract startup probe) | Move startup probe + spawn-resolution routine into `src/process/processStartupProbe.ts`, keep `ProcessManager` facade orchestration in place. |

</phase_requirements>

## Summary

The phase is a structural refactor, not a behavior change. All four files are currently above the 500-line convention (`acpRunExecutor.ts` 620, `sessionCoordinator.ts` 630, `webviewHandler.ts` 509, `processManager.ts` 517). The safest plan is to extract cohesive logic units into same-domain modules while preserving current public entry points and imports.

The repo already uses this compatibility pattern (`src/acpClient.ts`, `src/chunkMapper.ts`, `src/protocol.ts` re-export from deeper modules). For this phase, apply that same pattern at module boundaries where needed, but avoid changing runtime contracts or message shapes.

**Primary recommendation:** plan as 4 requirement-scoped refactors (one oversized file each), each with targeted regression tests and line-count gates, then run full unit tests at phase gate.

## Baseline Snapshot

- `src/acp/client/acpRunExecutor.ts`: 620 lines
- `src/acp/sessionCoordinator.ts`: 630 lines
- `src/webviewHandler.ts`: 509 lines
- `src/processManager.ts`: 517 lines

High-coupling test surfaces to protect:
- `src/test/acpClient.test.ts` (casts into `(client as any).runExecutor.deps...`)
- `src/test/sessionCoordinator.test.ts` (error tags, auth ordering, reusable-session behavior)
- `src/test/webviewHandler.test.ts` (message routing and file-change flows)
- `src/test/processManager.test.ts` and `src/test/websocket.test.ts` (startup readiness/fallback behavior)

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---|---|---|---|
| TypeScript | `^5.9.3` | Refactor-safe typing and module boundaries | Existing project baseline |
| Node.js APIs (`child_process`, timers, path) | Runtime | Process lifecycle and startup orchestration | Existing `processManager` design |
| `ws` | `^8.18.0` | WebSocket readiness checks | Already used by process startup path |

### Supporting
| Library | Version | Purpose | When to Use |
|---|---|---|---|
| Mocha | `^11.7.4` | Regression checks during each split | Per requirement and phase gate |
| Existing in-repo helpers (`errorUtils`, `messageRouter`, `startupSignals`) | in-repo | Keep behavior stable while relocating code | During extraction to avoid reimplementation |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|---|---|---|
| Pure “move files + re-export” | Keep class files and only extract helpers | Lower migration churn; still meets size rule if enough logic is extracted |
| Large architectural rewrite | Incremental extraction by cohesive responsibilities | Incremental approach is lower-risk and maps directly to SIZE-01..04 |

## Architecture Patterns

### Recommended Project Structure
```text
src/
├── acp/
│   ├── client/
│   │   ├── acpRunExecutor.ts          # facade/orchestrator
│   │   └── acpRunRecovery.ts          # extracted recovery + inactivity flow
│   ├── sessionCoordinator.ts          # facade/orchestrator
│   └── sessionRecoveryHandler.ts      # extracted session recovery/tagging helpers
├── webview/
│   ├── messageHandler.ts              # extracted webview message callback map
│   └── fileChangeHandler.ts           # extracted file change action wrapper
├── process/
│   └── processStartupProbe.ts         # extracted startup probe + readiness orchestration
├── webviewHandler.ts                  # facade class remains import-stable
└── processManager.ts                  # facade class remains import-stable
```

### Pattern 1: Thin Facade + Extracted Module
**What:** Keep current entry file/class as public integration boundary; move cohesive inner logic out.  
**When to use:** All four oversized files.  
**Why:** Preserves imports and tests while lowering file size.

### Pattern 2: Dependency-Carried Helpers (No Global Singletons)
**What:** Extract functions that receive explicit deps/context objects.  
**When to use:** Recovery/startup logic that currently depends on class fields.  
**Why:** Prevents hidden coupling and keeps test seams intact.

### Pattern 3: Handler Map Construction Outside `WebviewHandler`
**What:** Build `routeWebviewMessage` handler map in dedicated modules.  
**When to use:** `handleMessage` currently mixes many callbacks and file-change error handling.  
**Why:** Clean split for SIZE-03 without altering message protocol.

### Pattern 4: Startup Probe as a Focused State Machine
**What:** Move spawn/readiness/timeout/exit flow into a probe module that returns structured startup result or error.  
**When to use:** `startManagedProcessOnPort` currently owns too many responsibilities.  
**Why:** Directly satisfies SIZE-04 and makes probe behavior easier to test.

### Anti-Patterns to Avoid
- Partial extraction that only removes ~10 lines and leaves files near 500 (no headroom for future changes).
- Rewriting logic while moving it (move first, behavior-preserving edits only).
- Changing exported class names/constructor signatures during split.
- Moving test hooks accidentally (`setConnectionForTests`, runtime `deps` seams used by tests).

## File-by-File Extraction Guidance

### SIZE-01: `acpRunExecutor.ts` → extract recovery/inactivity
Recommended extraction units:
- `connectWithRecovery` + missing-session fallback logic
- `executePromptWithGuard`, inactivity race, and post-cancel recovery prompt handling
- optionally prompt-result parsing (`extractPromptResult*`) if additional headroom is needed

Planning note: `acpClient.test.ts` mutates `(client as any).runExecutor.deps.getConfig/createInactivityGuard`; preserve this test seam.

### SIZE-02: `sessionCoordinator.ts` → extract recovery handler
Recommended extraction units:
- reusable-session recovery/reload flow (`ensureSessionLoadedForReusableConnection`)
- layer-tag/error-tag recovery helpers (`ensureLayerTag`, `toLayerTaggedError`, auth method ordering helpers)

Planning note: preserve exact tag semantics (`[TRANSPORT_ERROR]`, `[AUTH_ERROR]`, `[PROTOCOL_ERROR]`) and appended auth recovery action text.

### SIZE-03: `webviewHandler.ts` → extract message/file change handlers
Recommended extraction units:
- handler map builder passed into `routeWebviewMessage`
- file-change action handler with `toAppError` wrapping and `showErrorMessage`

Planning note: keep `WebviewHandler` constructor wiring unchanged (store/client/services lifecycle still owned here).

### SIZE-04: `processManager.ts` → extract startup probe
Recommended extraction units:
- spawn lifecycle routine currently in `startManagedProcessOnPort` (stdout/stderr ingestion, timeout, readiness probe, exit handling)
- structured startup result contract (`effectivePort`, logs, status) for manager facade

Planning note: preserve fallback behavior for `EADDRINUSE`, readiness via either output signal or websocket probe, and `--stream` flag behavior.

## Don’t Hand-Roll

| Problem | Don’t Build | Use Instead | Why |
|---|---|---|---|
| Message routing | Custom switch router in multiple places | Existing `routeWebviewMessage` pattern | Keeps one routing contract |
| Error normalization | Ad-hoc `err instanceof Error ? ...` logic | Existing `toAppError` / `normalizeErrorMessage` | Consistent user-facing errors |
| Startup signal parsing | New regex set per module | Existing `startupSignals.ts` helpers | Avoid drift in startup interpretation |
| WebSocket probe loop | New retry loop | Existing `waitForWebSocketReadiness` | Existing tests already cover behavior |

## Common Pitfalls

### Pitfall 1: Breaking backward-compatible imports
**What goes wrong:** moving implementation but changing import path or symbol names.  
**How to avoid:** keep facade filenames and exports stable; use re-export when relocating classes.

### Pitfall 2: Test seam regressions after “cleanups”
**What goes wrong:** removing runtime `deps` access patterns used by tests through `any`.  
**How to avoid:** preserve current class property/dependency surface during this phase.

### Pitfall 3: Behavior drift while extracting
**What goes wrong:** subtle changes to timeout ordering, log timing, or error tag text.  
**How to avoid:** extract with minimal edits first; behavior changes only if a test proves parity.

### Pitfall 4: Not enough size headroom
**What goes wrong:** ending at 495-499 lines; next small edit violates policy again.  
**How to avoid:** target ~350-450 lines for each refactored file.

## Code Examples

### Example: Facade + extracted helper composition
```ts
// src/acp/client/acpRunExecutor.ts
import { executePromptWithRecovery } from "./acpRunRecovery";

export class AcpRunExecutor {
  async run(options: RunOptions, callbacks: RunCallbacks): Promise<string | undefined> {
    // orchestration + state toggles stay here
    return executePromptWithRecovery(this.deps, options, callbacks);
  }
}
```

### Example: Extracted webview handler map
```ts
// src/webview/messageHandler.ts
export function createWebviewMessageHandlers(ctx: WebviewMessageContext): MessageHandlers {
  return {
    ready: async () => { /* existing ready logic */ },
    fileChangeAction: async (msg) => ctx.handleFileChangeAction(msg),
    // ...
  };
}
```

## State of the Art

| Old Approach | Current Recommended Approach | Impact |
|---|---|---|
| Monolithic service files with mixed responsibilities | Facade classes plus focused domain modules | Keeps compatibility while improving maintainability |
| In-file giant callback objects | Extracted handler-map builders with context objects | Easier testing and clearer ownership |
| Startup orchestration fully inline in manager | Dedicated startup probe module + manager facade | Better separation, lower regression risk |

## Planning Guidance (Executable Breakdown)

1. Create a Phase 2 preflight task: capture baseline line counts + baseline targeted tests.
2. Implement SIZE-01 split and run targeted ACP client tests.
3. Implement SIZE-02 split and run targeted session coordinator tests.
4. Implement SIZE-03 split and run targeted webview handler tests.
5. Implement SIZE-04 split and run targeted process manager/websocket tests.
6. Run full unit suite and confirm all 4 source files remain <500 lines.
7. Update roadmap/requirements traceability if needed (see open question below).

## Suggested Validation Commands

- `wc -l src/acp/client/acpRunExecutor.ts src/acp/sessionCoordinator.ts src/webviewHandler.ts src/processManager.ts`
- `npm run test:unit -- --grep "AcpClient|SessionCoordinator|WebviewHandler|ProcessManager|WebSocket Readiness"`
- `npm run test:unit`

## Open Questions

1. **Phase numbering mismatch between docs**
   - What we know: `ROADMAP.md` defines File Size Compliance as Phase 2; `REQUIREMENTS.md` traceability still maps `SIZE-*` to Phase 3.
   - What’s unclear: whether this is intentional or stale metadata.
   - Recommendation: resolve during planning docs update to avoid downstream reporting confusion.

2. **Extraction style per file**
   - What we know: both approaches are viable: keep class in original file with helper extraction, or move class and leave pure re-export facade.
   - What’s unclear: preferred consistency rule for deep modules (only top-level wrappers currently use explicit re-export facade files).
   - Recommendation: decide once in Wave 0 and apply uniformly across all four files.

## Sources

### Primary (HIGH confidence)
- `.planning/REQUIREMENTS.md`
- `.planning/STATE.md`
- `.planning/ROADMAP.md`
- `CLAUDE.md`
- `REFACTOR.md`
- `src/acp/client/acpRunExecutor.ts`
- `src/acp/sessionCoordinator.ts`
- `src/webviewHandler.ts`
- `src/processManager.ts`
- `src/webview/messageRouter.ts`
- `src/process/startupSignals.ts`
- `src/process/webSocketReadinessProbe.ts`
- `src/acp/client/acpClientFacade.ts`
- `src/acpClient.ts`
- `src/chunkMapper.ts`
- `src/protocol.ts`
- `src/test/acpClient.test.ts`
- `src/test/sessionCoordinator.test.ts`
- `src/test/webviewHandler.test.ts`
- `src/test/processManager.test.ts`
- `src/test/websocket.test.ts`

### Secondary (MEDIUM confidence)
- `.claude/skills/openspec-apply-change/SKILL.md`
- `.claude/skills/openspec-archive-change/SKILL.md`
- `.claude/skills/openspec-explore/SKILL.md`
- `.claude/skills/openspec-propose/SKILL.md`

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all tooling and versions come from local `package.json` and current code.
- Architecture: HIGH - extraction seams are directly visible in current source and tests.
- Pitfalls: HIGH - risks are evidenced by existing test coupling and known facade/re-export conventions.

**Research date:** 2026-03-02  
**Valid until:** 2026-04-01 (stable refactor domain)
