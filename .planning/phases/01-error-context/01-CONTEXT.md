# Phase 1: Error Context - Context

**Gathered:** 2026-03-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Add structured diagnostic context to existing error paths in CLI discovery, pipeline validation, ACP connection/auth flow, and process startup so failures are diagnosable without guesswork. This phase clarifies error communication and diagnostic framing, not new features.

</domain>

<decisions>
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

</decisions>

<specifics>
## Specific Ideas

- Error messages should remain actionable for end users while preserving machine-friendly identifiers for debugging and support.
- Diagnostics should favor consistency across platforms over raw OS-specific phrasing.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/errorUtils.ts` (`toAppError`, `normalizeErrorMessage`): existing normalization and classification helpers to align new context behavior.
- `src/process/startupSignals.ts` (`buildStartupFailureMessage`, readiness/startup signal parsing): existing startup diagnostics surface that can carry structured context.
- `src/cliDiscovery.ts`: existing cross-platform candidate collection and discovery logging that can emit normalized reason summaries.

### Established Patterns
- Error handling already funnels through typed app errors and normalized messages, with debug logging used for richer detail.
- `sendMessagePipeline` currently emits concise `streamError` user messages and can preserve concise-chat + verbose-debug split.
- Session lifecycle in `sessionCoordinator` already has explicit auth/connect stages that map naturally to layer tags.

### Integration Points
- `src/cliDiscovery.ts` for discovery attempt aggregation and reason normalization.
- `src/webview/sendMessagePipeline.ts` for stage-coded validation messaging and user-facing error formatting.
- `src/acp/sessionCoordinator.ts` for connection/auth layer tagging.
- `src/processManager.ts` for startup context fields (port/node/timeout) and fallback classification.

</code_context>

<deferred>
## Deferred Ideas

None - discussion stayed within phase scope.

</deferred>

---

*Phase: 01-error-context*
*Context gathered: 2026-03-02*
