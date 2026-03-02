import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { normalizeErrorMessage } from "./errorUtils";
import { unique } from "./shared/arrayUtils";

type Logger = (message: string) => void;

export type DiscoveryReasonCode =
  | "NOT_FOUND"
  | "NOT_EXECUTABLE"
  | "PERMISSION_DENIED"
  | "COMMAND_FAILED"
  | "UNKNOWN";

export type DiscoverySourceCategory =
  | "PATH_LOOKUP"
  | "KNOWN_LOCATIONS"
  | "VERSION_MANAGER_SCAN";

export interface DiscoveryAttemptDiagnostic {
  source: DiscoverySourceCategory;
  target: string;
  reasonCode: DiscoveryReasonCode;
  detail?: string;
}

export interface DiscoveryFailureSummary {
  attemptCount: number;
  primaryReason: DiscoveryReasonCode;
  recoveryAction: string;
  userMessage: string;
}

export interface IFlowDiscoveryResult {
  path: string | null;
  diagnostics: DiscoveryAttemptDiagnostic[];
  summary: DiscoveryFailureSummary | null;
}

export function pushIfDefined(
  candidates: string[],
  value: string | undefined,
): void {
  if (value) {
    candidates.push(value);
  }
}

// ── Cross-platform iFlow CLI discovery ────────────────────────────

/**
 * Find iFlow CLI path across platforms.
 * Unix: tries `which iflow`, then falls back to a login shell to pick up nvm/fnm.
 * Windows: tries `where iflow`, then checks common npm global paths.
 */
export async function findIFlowPathCrossPlatform(
  log: Logger,
): Promise<string | null> {
  const result = await findIFlowPathWithDiagnostics(log);
  if (!result.path && result.summary) {
    log(`[CLI discovery summary] ${result.summary.userMessage}`);
    logDiscoveryDiagnostics(log, result.diagnostics);
  }
  return result.path;
}

export async function findIFlowPathWithDiagnostics(
  log: Logger,
): Promise<IFlowDiscoveryResult> {
  if (process.platform === "win32") {
    return findIFlowPathWindows(log);
  }
  return findIFlowPathUnix(log);
}

function findIFlowPathWindows(log: Logger): Promise<IFlowDiscoveryResult> {
  const diagnostics: DiscoveryAttemptDiagnostic[] = [];
  return new Promise((resolve) => {
    cp.exec(
      "where iflow 2>NUL & where iflow.ps1 2>NUL & where iflow.cmd 2>NUL",
      { timeout: 5000 },
      (error, stdout) => {
        const lines = (stdout || "")
          .trim()
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        if (lines.length > 0) {
          // Prefer .ps1 > .cmd > others (PowerShell wrappers are most reliable on modern Windows)
          const ps1 = lines.find((l) => l.toLowerCase().endsWith(".ps1"));
          const cmd = lines.find((l) => l.toLowerCase().endsWith(".cmd"));
          const picked = ps1 || cmd || lines[0];
          log(
            `[Windows discovery] 'where' returned ${lines.length} result(s): ${lines.join(", ")}`,
          );
          log(`[Windows discovery] picked: ${picked}`);
          resolve({ path: picked, diagnostics, summary: null });
          return;
        }
        pushDiscoveryDiagnostic(
          diagnostics,
          "where iflow",
          error,
          "PATH_LOOKUP",
        );
        // Fallback: check common Windows npm global location
        const appData = process.env.APPDATA;
        if (appData) {
          for (const ext of [".ps1", ".cmd", ""]) {
            const candidate = path.join(appData, "npm", `iflow${ext}`);
            if (isExecutableCandidate(candidate)) {
              log(`[Windows discovery] fallback found: ${candidate}`);
              resolve({ path: candidate, diagnostics, summary: null });
              return;
            }
            pushDiscoveryDiagnostic(diagnostics, candidate, "NOT_FOUND");
          }
        }
        for (const candidate of collectWindowsIFlowCandidates()) {
          if (isExecutableCandidate(candidate)) {
            log(`[Windows discovery] fallback found: ${candidate}`);
            resolve({ path: candidate, diagnostics, summary: null });
            return;
          }
          pushDiscoveryDiagnostic(diagnostics, candidate, "NOT_FOUND");
        }
        log(
          '[Windows discovery] iflow CLI not found via "where" or APPDATA fallback',
        );
        resolve({
          path: null,
          diagnostics,
          summary: buildDiscoveryFailureSummary(diagnostics, process.platform),
        });
      },
    );
  });
}

