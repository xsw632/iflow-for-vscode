import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

// The working directory is resolved on demand and, when VS Code has no folder
// open, a single temporary directory is created and reused for the session so
// the CLI never ends up running from the filesystem root (/).
let cachedTempDir: string | null = null;

function createTempWorkspaceDir(): string {
  const base = path.join(os.tmpdir(), "iflow-vscode");
  try {
    return fs.mkdtempSync(base + "-");
  } catch {
    // If the OS temp directory is unavailable, fall back to the home directory.
    return os.homedir();
  }
}

/**
 * Resolve the directory the iFlow CLI should use as its working directory.
 *
 * - When a workspace folder is open, the first folder is used.
 * - When no folder is open, a dedicated temporary directory is assigned (and
 *   cached for the session) instead of defaulting to /, which is surprising
 *   and unsafe.
 *
 * Use this wherever the session/CLI working directory is resolved.
 */
export function resolveWorkingDirectory(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const folderPath = folder?.uri.fsPath;
  if (folderPath && folderPath.length > 0) {
    return folderPath;
  }

  if (!cachedTempDir) {
    cachedTempDir = createTempWorkspaceDir();
  }
  return cachedTempDir;
}
