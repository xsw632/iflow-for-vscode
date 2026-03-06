---
status: awaiting_human_verify
trigger: "[$gsd-debug](/home/mingzhenjia/.codex/skills/gsd-debug/SKILL.md)[IFlow][WebviewHandler] Send pipeline start: silent=false, contentLength=9, attachedFiles=0, hasIdeContext=false\nextensionHostProcess.js:219\n[IFlow][WebviewHandler] Prepared run context: mode=default, model=GLM-4.7, cwd=/home/mingzhenjia/Extension-for-vscode/test, workspaceFiles=0, autoIncludeWorkspaceFiles=false, workspaceFilesLimit=80, allowedDirs=1\nextensionHostProcess.js:219\n[IFlow][WebviewHandler] Run failed: [TRANSPORT_ERROR] connect ECONNREFUSED 127.0.0.1:8090\nextensionHostProcess.js:219\n[IFlow][WebviewHandler] [perf] ttft=n/a preflight=143ms total=2756ms workspaceScan=n/a这是什么问题，难道我没有设置8090端口不行改用其他端口吗"
created: 2026-03-06T00:00:00Z
updated: 2026-03-06T06:18:00Z
---

## Current Focus

hypothesis: The startup path now waits for real ACP readiness by recognizing the current CLI banner and by continuing readiness probes instead of resolving early.
test: Ask the user to retry the original VS Code send flow and confirm that the run no longer fails with `[TRANSPORT_ERROR] connect ECONNREFUSED 127.0.0.1:8090`.
expecting: The extension should either connect successfully once ACP is ready or produce a different, more accurate startup/auth error if another issue remains.
next_action: User reruns the original workflow inside VS Code and reports whether the transport error is gone.

## Symptoms

expected: After clicking send in the webview, the extension should connect to the local iFlow ACP server and stream a response.
actual: The run fails before any response is streamed. Debug logs show `Run failed: [TRANSPORT_ERROR] connect ECONNREFUSED 127.0.0.1:8090`.
errors: `[IFlow][WebviewHandler] Send pipeline start: silent=false, contentLength=9, attachedFiles=0, hasIdeContext=false`; `[IFlow][WebviewHandler] Prepared run context: mode=default, model=GLM-4.7, cwd=/home/mingzhenjia/Extension-for-vscode/test, workspaceFiles=0, autoIncludeWorkspaceFiles=false, workspaceFilesLimit=80, allowedDirs=1`; `[IFlow][WebviewHandler] Run failed: [TRANSPORT_ERROR] connect ECONNREFUSED 127.0.0.1:8090`; `[IFlow][WebviewHandler] [perf] ttft=n/a preflight=143ms total=2756ms workspaceScan=n/a`
reproduction: Open the extension webview, send a prompt, observe failure in extension host debug console.
started: Happening currently; prior working status unknown.

## Eliminated

## Evidence

- timestamp: 2026-03-06T06:00:00Z
  checked: CLI availability and default port configuration
  found: `iflow` exists at `/home/mingzhenjia/.nvm/versions/node/v24.14.0/bin/iflow`, `iflow --version` returns `0.5.15`, and the extension default config is `iflow.port = 8090`.
  implication: The failure is not caused by a missing CLI binary, and `8090` is only a default setting, not a hard requirement.

- timestamp: 2026-03-06T06:01:00Z
  checked: Manual ACP startup outside the extension
  found: `iflow --experimental-acp --port 8090 --stream` successfully prints `🚀 iFlow ACP Server running at ws://127.0.0.1:8090/acp`.
  implication: The CLI can start ACP correctly on 8090 in this environment, so the root issue is in startup/readiness orchestration rather than the port itself.

- timestamp: 2026-03-06T06:04:00Z
  checked: Timed reproduction of the extension's readiness probe window versus actual CLI startup
  found: Probe-style WebSocket attempts at 500ms + 8 retries all fail by about 2271ms, while the CLI only prints `iFlow ACP Server running at ws://127.0.0.1:19092/acp` at about 2482ms.
  implication: The startup probe gives up before ACP is actually ready and the subsequent transport connect races into `ECONNREFUSED`.

- timestamp: 2026-03-06T06:17:00Z
  checked: Targeted startup readiness regression tests
  found: `npx mocha --ui tdd --require ./test/unit/vscode-shim.js out/test/processManager.test.js out/test/websocket.test.js` passes with `20 passing`, including coverage for the current ACP banner and for readiness continuing across multiple probe windows.
  implication: The fix is covered both for the exact CLI banner seen in manual reproduction and for the late-start timing window that previously produced `ECONNREFUSED`.

## Resolution

root_cause: `src/process/startupSignals.ts` does not recognize the current iFlow CLI ready banner (`iFlow ACP Server running at ws://127.0.0.1:<port>/acp`), so `src/process/processStartupProbe.ts` falls back after a too-short WebSocket readiness window and `src/acp/sessionCoordinator.ts` immediately attempts a transport connection before ACP is listening.
fix: Update ready-signal detection to recognize the current CLI ACP ready banner and add regression coverage for the new output.
verification:
verification: Manual CLI reproduction showed ACP becomes ready around 2482ms while the previous probe window ended around 2271ms. After the fix, targeted unit coverage passes (`20 passing`) for current ACP ready-banner detection, port extraction, and readiness checks that continue across multiple probe windows.
files_changed:
  - src/process/processStartupProbe.ts
  - src/process/startupSignals.ts
  - src/test/processManager.test.ts
  - src/test/websocket.test.ts
