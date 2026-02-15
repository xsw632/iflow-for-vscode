import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

type Logger = (message: string) => void;

// ── Cross-platform iFlow CLI discovery ────────────────────────────

/**
 * Find iFlow CLI path across platforms.
 * Unix: tries `which iflow`, then falls back to a login shell to pick up nvm/fnm.
 * Windows: tries `where iflow`, then checks common npm global paths.
 */
export async function findIFlowPathCrossPlatform(log: Logger): Promise<string | null> {
  if (process.platform === 'win32') {
    return findIFlowPathWindows(log);
  }
  return findIFlowPathUnix();
}

function findIFlowPathWindows(log: Logger): Promise<string | null> {
  return new Promise((resolve) => {
    cp.exec('where iflow 2>NUL & where iflow.ps1 2>NUL & where iflow.cmd 2>NUL', { timeout: 5000 }, (error, stdout) => {
      const lines = (stdout || '').trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (lines.length > 0) {
        // Prefer .ps1 > .cmd > others (PowerShell wrappers are most reliable on modern Windows)
        const ps1 = lines.find(l => l.toLowerCase().endsWith('.ps1'));
        const cmd = lines.find(l => l.toLowerCase().endsWith('.cmd'));
        const picked = ps1 || cmd || lines[0];
        log(`[Windows discovery] 'where' returned ${lines.length} result(s): ${lines.join(', ')}`);
        log(`[Windows discovery] picked: ${picked}`);
        resolve(picked);
        return;
      }
      // Fallback: check common Windows npm global location
      const appData = process.env.APPDATA;
      if (appData) {
        for (const ext of ['.ps1', '.cmd', '']) {
          const candidate = path.join(appData, 'npm', `iflow${ext}`);
          if (fs.existsSync(candidate)) {
            log(`[Windows discovery] fallback found: ${candidate}`);
            resolve(candidate);
            return;
          }
        }
      }
      log('[Windows discovery] iflow CLI not found via "where" or APPDATA fallback');
      resolve(null);
    });
  });
}

function findIFlowPathUnix(): Promise<string | null> {
  return new Promise((resolve) => {
    // First try: direct 'which' with inherited PATH (works when launched from terminal)
    cp.exec('which iflow', { timeout: 5000 }, (error, stdout) => {
      if (!error && stdout.trim()) {
        resolve(stdout.trim());
        return;
      }
      // Second try: login shell to pick up nvm/fnm/volta initialization
      const shell = process.env.SHELL || '/bin/bash';
      cp.exec(`${shell} -lc "which iflow"`, { timeout: 10000 }, (err2, stdout2) => {
        if (!err2 && stdout2.trim()) {
          resolve(stdout2.trim());
        } else {
          resolve(null);
        }
      });
    });
  });
}

// ── Cross-platform script resolution ──────────────────────────────

/**
 * Resolve the actual JavaScript entry point from an iflow executable path.
 * Uses fs.realpathSync (cross-platform) instead of `readlink -f`.
 * On Windows, parses .cmd wrapper to extract the JS path.
 */
export function resolveIFlowScriptCrossPlatform(iflowPath: string, log: Logger): string {
  if (process.platform === 'win32') {
    const lower = iflowPath.toLowerCase();
    const dir = path.dirname(iflowPath);

    // Try .ps1 PowerShell wrapper (preferred on modern Windows)
    const ps1Path = lower.endsWith('.ps1') ? iflowPath : null;
    const ps1Sibling = !ps1Path ? path.join(dir, 'iflow.ps1') : null;
    const ps1File = ps1Path || (ps1Sibling && fs.existsSync(ps1Sibling) ? ps1Sibling : null);
    if (ps1File) {
      const result = parsePs1Wrapper(ps1File, log);
      if (result) {
        log(`[script resolve] extracted JS from .ps1: ${result}`);
        return result;
      }
    }

    // Try .cmd batch wrapper
    const cmdPath = lower.endsWith('.cmd') ? iflowPath : null;
    const cmdSibling = !cmdPath ? path.join(dir, 'iflow.cmd') : null;
    const cmdFile = cmdPath || (cmdSibling && fs.existsSync(cmdSibling) ? cmdSibling : null);
    if (cmdFile) {
      const result = parseCmdWrapper(cmdFile, log);
      if (result) {
        log(`[script resolve] extracted JS from .cmd: ${result}`);
        return result;
      }
    }
  }

  // Unix or fallback: resolve symlinks via Node.js native API
  try {
    const resolved = fs.realpathSync(iflowPath);
    log(`[script resolve] realpathSync: ${iflowPath} -> ${resolved}`);
    return resolved;
  } catch {
    log(`[script resolve] realpathSync failed for ${iflowPath}, using original path`);
    return iflowPath;
  }
}

/** Parse a Windows .cmd batch wrapper to extract the JS entry point. */
function parseCmdWrapper(cmdPath: string, log: Logger): string | null {
  try {
    const content = fs.readFileSync(cmdPath, 'utf-8');
    const match = content.match(/"([^"]*\.js)"/);
    if (match) {
      const dir = path.dirname(cmdPath);
      const jsPath = match[1]
        .replace(/%~dp0\\/gi, dir + path.sep)
        .replace(/%~dp0/gi, dir + path.sep)
        .replace(/%dp0%\\/gi, dir + path.sep)
        .replace(/%dp0%/gi, dir + path.sep);
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
    const content = fs.readFileSync(ps1Path, 'utf-8');
    // Match patterns like: "$basedir/node_modules/@iflow-ai/iflow-cli/bundle/entry.js"
    // Use a more specific regex that directly matches node_modules path, ignoring $exe variable
    // Limit path length to 200 chars to avoid matching invalid content
    const match = content.match(/\$basedir[/\\](node_modules[/\\][^"']{0,200}?\.js)/);
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
        const jsPath = path.join(dir, fallbackMatch[1].replace(/\//g, path.sep));
        // Filter out paths containing variables like $exe
        if (!jsPath.includes('$') && fs.existsSync(jsPath)) {
          return jsPath;
        }
      }
    }
  } catch (err) {
    log(`[.ps1 parse] failed to read ${ps1Path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

// ── Node.js path derivation ───────────────────────────────────────

/**
 * Derive the Node.js binary path from the iflow CLI location.
 * Uses the ORIGINAL (pre-realpath) iflow path because nvm places both
 * `node` and `iflow` symlinks in the same bin/ directory.
 */
export async function deriveNodePathFromIFlow(iflowPath: string, log: Logger): Promise<string | null> {
  const isWindows = process.platform === 'win32';
  const nodeExe = isWindows ? 'node.exe' : 'node';
  const binDir = path.dirname(iflowPath);
  const candidatePath = path.join(binDir, nodeExe);

  if (fs.existsSync(candidatePath)) {
    log(`Auto-detected node at: ${candidatePath}`);
    return candidatePath;
  }

  // Windows fallback: iflow.cmd may be in %APPDATA%\npm while node.exe is elsewhere
  if (isWindows) {
    return findNodePathWindows();
  }

  log(`Node not found alongside iflow at ${binDir}`);
  return null;
}

function findNodePathWindows(): Promise<string | null> {
  return new Promise((resolve) => {
    cp.exec('where node', { timeout: 5000 }, (error, stdout) => {
      if (!error && stdout.trim()) {
        resolve(stdout.trim().split(/\r?\n/)[0]);
      } else {
        resolve(null);
      }
    });
  });
}