function collectWindowsIFlowCandidates(): string[] {
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  const nvmSymlink = process.env.NVM_SYMLINK;
  const userProfile = process.env.USERPROFILE;
  const programFiles = process.env.ProgramFiles;

  const candidates: string[] = [];

  for (const ext of [".ps1", ".cmd", ""]) {
    pushIfDefined(
      candidates,
      appData ? path.join(appData, "npm", `iflow${ext}`) : undefined,
    );
    pushIfDefined(
      candidates,
      userProfile
        ? path.join(userProfile, "AppData", "Roaming", "npm", `iflow${ext}`)
        : undefined,
    );
    pushIfDefined(
      candidates,
      localAppData
        ? path.join(localAppData, "Volta", "bin", `iflow${ext}`)
        : undefined,
    );
    pushIfDefined(
      candidates,
      nvmSymlink ? path.join(nvmSymlink, `iflow${ext}`) : undefined,
    );
    pushIfDefined(
      candidates,
      programFiles
        ? path.join(programFiles, "nodejs", `iflow${ext}`)
        : undefined,
    );
  }

  return unique(candidates);
}

function findIFlowPathUnix(log: Logger): Promise<IFlowDiscoveryResult> {
  const diagnostics: DiscoveryAttemptDiagnostic[] = [];
  return new Promise((resolve) => {
    // First try: direct 'which' with inherited PATH (works when launched from terminal)
    cp.exec("which iflow", { timeout: 5000 }, (error, stdout) => {
      if (!error && stdout.trim()) {
        resolve({ path: stdout.trim(), diagnostics, summary: null });
        return;
      }
      pushDiscoveryDiagnostic(diagnostics, "which iflow", error, "PATH_LOOKUP");
      // Second try: login shell to pick up nvm/fnm/volta initialization
      const shell = process.env.SHELL || "/bin/bash";
      cp.execFile(
        shell,
        ["-lc", "command -v iflow"],
        { timeout: 10000 },
        (err2, stdout2) => {
          if (!err2 && stdout2.trim()) {
            resolve({ path: stdout2.trim(), diagnostics, summary: null });
          } else {
            pushDiscoveryDiagnostic(
              diagnostics,
              `${shell} -lc command -v iflow`,
              err2,
              "PATH_LOOKUP",
            );
            const fallback = findIFlowPathUnixFromKnownLocations(diagnostics);
            if (fallback) {
              log(
                `[Unix discovery] fallback found at known location: ${fallback}`,
              );
              resolve({ path: fallback, diagnostics, summary: null });
              return;
            }
            resolve({
              path: null,
              diagnostics,
              summary: buildDiscoveryFailureSummary(
                diagnostics,
                process.platform,
              ),
            });
          }
        },
      );
    });
  });
}

function findIFlowPathUnixFromKnownLocations(
  diagnostics: DiscoveryAttemptDiagnostic[],
): string | null {
  for (const candidate of collectUnixIFlowCandidates()) {
    if (isExecutableCandidate(candidate)) {
      return candidate;
    }
    pushDiscoveryDiagnostic(diagnostics, candidate, "NOT_FOUND");
  }
  return null;
}

