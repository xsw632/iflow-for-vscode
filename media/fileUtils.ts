// General-purpose path and file name utilities used across the webview.

const PATH_SHORTEN_THRESHOLD = 60;

export function getFileName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

export function getFileIcon(path: string): string {
  const lower = path.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)$/.test(lower)) {
    return '🖼';
  }
  if (/\.(pdf)$/.test(lower)) {
    return '📕';
  }
  if (/\.(doc|docx|ppt|pptx|xls|xlsx)$/.test(lower)) {
    return '📄';
  }
  return '📎';
}

export function shortenPath(p: string): string {
  if (p.length <= PATH_SHORTEN_THRESHOLD) {
    return p;
  }
  return `...${p.slice(-57)}`;
}

export function humanizeToolName(name: string): string {
  const normalized = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!normalized) {
    return 'Tool';
  }
  return normalized[0].toUpperCase() + normalized.slice(1);
}
