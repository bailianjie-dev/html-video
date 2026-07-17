import type { SimpleAlbumCommand } from './simple-album-command.js';
import { normalizeSafeColor } from './simple-album-command.js';
import { validateAlbumHtmlBeforePersist } from './studio-server.js';

export type SimpleAlbumHtmlPatchStrategy =
  | 'replace_text_node_source'
  | 'wrap_text_node_with_color_span'
  | 'update_controlled_color_span';

export interface SimpleAlbumHtmlSourceRange {
  start: number;
  end: number;
}

export interface SimpleAlbumHtmlPatch {
  html: string;
  changed_key: string;
  page_number: number;
  source_range: SimpleAlbumHtmlSourceRange;
  replacement_range: SimpleAlbumHtmlSourceRange;
  patch_strategy: SimpleAlbumHtmlPatchStrategy;
}

export type SimpleAlbumHtmlPatchNotHandledReason =
  | 'empty_html'
  | 'current_page_unresolved'
  | 'page_not_found'
  | 'ambiguous_page_structure'
  | 'target_not_found'
  | 'target_ambiguous'
  | 'target_crosses_markup'
  | 'invalid_color'
  | 'validation_failed';

export type SimpleAlbumHtmlPatchResult =
  | { handled: true; patch: SimpleAlbumHtmlPatch }
  | {
      handled: false;
      reason: SimpleAlbumHtmlPatchNotHandledReason;
      validation_reasons?: string[];
    };

export interface ExecuteSimpleAlbumHtmlPatchOptions {
  /** One-based Studio page used when the parsed command targets current_page. */
  currentPageNumber?: number;
}

interface ScannedElement {
  tagName: string;
  openStart: number;
  openEnd: number;
  closeStart: number | null;
  closeEnd: number | null;
  attrs: Map<string, string>;
  pageNumber: number | null;
  hvTextKey: string | null;
}

interface ScannedTextNode {
  start: number;
  end: number;
  pageNumber: number;
  hvTextKey: string;
  ancestors: ScannedElement[];
  decoded: DecodedSourceText;
}

interface HtmlScan {
  pageCount: number;
  ambiguousPageStructure: boolean;
  textNodes: ScannedTextNode[];
}

interface DecodedSourceText {
  value: string;
  sourceStarts: number[];
  sourceEnds: number[];
}

interface TextMatch {
  node: ScannedTextNode;
  range: SimpleAlbumHtmlSourceRange;
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);
const RAW_TEXT_TAGS = new Set(['script', 'style']);

/** Apply one already-parsed command without parsing, serializing, or evaluating HTML. */
export function executeSimpleAlbumHtmlPatch(
  html: string,
  command: SimpleAlbumCommand,
  options: ExecuteSimpleAlbumHtmlPatchOptions = {},
): SimpleAlbumHtmlPatchResult {
  if (!html) return notHandled('empty_html');
  const requestedPage = 'page_number' in command
    ? command.page_number
    : options.currentPageNumber;
  if (!Number.isSafeInteger(requestedPage) || Number(requestedPage) < 1) {
    return notHandled('current_page_unresolved');
  }

  const scan = scanAlbumHtml(html);
  if (scan.ambiguousPageStructure) return notHandled('ambiguous_page_structure');
  const pageNumber = Number(requestedPage);
  if (pageNumber > scan.pageCount) return notHandled('page_not_found');

  const targetText = command.type === 'replace_text' ? command.old_text : command.target_text;
  const matches = findTextMatches(scan.textNodes, pageNumber, targetText);
  if (matches.length === 0) {
    return renderedFieldContainsTarget(scan.textNodes, pageNumber, targetText)
      ? notHandled('target_crosses_markup')
      : notHandled('target_not_found');
  }
  if (matches.length !== 1) return notHandled('target_ambiguous');
  const match = matches[0]!;

  let replacement: string;
  let patchStrategy: SimpleAlbumHtmlPatchStrategy;
  if (command.type === 'replace_text') {
    replacement = escapeHtmlText(command.new_text);
    patchStrategy = 'replace_text_node_source';
  } else {
    const color = normalizeSafeColor(command.color);
    if (!color) return notHandled('invalid_color');
    const controlledColor = findControlledColorValueRange(html, match);
    if (controlledColor) {
      match.range = controlledColor;
      replacement = escapeHtmlAttribute(color);
      patchStrategy = 'update_controlled_color_span';
    } else {
      const originalSource = html.slice(match.range.start, match.range.end);
      replacement = `<span style="color:${escapeHtmlAttribute(color)}">${originalSource}</span>`;
      patchStrategy = 'wrap_text_node_with_color_span';
    }
  }

  const patchedHtml = `${html.slice(0, match.range.start)}${replacement}${html.slice(match.range.end)}`;
  const validation = validateAlbumHtmlBeforePersist(html, patchedHtml);
  if (!validation.ok) {
    return {
      handled: false,
      reason: 'validation_failed',
      validation_reasons: [...validation.reasons],
    };
  }

  return {
    handled: true,
    patch: {
      html: patchedHtml,
      changed_key: match.node.hvTextKey,
      page_number: pageNumber,
      source_range: { ...match.range },
      replacement_range: {
        start: match.range.start,
        end: match.range.start + replacement.length,
      },
      patch_strategy: patchStrategy,
    },
  };
}