function collectUnixIFlowCandidates(): string[] {
  const home = process.env.HOME || os.homedir();
  const nvmBin = process.env.NVM_BIN;
  const pnpmHome = process.env.PNPM_HOME;
  const voltaHome = process.env.VOLTA_HOME;
  const npmPrefix = process.env.npm_config_prefix;

  const candidates: string[] = [];

  pushIfDefined(candidates, nvmBin ? path.join(nvmBin, "iflow") : undefined);
  pushIfDefined(
    candidates,
    pnpmHome ? path.join(pnpmHome, "iflow") : undefined,
  );
  pushIfDefined(
    candidates,
    voltaHome ? path.join(voltaHome, "bin", "iflow") : undefined,
  );
  pushIfDefined(
    candidates,
    npmPrefix ? path.join(npmPrefix, "bin", "iflow") : undefined,
  );

  for (const known of [
    "/usr/local/bin/iflow",
    "/opt/homebrew/bin/iflow",
    "/usr/bin/iflow",
    "/bin/iflow",
    path.join(home, ".local", "bin", "iflow"),
    path.join(home, ".npm-global", "bin", "iflow"),
    path.join(home, ".volta", "bin", "iflow"),
    path.join(home, ".yarn", "bin", "iflow"),
    path.join(
      home,
      ".config",
      "yarn",
      "global",
      "node_modules",
      ".bin",
      "iflow",
    ),
    path.join(home, ".local", "share", "pnpm", "iflow"),
    path.join(home, "Library", "pnpm", "iflow"),
  ]) {
    candidates.push(known);
  }

  candidates.push(...collectFromVersionManagerDirs(home, "iflow"));

  return unique(candidates);
}

export interface VersionManagerDir {
  baseDir: string;
  nestedBinSegments: string[];
}

export function getVersionManagerDirs(home: string): VersionManagerDir[] {
  return [
    {
      baseDir: path.join(home, ".nvm", "versions", "node"),
      nestedBinSegments: ["bin"],
    },
    {
      baseDir: path.join(home, ".fnm", "node-versions"),
      nestedBinSegments: ["installation", "bin"],
    },
    {
      baseDir: path.join(home, ".asdf", "installs", "nodejs"),
      nestedBinSegments: ["bin"],
    },
    {
      baseDir: path.join(home, ".local", "share", "mise", "installs", "node"),
      nestedBinSegments: ["bin"],
    },
  ];
}

function logDiscoveryDiagnostics(
  log: Logger,
  diagnostics: DiscoveryAttemptDiagnostic[],
): void {
  const grouped = new Map<DiscoverySourceCategory, DiscoveryAttemptDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    const entries = grouped.get(diagnostic.source) ?? [];
    entries.push(diagnostic);
    grouped.set(diagnostic.source, entries);
  }

  for (const [source, entries] of grouped.entries()) {
    log(`[CLI discovery][${source}] attempts=${entries.length}`);
    for (const entry of entries) {
      const suffix = entry.detail ? ` (${entry.detail})` : "";
      log(
        `[CLI discovery][${source}] ${entry.reasonCode} ${entry.target}${suffix}`,
      );
    }
  }
}

