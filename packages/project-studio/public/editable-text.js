/**
 * Preserve visual line breaks for data-hv-text fields that use <br>.
 * Side-pane textareas speak in \n; album HTML uses <br>.
 */

export function normalizeEditableNewlines(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function escapeEditableHtmlText(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Build a safe innerHTML fragment: text nodes + <br> only. */
export function editableTextToInnerHtml(text) {
  const normalized = normalizeEditableNewlines(text);
  return normalized
    .split('\n')
    .map((line, index) => {
      const escaped = escapeEditableHtmlText(line);
      return index === 0 ? escaped : `<br>${escaped}`;
    })
    .join('');
}

/**
 * Approximate DOM walk for tests / string HTML: <br> → \n, strip other tags,
 * decode a few common entities.
 */
export function editableTextFromInnerHtml(innerHtml) {
  let s = normalizeEditableNewlines(innerHtml);
  s = s.replace(/<br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\/?[^>]+>/g, '');
  s = s
    .replace(/&nbsp;/gi, '\u00a0')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/gi, '&');
  return s;
}

/** Read an element into textarea-friendly text, keeping <br> as newlines. */
export function readEditableTextValue(el) {
  if (!el) return '';
  let out = '';
  const walk = (node) => {
    if (!node) return;
    if (node.nodeType === 3) {
      out += node.nodeValue || '';
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = String(node.tagName || '').toUpperCase();
    if (tag === 'BR') {
      out += '\n';
      return;
    }
    for (const child of node.childNodes) walk(child);
  };
  for (const child of el.childNodes) walk(child);
  return normalizeEditableNewlines(out);
}

/** Write textarea text back into an element, restoring newlines as <br>. */
export function writeEditableTextValue(el, value) {
  if (!el) return;
  const doc = el.ownerDocument;
  if (!doc) {
    el.innerHTML = editableTextToInnerHtml(value);
    return;
  }
  const text = normalizeEditableNewlines(value);
  while (el.firstChild) el.removeChild(el.firstChild);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) el.appendChild(doc.createElement('br'));
    if (lines[i]) el.appendChild(doc.createTextNode(lines[i]));
  }
}
