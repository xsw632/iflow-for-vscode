# Phase 4: Preact Webview Rewrite - Research

**Researched:** 2026-03-04
**Domain:** VS Code webview UI migration from string-template DOM manipulation to Preact component rendering
**Confidence:** HIGH

## User Constraints

- Scope is strictly `media/` rewrite; extension host code in `src/` must remain contract-compatible.
- `postMessage` protocol must be preserved exactly (`WebviewMessage` and `ExtensionMessage` types unchanged).
- Required outcomes are fixed: `PREACT-01`, `PREACT-02`, `PREACT-03`, `PREACT-04`.
- Existing functionality must be preserved: chat, streaming, tool previews, approval/question/plan panels, file-change review actions, slash menu, plan mode.
- Build must continue through webpack (`dist/webview.js`) with CSP-compatible webview HTML.
- Project conventions from `CLAUDE.md` still apply (notably source file size discipline and existing shared utilities).
- No phase context file exists (`.planning/phases/04-preact-webview-rewrite/*-CONTEXT.md` not found).
- `.planning/config.json` is absent, so Validation Architecture section is intentionally skipped.
- Project skill scan found only `.claude/skills/openspec-*`; these are workflow skills, not UI-library constraints.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|---|---|---|
| PREACT-01 | Webview rewritten using Preact with component model | Replace `media/main.ts` string-template assembly + renderer modules with TSX component tree and one `render(<App />)` root. |
| PREACT-02 | Virtual DOM handles efficient rendering (replaces manual innerHTML) | Remove direct HTML patching paths (`innerHTML`, `outerHTML`, `insertAdjacentHTML`) and move updates into state-driven Preact renders. |
| PREACT-03 | State management via Preact hooks/signals | Use `useReducer` for app-wide event/state transitions; optionally add `@preact/signals` for hot sub-state (streaming/pending indicator). |
| PREACT-04 | All existing webview functionality preserved | Preserve message contract, keyboard flows, panel workflows, file-open/file-change actions, and stream-status/pending semantics via parity checklist. |

</phase_requirements>

## Summary

Current webview rendering is highly imperative: full-app string render + post-render listener rebinding + targeted `outerHTML`/`innerHTML` patching for streaming and panel updates. This is exactly the architecture Phase 4 intends to replace.

The safest plan is a full TSX rewrite that keeps protocol and business semantics stable while replacing only view orchestration. Keep existing host-side flows unchanged and preserve existing shared pure logic (`src/shared/questionPanelState.ts`, `src/streamStatusUtils.ts`, `src/shared/subagentProgressTracker.ts`, markdown sanitization utilities).

**Primary recommendation:** implement a Preact component tree with `useReducer` as the baseline state model, then optionally layer `@preact/signals` only for high-frequency UI slices if profiling shows need.

## Current Baseline (What You Are Replacing)

### Webview code size and hotspots

- `media/` TS source totals: **4671 lines**.
- Biggest files: `main.ts` (501), `eventBinder.ts` (445), `questionPanelController.ts` (340), `composerRenderer.ts` (329), `editPreviewRenderer.ts` (319), `slashMenuController.ts` (311).
- Manual DOM write APIs currently used in core paths:
  - `renderCoordinator.ts` uses full-app `app.innerHTML` replacement.
  - `streamingViewUpdater.ts` uses `innerHTML`, `outerHTML`, and `insertAdjacentHTML` for incremental streaming patches.
  - `inputController.ts`, `slashMenuController.ts`, `eventBinder.ts`, `main.ts` mutate DOM fragments directly.
- Event handling is mostly imperative rebinding:
  - `eventBinder.ts` centralizes attach/detach behavior (17 listener sites), plus panel controllers add global key handlers.

### Functional surface area to preserve

- Conversation list/search/switch/delete and top bar actions.
- Composer with attachments, mention menu, slash menu, mode/model/think controls.
- Streaming pending indicator and sub-agent progress text.
- Tool previews (diff/write/command/todo) and markdown/code/thinking blocks.
- Approval/question/plan panel interactions.
- Round file-change summary card and actions (`openDiff`, `approve`, `rollback`).
- IDE context chips and dismiss behavior.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---|---|---|---|
| `preact` | `10.28.4` | Component rendering + virtual DOM | Official lightweight React-compatible API, ideal for webview bundle size. |
| `@preact/signals` | `2.8.1` | Reactive state primitives (optional/hybrid) | Fine-grained updates without custom DOM patch logic. |
| `typescript` | `5.9.3` | TSX typing and compile safety | Existing repo baseline. |
| `ts-loader` | `9.5.4` | TS/TSX webpack transpilation | Existing build pipeline already uses it. |