function isExecutableCandidate(candidate: string): boolean {
  try {
    if (!fs.existsSync(candidate)) {
      return false;
    }
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform === "win32") {
      return true;
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function normalizeDiscoveryFailureReason(
  error: unknown,
): DiscoveryReasonCode {
  const normalized = normalizeErrorMessage(error).toLowerCase();
  if (normalized.includes("eacces") || normalized.includes("eperm")) {
    return "PERMISSION_DENIED";
  }
  if (normalized.includes("enoent") || normalized.includes("not found")) {
    return "NOT_FOUND";
  }
  if (normalized.includes("not executable") || normalized.includes("x_ok")) {
    return "NOT_EXECUTABLE";
  }
  if (
    normalized.includes("spawn") ||
    normalized.includes("failed") ||
    normalized.includes("command")
  ) {
    return "COMMAND_FAILED";
  }
  return "UNKNOWN";
}

export function categorizeDiscoverySource(
  target: string,
): DiscoverySourceCategory {
  const normalized = target.toLowerCase();
  if (
    normalized.startsWith("which ") ||
    normalized.startsWith("where ") ||
    normalized.includes("command -v iflow")
  ) {
    return "PATH_LOOKUP";
  }
  if (
    normalized.includes(`${path.sep}.nvm${path.sep}`) ||
    normalized.includes(`${path.sep}.fnm${path.sep}`) ||
    normalized.includes(`${path.sep}.asdf${path.sep}`) ||
    normalized.includes(`${path.sep}.volta${path.sep}`) ||
    normalized.includes(`${path.sep}volta${path.sep}`) ||
    normalized.includes(`${path.sep}mise${path.sep}`) ||
    normalized.includes("nvm_symlink")
  ) {
    return "VERSION_MANAGER_SCAN";
  }
  return "KNOWN_LOCATIONS";
}

function pushDiscoveryDiagnostic(
  diagnostics: DiscoveryAttemptDiagnostic[],
  target: string,
  reason: DiscoveryReasonCode | unknown,
  source?: DiscoverySourceCategory,
): void {
  let reasonCode: DiscoveryReasonCode;
  let detail: string | undefined;
  if (typeof reason === "string" && reason.includes("_")) {
    reasonCode = reason as DiscoveryReasonCode;
  } else {
    reasonCode = normalizeDiscoveryFailureReason(reason);
    const normalized = normalizeErrorMessage(reason);
    if (normalized && normalized.toLowerCase() !== "unknown error") {
      detail = normalized;
    }
  }
  diagnostics.push({
    source: source ?? categorizeDiscoverySource(target),
    target,
    reasonCode,
    detail,
  });
}

function derivePrimaryReason(
  diagnostics: DiscoveryAttemptDiagnostic[],
): DiscoveryReasonCode {
  const counts = new Map<DiscoveryReasonCode, number>();
  for (const diagnostic of diagnostics) {
    counts.set(
      diagnostic.reasonCode,
      (counts.get(diagnostic.reasonCode) ?? 0) + 1,
    );
  }
  const order: DiscoveryReasonCode[] = [
    "NOT_FOUND",
    "NOT_EXECUTABLE",
    "PERMISSION_DENIED",
    "COMMAND_FAILED",
    "UNKNOWN",
  ];
  let picked: DiscoveryReasonCode = "UNKNOWN";
  let max = -1;
  for (const code of order) {
    const count = counts.get(code) ?? 0;
    if (count > max) {
      picked = code;
      max = count;
    }
  }
  return picked;
}

function getDiscoveryRecoveryAction(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return "Ensure iflow is installed and available in PATH (npm global bin), then retry.";
  }
  return "Ensure iflow is installed and available in PATH, then retry.";
}

export function buildDiscoveryFailureSummary(
  diagnostics: DiscoveryAttemptDiagnostic[],
  platform: NodeJS.Platform = process.platform,
): DiscoveryFailureSummary {
  const attemptCount = diagnostics.length;
  const primaryReason = derivePrimaryReason(diagnostics);
  const recoveryAction = getDiscoveryRecoveryAction(platform);
  return {
    attemptCount,
    primaryReason,
    recoveryAction,
    userMessage:
      `iFlow CLI discovery failed after ${attemptCount} attempt(s). ` +
      `Reason: ${primaryReason}. Action: ${recoveryAction}`,
  };
}

function collectFromVersionManagerDirs(home: string, binary: string): string[] {
  return getVersionManagerDirs(home).flatMap(({ baseDir, nestedBinSegments }) =>
    collectBinaryFromVersionManagerDir(baseDir, binary, ...nestedBinSegments),
  );
}

export function collectBinaryFromVersionManagerDir(
  baseDir: string,
  binary: string,
  ...nestedBinSegments: string[]
): string[] {
  try {
    if (!fs.existsSync(baseDir)) {
      return [];
    }
    const entries = fs
      .readdirSync(baseDir)
      .sort((a, b) =>
        b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }),
      );
    for (const entry of entries) {
      const candidate = path.join(baseDir, entry, ...nestedBinSegments, binary);
      if (fs.existsSync(candidate)) {
        return [candidate];
      }
    }
    return [];
  } catch {
    return [];
  }
}

// ── Cross-platform script resolution ──────────────────────────────

/**
 * Resolve the actual JavaScript entry point from an iflow executable path.
 * Uses fs.realpathSync (cross-platform) instead of `readlink -f`.
 * On Windows, parses .cmd wrapper to extract the JS path.
 */