function scanAlbumHtml(html: string): HtmlScan {
  const stack: ScannedElement[] = [];
  const textNodes: ScannedTextNode[] = [];
  let pageCount = 0;
  let ambiguousPageStructure = false;
  let cursor = 0;

  while (cursor < html.length) {
    const rawTextParent = [...stack].reverse().find((element) => RAW_TEXT_TAGS.has(element.tagName));
    if (rawTextParent) {
      const closing = findRawTextClosingTag(html, rawTextParent.tagName, cursor);
      if (closing < 0) break;
      cursor = closing;
    }

    const nextTag = html.indexOf('<', cursor);
    if (nextTag < 0) {
      collectTextNode(html, cursor, html.length, stack, textNodes);
      break;
    }
    if (nextTag > cursor) collectTextNode(html, cursor, nextTag, stack, textNodes);

    if (html.startsWith('<!--', nextTag)) {
      const commentEnd = html.indexOf('-->', nextTag + 4);
      cursor = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }
    const tagEnd = findTagEnd(html, nextTag);
    if (tagEnd < 0) break;
    const source = html.slice(nextTag, tagEnd);
    if (/^<!|^<\?/u.test(source)) {
      cursor = tagEnd;
      continue;
    }

    const closingMatch = /^<\s*\/\s*([a-z][\w:-]*)/iu.exec(source);
    if (closingMatch?.[1]) {
      const tagName = closingMatch[1].toLowerCase();
      const stackIndex = findLastStackTag(stack, tagName);
      if (stackIndex >= 0) {
        for (let index = stack.length - 1; index >= stackIndex; index -= 1) {
          const element = stack[index]!;
          element.closeStart = nextTag;
          element.closeEnd = tagEnd;
        }
        stack.splice(stackIndex);
      }
      cursor = tagEnd;
      continue;
    }

    const openingMatch = /^<\s*([a-z][\w:-]*)/iu.exec(source);
    if (!openingMatch?.[1]) {
      cursor = tagEnd;
      continue;
    }
    const tagName = openingMatch[1].toLowerCase();
    const attrs = parseOpeningTagAttributes(source);
    const isPage = attrs.has('data-album-page') || attrs.has('data-page');
    const parentPage = nearestStackValue(stack, 'pageNumber');
    let pageNumber = parentPage;
    if (isPage) {
      if (parentPage !== null) ambiguousPageStructure = true;
      pageCount += 1;
      pageNumber = pageCount;
    }
    const element: ScannedElement = {
      tagName,
      openStart: nextTag,
      openEnd: tagEnd,
      closeStart: null,
      closeEnd: null,
      attrs,
      pageNumber,
      hvTextKey: attrs.get('data-hv-text') ?? null,
    };
    if (!VOID_TAGS.has(tagName) && !/\/\s*>$/u.test(source)) stack.push(element);
    cursor = tagEnd;
  }

  return { pageCount, ambiguousPageStructure, textNodes };
}

function collectTextNode(
  html: string,
  start: number,
  end: number,
  stack: ScannedElement[],
  out: ScannedTextNode[],
): void {
  if (start >= end || stack.some((element) => RAW_TEXT_TAGS.has(element.tagName))) return;
  const pageNumber = nearestStackValue(stack, 'pageNumber');
  const hvTextKey = nearestStackValue(stack, 'hvTextKey');
  if (pageNumber === null || hvTextKey === null) return;
  out.push({
    start,
    end,
    pageNumber,
    hvTextKey,
    ancestors: [...stack],
    decoded: decodeHtmlTextWithSourceMap(html.slice(start, end), start),
  });
}

