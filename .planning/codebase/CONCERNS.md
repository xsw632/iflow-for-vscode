# Codebase Concerns

**Analysis Date:** 2026-03-01

## Test Coverage Gaps

**Low Coverage Areas (Below 50%):**
- `src/cliDiscovery.ts` - 30.26% coverage (608 lines)
  - What's not tested: Windows/Unix path discovery fallbacks, cross-platform edge cases
  - Files: `src/cliDiscovery.ts`, `src/nodeDiscovery.ts` (220 lines, 0% tested)
  - Risk: Silent CLI discovery failures in specific environments (Windows npm globals, nvm/fnm paths)
  - Priority: High - affects critical startup path

- `src/acp/debugLogger.ts` - 29.93% coverage (147 lines)
  - What's not tested: Debug log truncation logic, notification envelope serialization
  - Files: `src/acp/debugLogger.ts`
  - Risk: Debug output corruption for large payloads without visibility
  - Priority: Medium - diagnostic code path

- `src/process/portDiscovery.ts` - 31.57% coverage (76 lines)
  - What's not tested: Port allocation retry logic, availability check edge cases
  - Files: `src/process/portDiscovery.ts`
  - Risk: Port conflicts not properly handled, process startup failures
  - Priority: High - process lifecycle dependency

- `src/webview/cliStatusService.ts` - 38.66% coverage (75 lines)
  - What's not tested: Cache TTL logic, concurrent check deduplication
  - Files: `src/webview/cliStatusService.ts`
  - Risk: Stale CLI status reported to UI, redundant checks during rapid queries
  - Priority: Medium

- `src/shared/jsonFileStore.ts` - 39.5% coverage (81 lines)
  - What's not tested: File I/O error handling, concurrent access, mtime cache invalidation
  - Files: `src/shared/jsonFileStore.ts`
  - Risk: Settings persistence failures silently swallowed, stale settings used
  - Priority: High - critical infrastructure for settings persistence

- `src/acp/settingsRepository.ts` - 51.72% coverage (58 lines)
  - What's not tested: Model/API config update logic, read/write synchronization
  - Files: `src/acp/settingsRepository.ts`
  - Risk: Settings updates lost or mixed, wrong config applied at runtime
  - Priority: Medium

- `src/shared/logger.ts` - 65.04% coverage (123 lines)
  - What's not tested: Output channel lifecycle, log formatting, debug flag edge cases
  - Files: `src/shared/logger.ts`
  - Risk: Logs missing or malformed, making debugging harder
  - Priority: Low - diagnostic path

- `src/shared/typeGuards.ts` - 36.84% coverage (19 lines)
  - What's not tested: Type guard branches, edge cases in isObject
  - Files: `src/shared/typeGuards.ts`
  - Risk: Type safety assumptions violated, crashes in undefined code paths
  - Priority: Medium

**Overall Coverage:** 78.4% (7,711/9,835 lines)
- Target: 80%+ is mandatory per coding rules
- Current status: Just below target
- Gap: ~150-200 lines need coverage


## File Size Concerns (Exceeds Convention Limits)

**Files Over 500 Lines (Limit: 500 max):**

- `src/acp/client/acpRunExecutor.ts` - 562 lines
  - Combines: Run/cancel/recovery logic, inactivity monitoring, prompt execution, error recovery
  - Impact: Complex lifecycle state machine, hard to understand control flow
  - Fix approach: Extract recovery/inactivity logic to separate classes; split into acpRunExecutor.ts (~400) + acpRunRecovery.ts (~150) + acpInactivityManager.ts
  - Priority: High

- `src/acp/sessionCoordinator.ts` - 532 lines
  - Combines: Connection lifecycle, protocol/transport management, state snapshots, recovery
  - Impact: Hard to trace which code handles which connection state
  - Fix approach: Extract into sessionCoordinator.ts (~350) + sessionRecoveryHandler.ts (~150) + connectionStateManager.ts
  - Priority: High

- `src/webviewHandler.ts` - 509 lines
  - Combines: Message routing, file change review, plan mode orchestration, CLI status, IDE context sync
  - Impact: Too many responsibilities, hard to test individual features
  - Fix approach: Extract into handlers: webviewHandler.ts (~300) + messageHandler.ts + fileChangeHandler.ts + planHandler.ts
  - Priority: High

