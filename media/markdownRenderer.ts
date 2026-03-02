import { sanitizeMarkdownLinkHref } from '../src/markdownUrlPolicy';
import { escapeHtml } from '../src/shared/escapeHtml';

export { escapeHtml };

function renderInline(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) => {
      const safeHref = sanitizeMarkdownLinkHref(href);
      if (!safeHref) {
        return label;
      }
      return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    })
    .replace(/\n/g, '<br>');
}

function renderTable(lines: string[]): string {
  const parseRow = (row: string): string[] => {
    return row.split('|').map(c => c.trim()).filter((_, i, arr) => {
      // Remove empty first/last cells from leading/trailing pipes
      if (i === 0 && arr[0] === '') { return false; }
      if (i === arr.length - 1 && arr[arr.length - 1] === '') { return false; }
      return true;
    });
  };

  if (lines.length < 2) { return escapeHtml(lines.join('\n')); }

  const headers = parseRow(lines[0]);
  // lines[1] is the separator row, skip it
  const bodyRows = lines.slice(2).map(parseRow);

  let html = '<table><thead><tr>';
  for (const h of headers) {
    html += `<th>${renderInline(h)}</th>`;
  }
  html += '</tr></thead><tbody>';
  for (const row of bodyRows) {
    html += '<tr>';
    for (const cell of row) {
      html += `<td>${renderInline(cell)}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

export function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) { i++; } // skip closing ```
      const code = escapeHtml(codeLines.join('\n'));
      result.push(`<div class="block-code"><div class="code-header"><span class="language">${lang}</span></div><pre><code>${code}</code></pre></div>`);
      continue;
    }

    // Horizontal rule
    if (/^(\s*[-*_]\s*){3,}$/.test(line)) {
      result.push('<hr>');
      i++;
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      result.push(`<h${level}>${renderInline(headerMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // Table: detect header row followed by separator row
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*[-:]+[-| :]*$/.test(lines[i + 1])) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].includes('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      result.push(renderTable(tableLines));
      continue;
    }

    // Blockquote
    if (line.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      result.push(`<blockquote>${renderMarkdown(quoteLines.join('\n'))}</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const listItems: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        listItems.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      result.push('<ul>' + listItems.map(item => `<li>${renderInline(item)}</li>`).join('') + '</ul>');
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const listItems: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        listItems.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      result.push('<ol>' + listItems.map(item => `<li>${renderInline(item)}</li>`).join('') + '</ol>');
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph
    const paraLines: string[] = [];
    while (
      i < lines.length
      && lines[i].trim() !== ''
      && !lines[i].match(/^(#{1,6}\s|```|>\s|[-*+]\s|\d+\.\s|\s*[-*_]\s*[-*_]\s*[-*_])/)
    ) {
      paraLines.push(lines[i]);
      i++;
    }

    // Guard against no-progress loops on partial markdown lines (for example,
    // a streaming chunk ending with "### " before the heading text arrives).
    if (paraLines.length === 0) {
      result.push(`<p>${renderInline(line)}</p>`);
      i++;
      continue;
    }

    result.push(`<p>${renderInline(paraLines.join('\n'))}</p>`);
  }

  return result.join('\n');
}
