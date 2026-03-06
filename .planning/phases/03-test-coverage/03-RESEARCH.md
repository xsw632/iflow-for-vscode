# Phase 3: Test Coverage - Research

**Researched:** 2026-03-03  
**Domain:** Mocha/c8 coverage expansion for startup-critical host infrastructure  
**Confidence:** HIGH

## User Constraints

- Phase goal is fixed: close test gaps in critical infrastructure and get project coverage to `80.0%+`.
- Requirement IDs in scope are fixed: `TEST-01`, `TEST-02`, `TEST-03`, `TEST-04`.
- Dependency is explicit: this phase should run after Phase 2, and `02-04` (ProcessManager split) is still pending in `.planning/STATE.md`.
- Follow project conventions from `CLAUDE.md`: use existing Mocha unit workflow (`npm run test:unit`, `npm run test:coverage`) and keep source contracts unchanged.
- No `03-CONTEXT.md` exists; planning constraints come from `REQUIREMENTS.md`, `STATE.md`, and `ROADMAP.md`.
- Project-local skills under `.claude/skills/` are OpenSpec workflow skills; they reinforce incremental, scoped execution with explicit progress checks.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|---|---|---|
| TEST-01 | `cliDiscovery.ts` coverage above 60% | Add discovery-path tests for Unix + Windows branches via controlled `process.platform`, `cp.exec/execFile`, and `fs` behavior; target untested discovery/fallback functions. |
| TEST-02 | `portDiscovery.ts` coverage above 60% | Add direct unit tests for `resolveStartupPort`, `isPortAvailable`, and `findAvailablePort` with deterministic `net.createServer` fakes (listen/error/listening/address/close paths). |
| TEST-03 | `jsonFileStore.ts` coverage above 60% | Module already exceeds target; add missing branch tests (Windows write branch + `statSync` fallback catch) and scenario tests for I/O/concurrency semantics to lock behavior. |
| TEST-04 | Overall project coverage >= 80% | Current baseline is 79.34%; meeting TEST-01 and TEST-02 at 60% is mathematically sufficient (project estimate ~80.71%), then re-run full coverage gate. |

</phase_requirements>

## Summary

As of 2026-03-03 (`npm run test:coverage`), the baseline is different from roadmap text: overall coverage is `79.34%` (not `78.4%`), `cliDiscovery.ts` is `40.89%`, `portDiscovery.ts` is `31.57%`, and `jsonFileStore.ts` is already `96.29%`.

The planning focus should therefore be: (1) major coverage lift in `cliDiscovery.ts`, (2) new direct tests for `portDiscovery.ts`, and (3) branch-hardening tests for `jsonFileStore.ts` to satisfy requirement intent and prevent regression. If `cliDiscovery` work is done correctly, TEST-04 should be reached without broad scattershot tests.

**Primary recommendation:** plan this phase as requirement-scoped coverage waves with deterministic platform/system-call mocking helpers, then enforce final coverage with a single full-suite gate.

## Baseline Snapshot (2026-03-03)

Command run:

```bash
npm run test:coverage
```

Coverage results:

- Overall: `8525/10744` lines (`79.34%`)
- `src/cliDiscovery.ts`: `265/648` lines (`40.89%`)
- `src/process/portDiscovery.ts`: `24/76` lines (`31.57%`)
- `src/shared/jsonFileStore.ts`: `78/81` lines (`96.29%`)

Math to 80%:

- Required for 80%: `8596` covered lines total
- Current gap: `+71` covered lines
- Raising only `cliDiscovery` and `portDiscovery` to 60% yields about `+146` lines (projected `~80.71%`)

## Data Drift To Resolve In Planning

- `ROADMAP.md` phase text still references `test/unit/*.test.ts`, but this repo’s tests are under `src/test/*.test.ts`.
- `REQUIREMENTS.md` and roadmap phase notes still include old coverage baselines for TEST items.
- `REQUIREMENTS.md` traceability maps `TEST-*` to Phase 4, while `ROADMAP.md` defines Test Coverage as Phase 3.

These should be normalized during planning/execution docs updates to avoid planning against stale paths/metrics.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---|---|---|---|
| TypeScript | `^5.9.3` | Source + tests | Existing project baseline |
| Mocha (TDD UI) | `^11.7.4` | Unit test runner (`suite`/`test`) | Existing test architecture |
| c8 | `^9.1.0` | Coverage reporting (`text` + `json-summary`) | Existing coverage gate data source |
| Node built-ins (`child_process`, `fs`, `net`) | Runtime dependencies of target files | Must be controlled in tests for deterministic branch coverage |

### Supporting
| Library | Version | Purpose | When to Use |
|---|---|---|---|
| Node `assert` | Built-in | Assertions | Existing test convention |
| Existing fake-double style in `src/test/*` | In-repo pattern | Dependency mocking without Sinon | For `net`/`cp`/`fs` behavior simulation |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|---|---|---|
| Focused module tests | Broader integration-only tests | Slower, less deterministic, weaker branch targeting |
| Existing no-library mocking pattern | Add Sinon/Jest mocks | Extra dependency churn; inconsistent with repo conventions |
| Improving coverage via exclusions | Exclude files from c8 denominator | Risks metric gaming; weak fit for phase intent |