- `src/processManager.ts` - 504 lines
  - Combines: Spawn management, port discovery, WebSocket readiness, startup signal parsing, caching
  - Impact: Complex lifecycle state, hard to test spawn vs WebSocket vs recovery paths independently
  - Fix approach: Extract: processManager.ts (~350) + processStartupProbe.ts (~150)
  - Priority: High

- `src/shared/questionPanelState.ts` - 494 lines
  - Combines: State machine, navigation logic, validation, selection management
  - Impact: Many interdependent state transitions, hard to isolate bugs
  - Fix approach: Extract: questionPanelState.ts (~350) + questionPanelValidator.ts + questionPanelNavigator.ts
  - Priority: Medium

- `src/store/conversationService.ts` - 467 lines
  - Combines: Message appending, chunk reduction, context estimation, usage tracking
  - Impact: Multiple responsibilities make mutations harder to reason about
  - Fix approach: Extract context/usage logic; split into conversationService.ts (~350) + conversationUsageService.ts
  - Priority: Medium

- `src/webview/sendMessagePipeline.ts` - 432 lines
  - Combines: Validation, file scanning, authorization, message building, sending
  - Impact: Long validation chain hard to follow, failures at any stage
  - Fix approach: Keep as-is but add per-stage error context
  - Priority: Low - already tested (91.89% coverage)

- `src/cliDiscovery.ts` - 407 lines
  - Combines: Cross-platform discovery, fallback chains, cache management
  - Impact: Many nested conditions for different OSes/fallbacks
  - Fix approach: Extract: findIFlowPath.ts + findNodePath.ts + cliCache.ts
  - Priority: Medium


## Fragile Areas

**Complex State Machines with Low Branch Coverage:**

- `src/acp/client/acpRunExecutor.ts`:
  - Files: `src/acp/client/acpRunExecutor.ts`, `src/acp/inactivityGuard.ts`
  - Why fragile: Inactivity guard timeout race conditions, cancel recovery flow, session recovery deadlocks
  - Safe modification: Add tests for all timeout/recovery paths before refactoring; use state diagram tests
  - Test coverage: 83.45% lines, but only 70.58% branches - gaps in recovery paths
  - Known fragile patterns: Promise.race() with timeouts, state flags (`settled`, `needsRecovery`)

- `src/store/chunkReducer.ts`:
  - Files: `src/store/chunkReducer.ts`
  - Why fragile: Complex block finding logic, array mutations in reducer, index tracking
  - Safe modification: All changes must pass immutability test (no in-place mutations)
  - Test coverage: 78.92% lines, 67.74% branches - missing edge cases
  - Known fragile patterns: `blocks[idx] = { ...current, ... }` mutations must stay immutable

- `src/shared/questionPanelState.ts`:
  - Files: `src/shared/questionPanelState.ts`
  - Why fragile: State synchronization between Host and Webview, navigation index clamping
  - Safe modification: Test bidirectional state sync; verify navigation boundaries
  - Test coverage: 81.98% lines, 63.21% branches - navigation paths undertested
  - Known fragile patterns: `normalizeNavIndex`, `clampOptionIndex` - off-by-one risks

- `src/webview/fileChange/types.ts`:
  - Files: `src/webview/fileChange/types.ts`
  - Why fragile: File snapshot comparison, rewind buffer state, diff coordinate translation
  - Safe modification: Test with large files, many changes, rewind at different stages
  - Test coverage: 82.66% lines, 68% branches
  - Known fragile patterns: `Snapshot` type definition, reverse indexing for rewind

**Interaction Bridge Complexity:**

- `src/acp/interactionBridge.ts` - 383 lines:
  - What makes it fragile: PendingPromise registry, Webview/Host callback coordination, timeout cleanup
  - Safe modification: Test all promise states (pending/resolved/rejected/timed-out); verify no memory leaks
  - Test coverage: 86.68% lines, 69.44% branches - timeout paths undertested
  - Risk: Stuck pending promises if callbacks never fire
  - Add tests: Promise cleanup on session end, timeout edge cases


