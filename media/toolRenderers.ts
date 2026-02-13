import { escapeHtml } from './markdownRenderer';
import type { OutputBlock } from '../src/protocol';
import { getFileName, getFileIcon, shortenPath, humanizeToolName } from './fileUtils';

type ToolBlock = Extract<OutputBlock, { type: 'tool' }>;

// ── Constants ─────────────────────────────────────────────────────────
const MAX_DIFF_LINES = 220;
const MAX_COMMAND_LINES = 260;
const COMMAND_TRUNCATE_LENGTH = 80;

// ── Input helpers ──────────────────────────────────────────────────

function getInputString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      const firstString = value.find(v => typeof v === 'string' && v.trim()) as string | undefined;
      if (firstString) {
        return firstString.trim();
      }
    }
  }
  return null;
}

function getInputNumber(input: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const n = Number(value);
      if (Number.isFinite(n)) {
        return n;
      }
    }
  }
  return null;
}

// ── Tool classification ────────────────────────────────────────────

function looksLikePatch(text: string): boolean {
  if (!text) { return false; }
  return text.includes('*** Begin Patch') ||
    text.includes('*** Update File:') ||
    text.includes('diff --git ') ||
    text.includes('@@ ');
}

function getToolKind(block: ToolBlock): 'read' | 'write' | 'edit' | 'search' | 'command' | 'unknown' {
  const name = (block.name || '').toLowerCase();
  const input = block.input || {};

  if (getInputString(input, ['command', 'cmd', 'script'])) {
    return 'command';
  }
  if (/bash|shell|terminal|exec|command|run/.test(name)) {
    return 'command';
  }
  if (/apply.?patch|edit|replace|update|modify|rewrite/.test(name) || looksLikePatch(block.output || '')) {
    return 'edit';
  }
  if (/write|create|save|new.?file/.test(name)) {
    return 'write';
  }
  if (/read|open|cat/.test(name)) {
    return 'read';
  }
  if (/grep|glob|search|find|list|ls|rg/.test(name)) {
    return 'search';
  }
  return 'unknown';
}

function getToolLineRange(input: Record<string, unknown>): string {
  const lineStart = getInputNumber(input, ['line_start', 'lineStart', 'start_line', 'startLine']);
  const lineEnd = getInputNumber(input, ['line_end', 'lineEnd', 'end_line', 'endLine']);

  if (lineStart && lineEnd) {
    return ` (lines ${lineStart}-${lineEnd})`;
  }
  if (lineStart) {
    return ` (line ${lineStart})`;
  }
  return '';
}

// ── Headline ───────────────────────────────────────────────────────

export function getToolHeadline(block: ToolBlock): string {
  const toolName = (block.name || '').toLowerCase();
  const input = block.input || {};
  const toolKind = getToolKind(block);

  // For file operations, prioritize showing the file path over generic label
  if (toolKind === 'read' || toolName.includes('read')) {
    const path = getInputString(input, ['file_path', 'path', 'filePath', 'file']);
    if (path) {
      const lineRange = getToolLineRange(input);
      return `Read ${getFileName(path)}${lineRange}`;
    }
  }

  if (toolKind === 'write') {
    const path = getInputString(input, ['file_path', 'path', 'filePath', 'file']);
    if (path) {
      return `Write ${getFileName(path)}`;
    }
  }

  if (toolKind === 'edit') {
    const path = getInputString(input, ['file_path', 'path', 'filePath', 'file']);
    if (path) {
      return `Edit ${getFileName(path)}`;
    }
  }

  // Use label if available (for non-file tools or when file path is unknown)
  const label = (block.label || '').trim();
  if (label) {
    return label;
  }

  // Fallback logic for tools without label or file path
  if (toolKind === 'read') {
    return 'Read';
  }

  if (toolKind === 'search' && toolName.includes('glob')) {
    const pattern = getInputString(input, ['pattern', 'glob']);
    return pattern ? `Glob pattern: "${pattern}"` : 'Glob';
  }

  if (toolKind === 'search' && toolName.includes('grep')) {
    const pattern = getInputString(input, ['pattern', 'query', 'search']);
    const scope = getInputString(input, ['path', 'cwd', 'directory', 'file_path']);
    if (pattern && scope) {
      return `Grep "${pattern}" (in ${shortenPath(scope)})`;
    }
    if (pattern) {
      return `Grep "${pattern}"`;
    }
    return 'Grep';
  }

  if (toolKind === 'write') {
    return 'Write File';
  }

  if (toolKind === 'edit') {
    return 'Edit File';
  }

  const command = getInputString(input, ['command', 'cmd']);
  if (command) {
    return `Run ${command.length > COMMAND_TRUNCATE_LENGTH ? `${command.slice(0, COMMAND_TRUNCATE_LENGTH - 3)}...` : command}`;
  }

  const path = getInputString(input, ['file_path', 'path', 'filePath']);
  if (path) {
    return `${humanizeToolName(block.name)} ${shortenPath(path)}`;
  }

  return humanizeToolName(block.name);
}