### Supporting
| Library/Tool | Version | Purpose | When to Use |
|---|---|---|---|
| `preact/hooks` (from `preact`) | bundled | `useReducer`, `useEffect`, `useMemo`, `useRef` | Base state/event lifecycle model. |
| Existing `media/styles.css` | in-repo | Preserve visual parity initially | First migration pass; avoid CSS churn until parity is stable. |
| Existing markdown + sanitizer utilities | in-repo | Secure rich text rendering | Keep content safety behavior unchanged. |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|---|---|---|
| `useReducer` baseline | Signals-only global store | Signals-only can work, but reducer-first better matches current message-driven state transitions. |
| Keep global stylesheet | CSS Modules | CSS Modules improve isolation but add migration complexity for no functional gain in this phase. |
| Incremental patch of existing files | Full component rewrite | Incremental patch keeps imperative debt; full rewrite better matches PREACT goals. |

**Installation:**
```bash
npm install preact @preact/signals
```

## Build and Tooling Changes Required

### `tsconfig.webview.json`

Use Preact JSX runtime configuration:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "preact"
  }
}
```

### `webpack.config.js` (webview bundle)

- Resolve `.tsx` in addition to `.ts`.
- Change loader test from `/.ts$/` to `/\.tsx?$/` for webview bundle.
- Keep `configFile: 'tsconfig.webview.json'` and current output target (`dist/webview.js`).

## Architecture Patterns

### Recommended Project Structure

```text
media/
├── main.tsx                      # acquireVsCodeApi + root render only
├── app/
│   ├── App.tsx                   # top-level composition
│   ├── state.ts                  # reducer/actions/selectors
│   ├── useExtensionMessages.ts   # window.message -> dispatch bridge
│   └── useVscodeApi.ts           # single API instance wrapper
├── components/
│   ├── TopBar.tsx
│   ├── ConversationPanel.tsx
│   ├── MessageList.tsx
│   ├── Composer.tsx
│   ├── SlashMenu.tsx
│   ├── MentionMenu.tsx
│   ├── IDEContextChips.tsx
│   └── RoundFileChangesCard.tsx
├── panels/
│   ├── ApprovalPanel.tsx
│   ├── QuestionPanel.tsx
│   └── PlanApprovalPanel.tsx
├── toolPreviews/
│   ├── ToolDetailPreview.tsx
│   ├── EditPreview.tsx
│   ├── CommandPreview.tsx
│   └── TodoPreview.tsx
└── styles.css
```

### Pattern 1: Protocol Boundary Adapter

- Keep protocol types from `src/protocol/*` as-is.
- Introduce one message bridge hook that converts incoming `ExtensionMessage` into reducer actions.
- Keep outgoing commands as typed helpers that call `vscode.postMessage`.

### Pattern 2: Reducer-First App State

- Model webview state as a reducer (`stateUpdated`, `streamChunk`, `streamStatus`, `streamEnd`, `streamError`, panel open/close actions).
- Preserve immutable update behavior so keyed child components can avoid unnecessary rerenders.
- Reuse existing domain helpers where possible (stream status reducer, question panel state reducer, sub-agent progress tracker).

### Pattern 3: Declarative Event Handling

- Replace `eventBinder.ts` with JSX handlers on rendered elements.
- Keep only a few global listeners (`window.message`, outside-click, global keydown) managed by `useEffect` with cleanup.
- Remove dataset-bound idempotency flags (`data-open-bound`, `data-file-change-bound`) by construction.

### Pattern 4: Streaming-Safe Rendering

- Render messages as keyed components (`key={message.id}` and stable block keys).
- Keep previous conversation/message object references where unchanged.
- Add memoization (`memo`, `useMemo`) only where profiling shows benefit.
- Signals can be introduced for high-frequency status text/timer UI if reducer-only updates are too noisy.

## Migration Map (Old -> New)

| Current Module(s) | Preact Destination | Notes |
|---|---|---|
| `main.ts`, `renderCoordinator.ts`, `renderDriver.ts` | `main.tsx`, `app/App.tsx` | Remove full-string app render pipeline entirely. |
| `eventBinder.ts` | JSX handlers + focused hooks (`useOutsideClick`, `useGlobalKeys`) | No post-render rebinding pass. |
| `streamingViewUpdater.ts` | reducer state updates + `MessageList`/`PendingIndicator` components | Remove direct DOM patching API usage. |
| `inputController.ts`, `slashMenuController.ts` | `Composer` + `SlashMenu` + `MentionMenu` components/hooks | Keep behavior and message payloads identical. |
| `renderers/*.ts` | TSX presentational components | Keep existing formatting/preview logic but return JSX instead of HTML strings. |
| `panels/*Controller.ts`, `panelRenderers.ts`, `questionPanelView.ts` | `panels/*.tsx` components | Keep keyboard behavior and request payload semantics. |

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| DOM diffing for streaming | custom `innerHTML` patch engine | Preact keyed rendering + memoization/signals | PREACT-02 explicitly requires virtual DOM rendering. |
| Listener lifecycle bookkeeping | dataset flags + manual rebinding | component-level handlers + `useEffect` cleanup | Avoid rebinding bugs and leaked listeners. |
| New markdown sanitizer | ad-hoc HTML sanitizer rewrite | existing markdown + URL policy utilities | Security-sensitive behavior already exists and is tested. |
| Message protocol translation in many places | ad-hoc switch blocks per component | centralized typed message adapter | Keeps host contract stable and auditable. |

## Common Pitfalls

### Pitfall 1: Performance regression by replacing entire state objects on every tick

- **What goes wrong:** every stream chunk rerenders too much UI.
- **Avoid by:** preserving immutable reference stability and using keyed/memoized component boundaries.

### Pitfall 2: Keyboard/accessibility regressions

- **What goes wrong:** slash menu/panel shortcuts stop matching current behavior.
- **Avoid by:** codify a parity checklist for Enter/Escape/Arrow/Tab flows before deleting old controllers.

### Pitfall 3: Protocol drift

- **What goes wrong:** changed message payload shape breaks host handlers.
- **Avoid by:** compile against current `WebviewMessage`/`ExtensionMessage` unions and keep all send helpers typed.

### Pitfall 4: CSP/security regressions

- **What goes wrong:** inline scripts/styles or unsafe content injection creep in.
- **Avoid by:** keep existing CSP model and sanitize all rendered user/workspace content.

### Pitfall 5: Calling `acquireVsCodeApi` more than once

- **What goes wrong:** webview-to-host messaging becomes unreliable.
- **Avoid by:** create API instance once in entry and pass via context/hook.

### Pitfall 6: File-size regression

- **What goes wrong:** one monolithic `App.tsx` replaces monolithic `main.ts`.
- **Avoid by:** split by feature area early (messages/composer/panels/topbar).

## Code Examples

### Example A: Preact TSX compiler settings

```json
{
  "compilerOptions": {
    "module": "ES2022",
    "target": "ES2022",
    "jsx": "react-jsx",
    "jsxImportSource": "preact",
    "moduleResolution": "bundler"
  }
}
```

### Example B: Webview root render with single VS Code API acquisition

```tsx
import { render } from 'preact';
import { App } from './app/App';

type VsCodeApi = { postMessage(message: unknown): void };
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const root = document.getElementById('app');
if (root) {
  render(<App vscode={vscode} />, root);
}
```

### Example C: Signals hook for hot local state

```tsx
import { useSignal, useComputed } from '@preact/signals';

function PendingTimer() {
  const elapsed = useSignal(0);
  const label = useComputed(() => `Streaming ${elapsed.value}s`);
  return <span>{label}</span>;
}
```

## State of the Art

| Old Approach | Current Approach | Impact |
|---|---|---|
| String templates + `innerHTML`/`outerHTML` patches | JSX component tree + virtual DOM diff | Directly addresses PREACT-01/02. |
| Central event rebinding after each full render | Declarative handlers and effect-managed globals | Fewer lifecycle bugs and cleaner ownership. |
| Manual streaming DOM surgery | State-driven incremental component updates | Easier reasoning, testability, and long-term maintainability. |

## Planning Guidance (Execution Waves)

1. **Wave 0 - Build Plumbing and Bootstrap**
   - Add dependencies (`preact`, `@preact/signals`).
   - Update `tsconfig.webview.json` and webpack TSX handling.
   - Introduce `main.tsx` + minimal `App.tsx` root mount.
   - Keep host/html template unchanged.

2. **Wave 1 - App Shell Components**
   - Port top bar, conversation panel, and overall layout container to JSX.
   - Keep composer/messages temporarily minimal placeholders to prove architecture.

3. **Wave 2 - Composer, Slash/Mention, Context Chips, File Chips**
   - Replace `inputController.ts` and `slashMenuController.ts` with component/hooks implementations.
   - Preserve exact outgoing message payloads (`pickFiles`, `readFiles`, `listWorkspaceFiles`, etc.).

4. **Wave 3 - Messages and Tool Preview Tree**
   - Port `renderers/*.ts` to TSX components.
   - Keep existing diff/command/todo parsing logic, but return JSX.
   - Preserve markdown sanitization policy.

5. **Wave 4 - Approval/Question/Plan Panels**
   - Port panel controllers/renderers/views to component model.
   - Reuse `src/shared/questionPanelState.ts` reducer to avoid behavior drift.

6. **Wave 5 - Streaming/Perf and Legacy Deletion**
   - Remove `streamingViewUpdater.ts`, `renderCoordinator.ts`, `renderDriver.ts`, `eventBinder.ts`.
   - Verify no forbidden manual HTML patch APIs remain.
   - Run parity checklist for all required workflows.

## Verification Checklist for PREACT Requirements

- `PREACT-01`: `media/` rendering path fully TSX/component-based; no string-template render driver remains.
- `PREACT-02`: `rg -n "innerHTML|insertAdjacentHTML|outerHTML" media --glob '*.{ts,tsx}'` returns no rendering-pipeline usage.
- `PREACT-03`: app state managed via hooks/signals (reducer and/or signals present in new app layer).
- `PREACT-04`: manual parity runs for chat, streaming, tool previews, all 3 interactive panels, file change actions, slash menu, plan mode.

## Open Questions

1. **State model final choice:** reducer-only or reducer + signals hybrid for high-frequency UI?
   - Recommendation: start reducer-only; add signals only where profiling indicates measurable benefit.

2. **Markdown HTML rendering strategy in TSX:** preserve current HTML-string markdown renderer (with controlled `dangerouslySetInnerHTML`) or refactor markdown pipeline now?
   - Recommendation: preserve existing sanitizer pipeline in this phase; defer parser rewrite.

3. **CSS strategy:** keep `media/styles.css` vs move to CSS Modules now?
   - Recommendation: keep global CSS in this phase to minimize regression surface.

4. **Traceability mismatch:** `REQUIREMENTS.md` maps `PREACT-*` to "Phase 5" while roadmap defines this as Phase 4.
   - Recommendation: normalize docs before/with planning to avoid reporting confusion.

## Confidence Breakdown

- Standard stack: **HIGH** (official Preact/TypeScript/ts-loader docs plus live package version check).
- Architecture: **HIGH** (direct codebase analysis of current `media/` rendering/event model).
- Pitfalls: **HIGH** (derived from existing imperative hotspots and VS Code webview constraints).

## Sources

### Primary (HIGH confidence)

- Local code and planning docs:
  - `.planning/REQUIREMENTS.md`
  - `.planning/STATE.md`
  - `.planning/ROADMAP.md`
  - `CLAUDE.md`
  - `REFACTOR.md`
  - `media/main.ts`
  - `media/eventBinder.ts`
  - `media/streamingViewUpdater.ts`
  - `media/inputController.ts`
  - `media/slashMenuController.ts`
  - `media/renderers/*.ts`
  - `media/panels/*.ts`
  - `src/protocol/webviewMessages.ts`
  - `src/webview/htmlTemplate.ts`
  - `webpack.config.js`
  - `tsconfig.webview.json`
  - `package.json`

- Official docs:
  - Preact TypeScript guide: https://preactjs.com/guide/v10/typescript/
  - Preact Signals guide: https://preactjs.com/guide/v10/signals/
  - Preact API reference (`render`): https://preactjs.com/guide/v11/api-reference
  - TypeScript `jsxImportSource`: https://www.typescriptlang.org/tsconfig/jsxImportSource.html
  - ts-loader README (configuration/TSX rule): https://raw.githubusercontent.com/TypeStrong/ts-loader/main/README.md
  - VS Code Webview guide (message passing, `acquireVsCodeApi`, CSP, `asWebviewUri`): https://code.visualstudio.com/api/extension-guides/webview

- Context7:
  - `/preactjs/preact-www` (TypeScript JSX setup, hooks, render usage)
  - `/preactjs/signals` (signal/computed/effect hooks and usage patterns)

### Secondary (MEDIUM confidence)

- npm registry live version checks (command output, 2026-03-04):
  - `preact` -> `10.28.4`
  - `@preact/signals` -> `2.8.1`

