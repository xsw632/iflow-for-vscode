import * as path from "path";

export function isReadySignal(output: string): boolean {
  const normalized = output.toLowerCase();
  return normalized.includes('listening')
    || normalized.includes('ready')
    || normalized.includes('started websocket service')
    || normalized.includes('server started')
    || normalized.includes('acp server running')
    || normalized.includes('running at ws://')
    || normalized.includes('running at wss://');
}

export function isAddressInUseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('eaddrinuse')
    || normalized.includes('address already in use')
    || normalized.includes('failed to bind acp port');
}

export function extractManagedPort(output: string): number | null {
  const patterns = [
    /\busing port[:\s]+(\d{2,5})\b/i,
    /\bfound available port\s+(\d{2,5})\b/i,
    /\blistening(?:\s+on)?(?:\s+port)?[:\s]+(\d{2,5})\b/i,
    /\b(?:ws|wss):\/\/[^\s]+:(\d{2,5})(?:\/[^\s]*)?\b/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(output);
    if (!match) {
      continue;
    }
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
      return parsed;
    }
  }
  return null;
}

export function buildStartupFailureMessage(
  code: number | null,
  stdoutBuffer: string[],
  stderrBuffer: string[],
  configuredPort: number,
  nodePath: string,
  timeoutMs: number,
): string {
  const shortNodePath = summarizeNodePath(nodePath);
  const runtimeContext = `port=${configuredPort}, timeoutMs=${timeoutMs}, node=${shortNodePath}`;
  const recoveryAction = "Action: verify iflow.nodePath/config and retry.";
  const combined = `${stdoutBuffer.join("")}\n${stderrBuffer.join("")}`.toLowerCase();

  if (
    combined.includes("eaddrinuse") ||
    combined.includes("address already in use")
  ) {
    return (
      `[STARTUP_ERROR] iFlow process failed to bind ACP port ${configuredPort} because it is already in use. ` +
      `${runtimeContext}. ${recoveryAction}`
    );
  }

  if (code === null) {
    return (
      `[STARTUP_ERROR] iFlow process startup timed out before readiness was confirmed. ` +
      `${runtimeContext}. ${recoveryAction}`
    );
  }

  return (
    `[STARTUP_ERROR] iFlow process exited immediately with code ${code}. ` +
    `${runtimeContext}. ${recoveryAction}`
  );
}

function summarizeNodePath(nodePath: string): string {
  const basename = path.basename(nodePath);
  return basename || nodePath;
}