// ── Diff / patch extraction ────────────────────────────────────────

function findPatchText(block: ToolBlock): string | null {
  const output = (block.output || '').trim();
  if (looksLikePatch(output)) {
    return output;
  }

  for (const value of Object.values(block.input || {})) {
    if (typeof value === 'string' && looksLikePatch(value)) {
      return value;
    }
  }
  return null;
}

function extractEditedFileDiffFromPatch(block: ToolBlock): { fileName: string; added: number; removed: number; lines: { kind: 'add' | 'del' | 'ctx' | 'meta'; text: string; lineNo?: number }[] } | null {
  const patchText = findPatchText(block);
  if (!patchText) {
    return null;
  }

  const lines = patchText.split('\n');
  let fileName = getInputString(block.input, ['file_path', 'path', 'filePath', 'file']) || '';

  const fileMarker = lines.find(line => line.startsWith('*** Update File: ') || line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: '));
  if (fileMarker) {
    fileName = fileMarker.replace(/^(\*\*\* Update File: |\*\*\* Add File: |\*\*\* Delete File: )/, '').trim();
  } else {
    const gitMarker = lines.find(line => line.startsWith('diff --git '));
    if (gitMarker) {
      const m = gitMarker.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m) {
        fileName = m[2];
      }
    }
  }

  const renderedLines: { kind: 'add' | 'del' | 'ctx' | 'meta'; text: string; lineNo?: number }[] = [];
  let added = 0;
  let removed = 0;
  let oldLine: number | null = null;
  let newLine: number | null = null;

  for (const line of lines) {
    if (!line) {
      continue;
    }
    if (line.startsWith('@@')) {
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
      }
      renderedLines.push({ kind: 'meta', text: line });
      continue;
    }
    if (line.startsWith('diff --git ') || line.startsWith('*** ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      renderedLines.push({ kind: 'meta', text: line });
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added++;
      const lineNo = newLine ?? undefined;
      renderedLines.push({ kind: 'add', text: line.substring(1), lineNo });
      if (newLine !== null) { newLine++; }
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      removed++;
      const lineNo = oldLine ?? undefined;
      renderedLines.push({ kind: 'del', text: line.substring(1), lineNo });
      if (oldLine !== null) { oldLine++; }
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('|')) {
      const lineNo = newLine ?? undefined;
      renderedLines.push({ kind: 'ctx', text: line.replace(/^ /, ''), lineNo });
      if (oldLine !== null) { oldLine++; }
      if (newLine !== null) { newLine++; }
    }
  }

  if (added === 0 && removed === 0) {
    return null;
  }

  const visibleLines = renderedLines.slice(0, MAX_DIFF_LINES);
  if (renderedLines.length > MAX_DIFF_LINES) {
    visibleLines.push({ kind: 'meta', text: `... ${renderedLines.length - MAX_DIFF_LINES} more lines` });
  }

  return {
    fileName: fileName || 'unknown file',
    added,
    removed,
    lines: visibleLines
  };
}

function extractEditedFileDiffFromOldNew(block: ToolBlock): { fileName: string; added: number; removed: number; lines: { kind: 'add' | 'del' | 'ctx' | 'meta'; text: string; lineNo?: number }[] } | null {
  const input = block.input || {};
  const oldStr = getInputString(input, ['old_string', 'oldString', 'old_str', 'old_text', 'original', 'search']);
  const newStr = getInputString(input, ['new_string', 'newString', 'new_str', 'new_text', 'replacement', 'replace']);

  if (oldStr === null && newStr === null) {
    return null;
  }

  const fileName = getInputString(input, ['file_path', 'path', 'filePath', 'file']) || 'unknown file';
  const renderedLines: { kind: 'add' | 'del' | 'ctx' | 'meta'; text: string; lineNo?: number }[] = [];
  let added = 0;
  let removed = 0;

  if (oldStr) {
    const oldLines = oldStr.split('\n');
    for (const line of oldLines) {
      removed++;
      renderedLines.push({ kind: 'del', text: line });
    }
  }

  if (newStr) {
    const newLines = newStr.split('\n');
    for (const line of newLines) {
      added++;
      renderedLines.push({ kind: 'add', text: line });
    }
  }

  if (added === 0 && removed === 0) {
    return null;
  }

  const visibleLines = renderedLines.slice(0, MAX_DIFF_LINES);
  if (renderedLines.length > MAX_DIFF_LINES) {
    visibleLines.push({ kind: 'meta', text: `... ${renderedLines.length - MAX_DIFF_LINES} more lines` });
  }

  return { fileName, added, removed, lines: visibleLines };
}

