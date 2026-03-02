/**
 * Pure-string HTML escaping utility.
 *
 * Uses a static lookup table and a single regex pass — no DOM element creation.
 * This makes it safe to use in Node.js (tests, extension host) as well as in
 * the webview renderer.
 */

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const HTML_ESCAPE_RE = /[&<>"']/g;

export function escapeHtml(text: string): string {
  return text.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch]);
}