## Missing Error Context

**Areas with Error Handling But Missing Context:**

- `src/processManager.ts` (504 lines):
  - Issue: Process spawn errors lack context about which fallback path failed
  - Files: `src/processManager.ts`
  - Workaround: Check extension debug logs
  - Fix approach: Add structured error context (which port was tried, which node path, which timeout)
  - Impact: When startup fails, hard to diagnose which step (port discovery vs spawn vs WebSocket readiness)

- `src/webview/sendMessagePipeline.ts` (432 lines):
  - Issue: Validation failures in the pipeline don't indicate which validation step failed
  - Files: `src/webview/sendMessagePipeline.ts`
  - Fix approach: Wrap each validation stage with specific error codes (INVALID_FILES, INVALID_CONTEXT, INVALID_MODEL)
  - Impact: Users see "Validation failed" without knowing what to fix

- `src/cliDiscovery.ts` (407 lines):
  - Issue: All fallback paths on Windows resolve to the same generic error
  - Files: `src/cliDiscovery.ts`
  - Fix approach: Include which paths were tried in error message
  - Impact: Users don't know if CLI is missing entirely or just not in PATH

- `src/acp/sessionCoordinator.ts` (532 lines):
  - Issue: Connection failures don't indicate whether issue was transport vs protocol vs auth
  - Files: `src/acp/sessionCoordinator.ts`
  - Fix approach: Tag errors with layer (TRANSPORT_ERROR, PROTOCOL_ERROR, AUTH_ERROR)
  - Impact: Distinguishing temporary network blips from auth issues is hard


## Performance Concerns

**CLI Path Discovery:**
- Files: `src/cliDiscovery.ts`
- Problem: Spawns shell processes synchronously during discovery (`cp.exec` on Unix fallback)
- Current: Can block extension for 5+ seconds on slow systems
- Workaround: None - extension blocks during discovery
- Improvement path: Pre-cache paths on first run; make discovery async-only

**File Snapshot Overhead:**
- Files: `src/webview/fileChange/snapshotManager.ts`
- Problem: Captures entire file content on each tool result; no incremental snapshots
- Current: Large files (>10MB) cause memory/JSON serialization overhead
- Workaround: Limit workspace file search results
- Improvement path: Implement sparse snapshots (hash-based, size limits per file)

**Question Panel State Serialization:**
- Files: `src/shared/questionPanelState.ts` (494 lines)
- Problem: Full state object passed Webview↔Host on every change
- Current: Large question panels (50+ questions) cause visible lag
- Improvement path: Transmit only delta changes, compress selections array

**CLI Status Cache TTL:**
- Files: `src/webview/cliStatusService.ts`
- Problem: Cache hits are 2min, failures are 15sec - asymmetric, no exponential backoff
- Current: Failed checks retry quickly (15sec), might spam if CLI is intermittently down
- Improvement path: Implement exponential backoff with jitter for failures


## Scaling Limits

**Process Manager Port Discovery:**
- Files: `src/processManager.ts`
- Current capacity: 1 process managed at a time
- Limit: No multiple concurrent iFlow processes; port is single-allocated
- Scaling path: Would need process pool + per-process port allocation (future multi-session support)

**WebSocket Connection Pool:**
- Files: `src/acpTransport.ts`
- Current: Single WebSocket per session
- Limit: Cannot multiplex concurrent requests; blocks on request responses
- Scaling path: Use Request ID queue for concurrent RPC calls

**Settings Persistence:**
- Files: `src/acp/settingsRepository.ts`
- Current: Synchronous JSON file reads/writes to `~/.iflow/settings.json`
- Limit: No conflict resolution if multiple processes write simultaneously
- Scaling path: File locking or atomic writes needed for multi-process safety


## Security Considerations

**Path Access Control:**
- Risk: CLI discovery walks arbitrary filesystem paths
- Files: `src/cliDiscovery.ts`, `src/nodeDiscovery.ts`, `src/acp/pathPolicy.ts`
- Current mitigation: `pathPolicy.ts` restricts file edits, but not file reads
- Recommendations:
  - Add audit log for all discovered paths
  - Validate discovered CLI integrity (signature check for production)
  - Warn user before accepting CLI from unexpected locations

