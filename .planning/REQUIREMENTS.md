# Requirements: IFlow for VS Code

**Defined:** 2026-03-02
**Core Value:** Users can interact with iFlow AI directly in VS Code with real-time streaming responses and full tool integration

## v0.2.0 Requirements

Requirements for stability, quality, and Preact migration. Each maps to roadmap phases.

### Rendering Performance

- [ ] **PERF-01**: Streaming updates only patch the last message block instead of replacing all blocks
- [ ] **PERF-02**: Message list uses virtualization to render only visible messages
- [ ] **PERF-03**: Event listeners use delegation instead of re-attachment after renders

### Error Context

- [x] **ERR-01**: CLI discovery errors include which paths were tried and which failed
- [x] **ERR-02**: Pipeline validation errors indicate which validation step failed (files, context, model)
- [x] **ERR-03**: Connection errors are tagged by layer (transport, protocol, auth)
- [x] **ERR-04**: Process startup errors include diagnostic context (port, node path, timeout)

### File Size Compliance

- [ ] **SIZE-01**: acpRunExecutor.ts split below 500 lines (extract recovery/inactivity logic)
- [ ] **SIZE-02**: sessionCoordinator.ts split below 500 lines (extract recovery handler)
- [ ] **SIZE-03**: webviewHandler.ts split below 500 lines (extract message/file change handlers)
- [ ] **SIZE-04**: processManager.ts split below 500 lines (extract startup probe)

### Test Coverage

- [ ] **TEST-01**: cliDiscovery.ts coverage raised above 60% (currently 30.26%)
- [ ] **TEST-02**: portDiscovery.ts coverage raised above 60% (currently 31.57%)
- [ ] **TEST-03**: jsonFileStore.ts coverage raised above 60% (currently 39.5%)
- [ ] **TEST-04**: Overall project coverage reaches 80%+ (currently 78.4%)

### Preact Webview Rewrite

- [ ] **PREACT-01**: Webview rewritten using Preact with component model
- [ ] **PREACT-02**: Virtual DOM handles efficient rendering (replaces manual innerHTML)
- [ ] **PREACT-03**: State management via Preact hooks/signals
- [ ] **PREACT-04**: All existing webview functionality preserved (chat, tools, panels, file changes)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Host-side refactoring (src/webview/) | postMessage contract stays the same, host side untouched |
| New user capabilities | Focus is stability and migration first |
| React (full) | Preact chosen for lighter bundle size in webview context |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| PERF-01 | Phase 1 | Pending |
| PERF-02 | Phase 1 | Pending |
| PERF-03 | Phase 1 | Pending |
| ERR-01 | Phase 2 | Complete |
| ERR-02 | Phase 2 | Complete |
| ERR-03 | Phase 2 | Complete |
| ERR-04 | Phase 2 | Complete |
| SIZE-01 | Phase 3 | Pending |
| SIZE-02 | Phase 3 | Pending |
| SIZE-03 | Phase 3 | Pending |
| SIZE-04 | Phase 3 | Pending |
| TEST-01 | Phase 4 | Pending |
| TEST-02 | Phase 4 | Pending |
| TEST-03 | Phase 4 | Pending |
| TEST-04 | Phase 4 | Pending |
| PREACT-01 | Phase 5 | Pending |
| PREACT-02 | Phase 5 | Pending |
| PREACT-03 | Phase 5 | Pending |
| PREACT-04 | Phase 5 | Pending |

**Coverage:**
- v0.2.0 requirements: 19 total
- Mapped to phases: 19
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-02*
*Last updated: 2026-03-02 after adding Preact requirements*