function findControlledColorValueRange(
  html: string,
  match: TextMatch,
): SimpleAlbumHtmlSourceRange | null {
  const parent = match.node.ancestors[match.node.ancestors.length - 1];
  if (
    !parent
    || parent.tagName !== 'span'
    || parent.closeStart === null
    || parent.openEnd !== match.node.start
    || parent.closeStart !== match.node.end
    || match.range.start !== match.node.start
    || match.range.end !== match.node.end
  ) return null;
  const openingTag = html.slice(parent.openStart, parent.openEnd);
  const style = /\bstyle\s*=\s*(["'])([\s\S]*?)\1/iu.exec(openingTag);
  if (!style?.[2] || style.index === undefined) return null;
  const declaration = /^\s*color\s*:\s*([^;]+?)\s*;?\s*$/iu.exec(style[2]);
  if (!declaration?.[1] || !normalizeSafeColor(declaration[1])) return null;
  const styleValueOffset = style[0].indexOf(style[2]);
  const colorOffset = style[2].indexOf(declaration[1]);
  if (styleValueOffset < 0 || colorOffset < 0) return null;
  const start = parent.openStart + style.index + styleValueOffset + colorOffset;
  return { start, end: start + declaration[1].length };
}

function findTextMatches(nodes: ScannedTextNode[], pageNumber: number, target: string): TextMatch[] {
  if (!target) return [];
  const matches: TextMatch[] = [];
  for (const node of nodes) {
    if (node.pageNumber !== pageNumber) continue;
    let from = 0;
    while (from <= node.decoded.value.length - target.length) {
      const index = node.decoded.value.indexOf(target, from);
      if (index < 0) break;
      const lastIndex = index + target.length - 1;
      const start = node.decoded.sourceStarts[index];
      const end = node.decoded.sourceEnds[lastIndex];
      if (start !== undefined && end !== undefined) matches.push({ node, range: { start, end } });
      from = index + Math.max(1, target.length);
    }
  }
  return matches;
}

function renderedFieldContainsTarget(nodes: ScannedTextNode[], pageNumber: number, target: string): boolean {
  if (!target) return false;
  const fields = new Map<string, string>();
  for (const node of nodes) {
    if (node.pageNumber !== pageNumber) continue;
    fields.set(node.hvTextKey, `${fields.get(node.hvTextKey) ?? ''}${node.decoded.value}`);
  }
  return [...fields.values()].some((value) => value.includes(target));
}

function decodeHtmlTextWithSourceMap(source: string, sourceOffset: number): DecodedSourceText {
  let value = '';
  const sourceStarts: number[] = [];
  const sourceEnds: number[] = [];
  let index = 0;
  while (index < source.length) {
    const entity = source[index] === '&'
      ? /^&(?:#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/iu.exec(source.slice(index))
      : null;
    const raw = entity?.[0] ?? source[index]!;
    const decoded = entity ? decodeHtmlEntity(raw) : raw;
    for (let unit = 0; unit < decoded.length; unit += 1) {
      sourceStarts.push(sourceOffset + index);
      sourceEnds.push(sourceOffset + index + raw.length);
    }
    value += decoded;
    index += raw.length;
  }
  return { value, sourceStarts, sourceEnds };
}

function decodeHtmlEntity(entity: string): string {
  const lower = entity.toLowerCase();
  const named: Readonly<Record<string, string>> = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': '\u00a0',
  };
  if (named[lower] !== undefined) return named[lower];
  const decimal = /^&#(\d+);$/u.exec(entity);
  if (decimal?.[1]) return safeCodePoint(Number(decimal[1]), entity);
  const hexadecimal = /^&#x([0-9a-f]+);$/iu.exec(entity);
  if (hexadecimal?.[1]) return safeCodePoint(Number.parseInt(hexadecimal[1], 16), entity);
  return entity;
}

function safeCodePoint(codePoint: number, fallback: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

function findTagEnd(html: string, start: number): number {
  let quote = '';
  for (let index = start + 1; index < html.length; index += 1) {
    const char = html[index]!;
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index + 1;
    }
  }
  return -1;
}

function parseOpeningTagAttributes(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const attrPattern = /\s([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu;
  for (const match of source.matchAll(attrPattern)) {
    const name = String(match[1] ?? '').toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (name) attrs.set(name, decodeAttributeValue(value));
  }
  return attrs;
}

function decodeAttributeValue(value: string): string {
  return value.replace(/&(?:#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/giu, decodeHtmlEntity);
}

function nearestStackValue<K extends 'pageNumber' | 'hvTextKey'>(
  stack: ScannedElement[],
  key: K,
): ScannedElement[K] {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const value = stack[index]![key];
    if (value !== null) return value;
  }
  return null;
}

function findLastStackTag(stack: ScannedElement[], tagName: string): number {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index]!.tagName === tagName) return index;
  }
  return -1;
}

function findRawTextClosingTag(html: string, tagName: string, from: number): number {
  const match = new RegExp(`<\\s*\\/\\s*${tagName}\\b`, 'ig');
  match.lastIndex = from;
  return match.exec(html)?.index ?? -1;
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/`/g, '&#96;');
}

function notHandled(reason: SimpleAlbumHtmlPatchNotHandledReason): SimpleAlbumHtmlPatchResult {
  return { handled: false, reason };
}