function extractEditedFileDiff(block: ToolBlock): { fileName: string; added: number; removed: number; lines: { kind: 'add' | 'del' | 'ctx' | 'meta'; text: string; lineNo?: number }[] } | null {
  return extractEditedFileDiffFromPatch(block) || extractEditedFileDiffFromOldNew(block);
}

function extractCommandPreview(block: ToolBlock): { command: string; lines: string[] } | null {
  const toolName = (block.name || '').toLowerCase();
  const command = getInputString(block.input || {}, ['command', 'cmd', 'script']);
  const output = (block.output || '').trim();
  const looksLikeCommandTool = toolName.includes('bash') || toolName.includes('shell') || toolName.includes('command') || command !== null;

  if (!looksLikeCommandTool) {
    return null;
  }
  if (!command && !output) {
    return null;
  }

  const lines = output ? output.split('\n') : (block.status === 'running' ? ['Running...'] : ['(no output)']);
  const visible = lines.slice(0, MAX_COMMAND_LINES);
  if (lines.length > MAX_COMMAND_LINES) {
    visible.push(`... ${lines.length - MAX_COMMAND_LINES} more lines`);
  }

  return {
    command: command || 'shell command',
    lines: visible
  };
}

// ── Preview renderers ──────────────────────────────────────────────

function renderWriteFilePreview(block: ToolBlock): string {
  if (block.status !== 'completed') {
    return '';
  }
  if (getToolKind(block) !== 'write') {
    return '';
  }

  const filePath = getInputString(block.input || {}, ['file_path', 'path', 'filePath', 'file']) || 'unknown file';
  const content = getInputString(block.input || {}, ['content', 'file_content', 'text', 'body', 'data']);
  const raw = (content || block.output || '').trim();
  if (!raw) {
    return '';
  }

  const lines = raw.split('\n');
  const visible = lines.slice(0, MAX_DIFF_LINES);
  if (lines.length > MAX_DIFF_LINES) {
    visible.push(`... ${lines.length - MAX_DIFF_LINES} more lines`);
  }

  const lineHtml = visible.map((line, idx) => `
    <div class="diff-line add">
      <span class="diff-line-no">${idx + 1}</span>
      <span class="diff-sign">+</span>
      <span class="diff-text">${escapeHtml(line)}</span>
    </div>
  `).join('');

  return `
    <div class="edited-file-preview">
      <div class="edited-file-header">
        <span class="edited-file-title">Written file</span>
        <span class="edited-file-name">${escapeHtml(shortenPath(filePath))}</span>
        <span class="edited-file-stats"><span class="stat-added">+${lines.length}</span></span>
      </div>
      <div class="edited-file-diff-scroll">
        ${lineHtml}
      </div>
    </div>
  `;
}

function renderEditedFilePreview(block: ToolBlock): string {
  if (block.status !== 'completed') {
    return '';
  }

  const diff = extractEditedFileDiff(block);
  if (!diff || diff.lines.length === 0) {
    return '';
  }

  const lineHtml = diff.lines.map(line => {
    const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : line.kind === 'meta' ? '@' : ' ';
    return `
      <div class="diff-line ${line.kind}">
        <span class="diff-line-no">${line.lineNo ?? ''}</span>
        <span class="diff-sign">${sign}</span>
        <span class="diff-text">${escapeHtml(line.text)}</span>
      </div>
    `;
  }).join('');

  return `
    <div class="edited-file-preview">
      <div class="edited-file-header">
        <span class="edited-file-title">Edited file</span>
        <span class="edited-file-name">${escapeHtml(diff.fileName)}</span>
        <span class="edited-file-stats"><span class="stat-added">+${diff.added}</span> <span class="stat-removed">-${diff.removed}</span></span>
      </div>
      <div class="edited-file-diff-scroll">
        ${lineHtml}
      </div>
    </div>
  `;
}

function renderCommandPreview(block: ToolBlock): string {
  const preview = extractCommandPreview(block);
  if (!preview) {
    return '';
  }

  const linesHtml = preview.lines.map((line, idx) => `
    <div class="command-line">
      <span class="command-line-no">${idx + 1}</span>
      <span class="command-line-text">${escapeHtml(line)}</span>
    </div>
  `).join('');

  return `
    <div class="command-preview">
      <div class="command-preview-header">
        <span class="command-preview-title">Bash command</span>
        <code class="command-preview-cmd">${escapeHtml(preview.command)}</code>
      </div>
      <div class="command-output-scroll">
        ${linesHtml}
      </div>
    </div>
  `;
}

export function renderToolDetailPreview(block: ToolBlock): string {
  const edited = renderEditedFilePreview(block);
  if (edited) {
    return edited;
  }
  const written = renderWriteFilePreview(block);
  if (written) {
    return written;
  }
  return renderCommandPreview(block);
}