## Architecture Patterns

### Recommended Project Structure

```text
src/test/
├── cliDiscovery.test.ts         # expand existing suite
├── portDiscovery.test.ts        # add new file
├── jsonFileStore.test.ts        # expand existing suite
└── ...
```

### Pattern 1: Requirement-Scoped Test Waves
**What:** Treat each TEST requirement as a separate wave with an explicit coverage checkpoint.  
**When to use:** Entire phase.  
**Why:** Keeps traceability clean and avoids over-testing unrelated modules.

### Pattern 2: Deterministic Global-Patch Harness
**What:** Temporary patch + restore helpers for `process.platform`, `process.env`, and Node module functions (`cp.exec`, `cp.execFile`, `fs.existsSync`, `net.createServer`).  
**When to use:** `cliDiscovery` and `portDiscovery` system-call branches.  
**Why:** Needed to hit OS-specific branches from Linux CI/local runtime without flaky environment dependence.

### Pattern 3: Behavior-First Coverage Targeting
**What:** Write tests around behaviors (fallback order, error/result classification, retry/fallback semantics), not around uncovered line numbers directly.  
**When to use:** `cliDiscovery` discovery paths and `portDiscovery` listen/error flows.  
**Why:** Improves long-term safety while still lifting coverage.

### Pattern 4: Branch-Hardening for Already-High Modules
**What:** Add narrowly targeted branch tests for `jsonFileStore` uncovered paths (lines 47, 58-59).  
**When to use:** TEST-03 completion hardening.  
**Why:** Requirement intent includes I/O/error/concurrency robustness even though metric is already passed.

### Anti-Patterns To Avoid

- Changing production code only to make tests easier when patching/fakes are enough.
- Leaving global patches unrestored across tests (causes order-dependent failures).
- Counting on host OS behavior (`which`, `where`, real ports) instead of deterministic stubs.
- Chasing overall 80% with unrelated low-value tests before TEST-01/02 are closed.

## Don’t Hand-Roll

| Problem | Don’t Build | Use Instead | Why |
|---|---|---|---|
| Mocking framework adoption | New external mocking dependency | Existing hand-crafted fake/stub style | Consistent with current repo and avoids tool churn |
| Coverage denominator manipulation | New include/exclude strategy to force 80% | Existing `npm run test:coverage` baseline | Keeps historical comparability of TEST-04 |
| Custom test runner wrappers | New runner abstraction | Existing scripts in `package.json` | Lowest-risk and already integrated |

**Key insight:** this phase should increase signal quality, not just metric percentage. Keep tests deterministic and behavior-driven.

## Common Pitfalls

### Pitfall 1: Platform branch tests that silently run on wrong platform path
**What goes wrong:** tests intended for Windows branch still execute Unix logic.  
**Why it happens:** `process.platform` not patched/restored correctly.  
**How to avoid:** helper that patches `process.platform` via `Object.defineProperty` and always restores in `finally`.  
**Warning signs:** expected `cp.exec("where ...")` never called.

### Pitfall 2: Global module patch leakage
**What goes wrong:** later suites fail due to patched `cp.exec`/`net.createServer`.  
**Why it happens:** no teardown restore path on assertion failure.  
**How to avoid:** centralized `withPatched*` helper wrappers + suite-level cleanup stack.

### Pitfall 3: Flaky async callback timing in discovery tests
**What goes wrong:** intermittent failures when callbacks resolve after assertions.  
**Why it happens:** patched exec/listen callbacks not synchronized.  
**How to avoid:** explicit Promise control and awaited completion before assertions.

### Pitfall 4: Overlooking Phase 2 dependency
**What goes wrong:** test imports or behavior drift when `02-04` refactor lands.  
**Why it happens:** planning starts against pre-split `processManager` context.  
**How to avoid:** gate Phase 3 execution on completion of Phase 2 plan 04.

### Pitfall 5: Treating TEST-03 as “done” without scenario intent
**What goes wrong:** numeric threshold passed but I/O/error/concurrency behavior remains weakly protected.  
**Why it happens:** relying only on line percentage.  
**How to avoid:** add targeted `jsonFileStore` branch + error-path tests even if percentage already high.

## Code Examples

### Example: Safe platform patch helper
```ts
function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T> | T): Promise<T> | T {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  const restore = () => {
    if (original) {
      Object.defineProperty(process, "platform", original);
    }
  };
  try {
    return run();
  } finally {
    restore();
  }
}
```

### Example: Deterministic `cp.exec` patch
```ts
const originalExec = cp.exec;
cp.exec = ((cmd, _opts, cb) => {
  if (cmd.includes("which iflow")) {
    cb?.(new Error("not found") as never, "", "");
  } else {
    cb?.(null as never, "/tmp/fake-iflow\n", "");
  }
  return {} as never;
}) as typeof cp.exec;
// ...test...
cp.exec = originalExec;
```