export function resolveIFlowScriptCrossPlatform(
  iflowPath: string,
  log: Logger,
): string | null {
  const lower = iflowPath.toLowerCase();
  const dir = path.dirname(iflowPath);
  const isWrapperInput = lower.endsWith(".ps1") || lower.endsWith(".cmd");

  // Try .ps1 PowerShell wrapper first.
  const ps1Path = lower.endsWith(".ps1") ? iflowPath : null;
  const ps1Sibling = !ps1Path ? path.join(dir, "iflow.ps1") : null;
  const ps1File =
    ps1Path || (ps1Sibling && fs.existsSync(ps1Sibling) ? ps1Sibling : null);
  if (ps1File) {
    const result = parsePs1Wrapper(ps1File, log);
    if (result) {
      log(`[script resolve] extracted JS from .ps1: ${result}`);
      return result;
    }
  }

  // Try .cmd batch wrapper.
  const cmdPath = lower.endsWith(".cmd") ? iflowPath : null;
  const cmdSibling = !cmdPath ? path.join(dir, "iflow.cmd") : null;
  const cmdFile =
    cmdPath || (cmdSibling && fs.existsSync(cmdSibling) ? cmdSibling : null);
  if (cmdFile) {
    const result = parseCmdWrapper(cmdFile, log);
    if (result) {
      log(`[script resolve] extracted JS from .cmd: ${result}`);
      return result;
    }
  }

  if (isWrapperInput) {
    log(`[script resolve] wrapper parsing failed: ${iflowPath}`);
    return null;
  }

  // Unix or fallback: resolve symlinks via Node.js native API
  try {
    const resolved = fs.realpathSync(iflowPath);
    log(`[script resolve] realpathSync: ${iflowPath} -> ${resolved}`);
    return resolved;
  } catch {
    log(
      `[script resolve] realpathSync failed for ${iflowPath}, using original path`,
    );
    return iflowPath;
  }
}

/** Parse a Windows .cmd batch wrapper to extract the JS entry point. */
function parseCmdWrapper(cmdPath: string, log: Logger): string | null {
  try {
    const content = fs.readFileSync(cmdPath, "utf-8");
    const match = content.match(/"([^"]*\.js)"/);
    if (match) {
      const dir = path.dirname(cmdPath);
      const jsPathRaw = match[1]
        .replace(/%~dp0\\/gi, dir + path.sep)
        .replace(/%~dp0/gi, dir + path.sep)
        .replace(/%dp0%\\/gi, dir + path.sep)
        .replace(/%dp0%/gi, dir + path.sep);

      const jsPath = path.normalize(
        jsPathRaw.replace(/\\/g, path.sep).replace(/\//g, path.sep),
      );
      if (fs.existsSync(jsPath)) {
        return jsPath;
      }
      log(`[.cmd parse] JS path extracted but does not exist: ${jsPath}`);
    }
  } catch {
    log(`[.cmd parse] failed to read: ${cmdPath}`);
  }
  return null;
}

/** Parse a Windows .ps1 PowerShell wrapper to extract the JS entry point. */
function parsePs1Wrapper(ps1Path: string, log: Logger): string | null {
  try {
    const content = fs.readFileSync(ps1Path, "utf-8");
    // Match patterns like: "$basedir/node_modules/@iflow-ai/iflow-cli/bundle/entry.js"
    // Use a more specific regex that directly matches node_modules path, ignoring $exe variable
    // Limit path length to 200 chars to avoid matching invalid content
    const match = content.match(
      /\$basedir[/\\](node_modules[/\\][^"']{0,200}?\.js)/,
    );
    if (match) {
      const dir = path.dirname(ps1Path);
      const jsPath = path.join(dir, match[1].replace(/\//g, path.sep));
      if (fs.existsSync(jsPath)) {
        return jsPath;
      }
      log(`[.ps1 parse] JS path extracted but does not exist: ${jsPath}`);
    } else {
      // Fallback: try the original pattern for compatibility
      const fallbackMatch = content.match(/"\$basedir[/\\](.*?\.js)"/);
      if (fallbackMatch) {
        const dir = path.dirname(ps1Path);
        const jsPath = path.join(
          dir,
          fallbackMatch[1].replace(/\//g, path.sep),
        );
        // Filter out paths containing variables like $exe
        if (!jsPath.includes("$") && fs.existsSync(jsPath)) {
          return jsPath;
        }
      }
    }
  } catch (err) {
    log(
      `[.ps1 parse] failed to read ${ps1Path}: ${normalizeErrorMessage(err)}`,
    );
  }
  return null;
}

// Re-export Node.js discovery from dedicated module
export { deriveNodePathFromIFlow } from "./nodeDiscovery";