**Credentials in Debug Logs:**
- Risk: Debug logs may capture API keys from error objects
- Files: `src/acp/debugLogger.ts`
- Current mitigation: Truncates large payloads, but doesn't filter sensitive fields
- Recommendations:
  - Redact patterns: `apiKey`, `token`, `secret` from logged objects
  - Add denylist for fields that should never be logged

**Settings File Permissions:**
- Risk: `~/.iflow/settings.json` created with default umask (may be world-readable on Unix)
- Files: `src/acp/settingsRepository.ts`, `src/shared/jsonFileStore.ts`
- Current mitigation: None
- Recommendations:
  - Create settings file with mode 0600 (user read/write only)
  - Check and warn if existing file has loose permissions

**Process Manager Env Vars:**
- Risk: Environment passed to spawned iFlow CLI could leak VS Code secrets
- Files: `src/processManager.ts`
- Current mitigation: Uses `process.env` as-is (inherits from VS Code)
- Recommendations:
  - Build explicit env var whitelist (PATH, HOME, NODE_OPTIONS, etc.)
  - Filter out VS Code internal vars (VSCODE_*, etc.)

**WebSocket Connection:**
- Risk: iFlow CLI WebSocket listened on localhost, but no auth required after port-hop
- Files: `src/acpTransport.ts`
- Current mitigation: Port allocation keeps URL opaque from users
- Recommendations:
  - Add simple token-based auth if port becomes predictable
  - Document port ephemeralness


## Mutation Concerns

All reviewed files follow immutability conventions, but verify during:
- Array mutations in `src/store/chunkReducer.ts` (using spread operator correctly)
- Object updates in state files (creating new instances)
- Setting persistence in `src/acp/settingsRepository.ts` (uses spread in write)

**No critical mutation bugs found**, but monitor:
- `src/thinkingParser.ts`: Uses `this.buffer` state - verify no external mutations
- Process buffers in `src/processManager.ts`: `stdoutBuffer`, `stderrBuffer` - local only, safe


## Dependencies at Risk

**No direct SDK dependency risk** - project correctly avoids `@iflow-ai/iflow-cli-sdk` and implements ACP directly.

**Runtime Dependencies to Monitor:**
- `ws` (WebSocket library) - pinned in package.json, monitor for security updates
- `vscode` (API) - bound to VS Code version, check on major version releases


## Known Limitations

**Single Conversation/Session Model:**
- Files: `src/store/conversationService.ts`, `src/acp/sessionCoordinator.ts`
- Problem: Architecture assumes one conversation per session
- Blocks: Cannot implement conversation search/history browsing efficiently
- Workaround: Load all conversations into memory (works up to ~100 conversations)

**No Incremental File Diffs:**
- Files: `src/webview/fileChange/diffService.ts`
- Problem: Every file change request returns full diff, no delta encoding
- Blocks: Showing edit history for large files
- Workaround: Use external diff tools

**Blocking CLI Discovery:**
- Files: `src/cliDiscovery.ts`, `src/processManager.ts`
- Problem: Initialization waits for CLI path discovery to complete
- Blocks: Cannot pre-activate extension while discovering CLI
- Workaround: None - users experience lag on first activation


## Test Doubles Needed

Add tests for untested code paths before refactoring large files:

**For `src/cliDiscovery.ts` (30.26% coverage):**
- Mock `cp.exec` to test Windows path discovery fallbacks
- Mock `fs.existsSync` for APPDATA fallback testing
- Test Unix login shell fallback behavior

**For `src/processManager.ts` (67.85% coverage):**
- Mock WebSocket to test readiness probe timeout
- Mock spawn to test startup signal parsing edge cases
- Test port allocation retry exhaustion

**For `src/webview/cliStatusService.ts` (38.66% coverage):**
- Test cache TTL expiration
- Test concurrent check deduplication (in-flight promise reuse)

**For `src/shared/jsonFileStore.ts` (39.5% coverage):**
- Mock fs for I/O errors
- Test concurrent access (one read, one write)
- Test mtime cache invalidation

---

*Concerns audit: 2026-03-01*
