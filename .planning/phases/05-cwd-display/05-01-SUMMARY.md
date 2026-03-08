---
phase: 05-cwd-display
plan: 01
status: complete
---

## Summary: Settings Propagation Infrastructure

### What was built

1. **Protocol type** — Added `settingsUpdated` variant to `ExtensionMessage` union in `src/protocol/webviewMessages.ts` with `{ type: 'settingsUpdated'; settings: { showCwdBar: boolean } }` shape.

2. **VS Code setting** — Registered `iflow.showStatusBar` (boolean, default `true`) in `package.json` contributes.configuration.

3. **Host-side propagation** — In `src/webviewHandler.ts`:
   - Config change listener sends `settingsUpdated` message when `iflow.showStatusBar` changes.
   - `postCurrentSettings()` private method centralizes settings message construction.
   - `ready` handler calls `postCurrentSettings()` for initial sync on webview startup.

4. **Webview-side signal** — Added `showCwdBar` signal (default `true`) in `media/store/signals.ts`.

5. **Webview-side action handler** — Added `settingsUpdated` case in `media/store/actions.ts` that updates `showCwdBar.value`.

6. **Message handler context** — Added `postCurrentSettings()` to `WebviewMessageHandlerContext` interface and `ready` handler in `src/webview/messageHandler.ts`.

7. **Tests** — Updated existing ready-routing test to include `postCurrentSettings`. Added new test verifying `ready` message triggers `settingsUpdated` with `showCwdBar: true`.

### Verification

- `npm run compile` — passed
- `npm run test:unit` — 340 passing, 4 pending, 0 failing
- `src/webviewHandler.ts` — 499 lines (under SIZE-03 500-line limit)

### Commits

1. `f9b24ca` — feat(protocol): add settingsUpdated message type and iflow.showStatusBar setting
2. `3ac1299` — feat(settings): wire host-side config propagation and webview-side signal