### Example: Fake `net.createServer` branch testing
```ts
class FakeServer extends EventEmitter {
  listen(): void { this.emit("listening"); }
  close(cb?: () => void): void { cb?.(); }
  address(): net.AddressInfo { return { address: "127.0.0.1", family: "IPv4", port: 30604 }; }
}
```

## Planning Guidance (Executable Breakdown)

1. **Wave 0: Baseline and harness setup**
   - Re-run and capture baseline coverage summary.
   - Add reusable patch/restore helpers for global Node APIs in tests.
   - Confirm Phase 2 completion state before executing coverage edits.

2. **Wave 1: TEST-01 (`cliDiscovery`)**
   - Expand `src/test/cliDiscovery.test.ts` to cover:
     - `findIFlowPathWithDiagnostics` Unix success/fallback/failure paths
     - Windows `where` parsing preference (`.ps1` > `.cmd` > first)
     - APPDATA and known-location fallback scanning
     - `findIFlowPathCrossPlatform` summary + grouped diagnostic logging
     - `collectBinaryFromVersionManagerDir` success/miss/error branches
   - Coverage checkpoint: `cliDiscovery.ts > 60%`.

3. **Wave 2: TEST-02 (`portDiscovery`)**
   - Add `src/test/portDiscovery.test.ts` with deterministic fakes for:
     - invalid configured port -> `findAvailablePort`
     - preferred port available/unavailable branches
     - `isPortAvailable` listen success and error return paths
     - `findAvailablePort` success + invalid address + error reject branches
   - Coverage checkpoint: `portDiscovery.ts > 60%`.

4. **Wave 3: TEST-03 (`jsonFileStore`) hardening**
   - Expand `src/test/jsonFileStore.test.ts` to cover:
     - Windows write path branch
     - post-write `statSync` failure catch branch
     - explicit mocked I/O error scenarios + concurrent read/update semantics
   - Coverage checkpoint: `jsonFileStore.ts remains > 60%` (currently already satisfied).

5. **Wave 4: TEST-04 phase gate**
   - Run full coverage and verify `>= 80.0%` overall.
   - If unexpectedly below target after Waves 1-3, prioritize adjacent low-coverage discovery modules (`src/nodeDiscovery.ts`) before unrelated UI modules.
   - Optionally update `scripts/check-coverage.mjs` with TEST thresholds + total floor to prevent regressions.

## Suggested Validation Commands

- `npm run test:unit -- --grep "cliDiscovery|JsonFileStore|portDiscovery|ProcessManager"`
- `npm run test:coverage`
- `node scripts/check-coverage.mjs`
- `node -e "const s=require('./coverage/coverage-summary.json'); console.log('total', s.total.lines.pct);"`

## Open Questions

1. **Should TEST-03 be treated as already complete or require explicit new scenarios?**
   - What we know: metric is already above 60% as of 2026-03-03.
   - What’s unclear: whether requirement acceptance is metric-only or scenario-specific (I/O errors + concurrency).
   - Recommendation: keep minimal hardening tests in scope to satisfy scenario intent.

2. **Should planning wait for Phase 2 plan 04 completion?**
   - What we know: roadmap dependency says yes; STATE shows 02-04 still pending.
   - What’s unclear: whether phase planning can proceed now while execution waits.
   - Recommendation: planning can proceed now; execution should gate on 02-04 completion.

3. **Should TEST traceability in REQUIREMENTS be corrected now?**
   - What we know: REQUIREMENTS maps TEST-* to Phase 4, ROADMAP says Phase 3.
   - What’s unclear: intentional vs stale metadata.
   - Recommendation: fix during this phase’s doc updates to keep reporting consistent.

## Sources

### Primary (HIGH confidence)
- `.planning/REQUIREMENTS.md`
- `.planning/STATE.md`
- `.planning/ROADMAP.md`
- `CLAUDE.md`
- `.planning/codebase/TESTING.md`
- `.planning/codebase/CONCERNS.md`
- `package.json`
- `scripts/check-coverage.mjs`
- `src/cliDiscovery.ts`
- `src/process/portDiscovery.ts`
- `src/shared/jsonFileStore.ts`
- `src/nodeDiscovery.ts`
- `src/test/cliDiscovery.test.ts`
- `src/test/jsonFileStore.test.ts`
- `src/test/processManager.test.ts`
- `coverage/coverage-summary.json` (from run on 2026-03-03)

### Secondary (MEDIUM confidence)
- `.claude/skills/openspec-apply-change/SKILL.md`
- `.claude/skills/openspec-archive-change/SKILL.md`
- `.claude/skills/openspec-explore/SKILL.md`
- `.claude/skills/openspec-propose/SKILL.md`
- `REFACTOR.md`

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all tools/commands confirmed from local project files and executed scripts.
- Architecture patterns: HIGH - test and source structures are directly observed in current code.
- Pitfalls: HIGH - risks are evidenced by current low-coverage branches and global-patch requirements.

**Research date:** 2026-03-03  
**Valid until:** 2026-04-02 (stable local tooling/domain)
