import type { SimpleAlbumCommand } from './simple-album-command.js';
import { normalizeSafeColor } from './simple-album-command.js';
import { validateAlbumHtmlBeforePersist } from './studio-server.js';
import { createHash } from 'node:crypto';

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
  changed_keys: string[];
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
  | 'target_changed'
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

export interface SimpleAlbumTextTargetLocation {
  page_number: number;
  match_count: number;
  changed_keys: string[];
}

export interface SimpleTextTargetCandidate {
  candidate_id: string;
  page_number: number;
  data_hv_text_key: string;
  occurrence_index: number;
  matched_text: string;
  context_before: string;
  context_after: string;
  source_range: SimpleAlbumHtmlSourceRange;
  source_hash: string;
}

export type LocateSimpleTextTargetCandidatesResult =
  | { handled: true; page_count: number; candidates: SimpleTextTargetCandidate[] }
  | {
      handled: false;
      reason: 'empty_html' | 'current_page_unresolved' | 'page_not_found' | 'ambiguous_page_structure';
    };

export type LocateSimpleAlbumTextTargetsResult =
  | { handled: true; page_count: number; locations: SimpleAlbumTextTargetLocation[] }
  | { handled: false; reason: 'empty_html' | 'ambiguous_page_structure' };

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
      changed_keys: [match.node.hvTextKey],
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

/**
 * Return every text-node occurrence on exactly one page. ASCII letters are
 * compared case-insensitively while source ranges retain the original casing.
 */
export function locateSimpleTextTargetCandidates(
  html: string,
  command: SimpleAlbumCommand,
  options: ExecuteSimpleAlbumHtmlPatchOptions = {},
): LocateSimpleTextTargetCandidatesResult {
  if (!html) return { handled: false, reason: 'empty_html' };
  const requestedPage = 'page_number' in command ? command.page_number : options.currentPageNumber;
  if (!Number.isSafeInteger(requestedPage) || Number(requestedPage) < 1) {
    return { handled: false, reason: 'current_page_unresolved' };
  }
  const scan = scanAlbumHtml(html);
  if (scan.ambiguousPageStructure) return { handled: false, reason: 'ambiguous_page_structure' };
  const pageNumber = Number(requestedPage);
  if (pageNumber > scan.pageCount) return { handled: false, reason: 'page_not_found' };
  const targetText = command.type === 'replace_text' ? command.old_text : command.target_text;
  return {
    handled: true,
    page_count: scan.pageCount,
    candidates: buildTextTargetCandidates(
      html,
      scan.textNodes,
      findTextMatches(scan.textNodes, pageNumber, targetText),
    ),
  };
}

/** Apply only server-snapshotted candidates after strictly revalidating them. */
export function executeSimpleAlbumHtmlPatchForCandidates(
  html: string,
  command: SimpleAlbumCommand,
  snapshots: readonly SimpleTextTargetCandidate[],
  selectedCandidateIds: readonly string[],
): SimpleAlbumHtmlPatchResult {
  if (!html) return notHandled('empty_html');
  if (snapshots.length === 0 || selectedCandidateIds.length === 0) return notHandled('target_changed');
  const pageNumber = snapshots[0]!.page_number;
  if (snapshots.some((candidate) => candidate.page_number !== pageNumber)) return notHandled('target_changed');
  const located = locateSimpleTextTargetCandidates(html, command, { currentPageNumber: pageNumber });
  if (!located.handled) return notHandled(located.reason);
  const currentById = new Map(located.candidates.map((candidate) => [candidate.candidate_id, candidate]));
  const snapshotById = new Map(snapshots.map((candidate) => [candidate.candidate_id, candidate]));
  const chosen = [...new Set(selectedCandidateIds)].map((candidateId) => {
    const snapshot = snapshotById.get(candidateId);
    const current = currentById.get(candidateId);
    return snapshot && current && sameTextTargetCandidate(snapshot, current) ? current : null;
  });
  if (chosen.some((candidate) => candidate === null)) return notHandled('target_changed');

  const patches: Array<{
    range: SimpleAlbumHtmlSourceRange;
    replacement: string;
    key: string;
    strategy: SimpleAlbumHtmlPatchStrategy;
  }> = [];
  for (const candidate of chosen as SimpleTextTargetCandidate[]) {
    let range = { ...candidate.source_range };
    let replacement: string;
    let strategy: SimpleAlbumHtmlPatchStrategy;
    if (command.type === 'replace_text') {
      replacement = escapeHtmlText(command.new_text);
      strategy = 'replace_text_node_source';
    } else {
      const color = normalizeSafeColor(command.color);
      if (!color) return notHandled('invalid_color');
      const match = findMatchForCandidate(html, command, candidate);
      if (!match) return notHandled('target_changed');
      const controlledColor = findControlledColorValueRange(html, match);
      if (controlledColor) {
        range = controlledColor;
        replacement = escapeHtmlAttribute(color);
        strategy = 'update_controlled_color_span';
      } else {
        replacement = `<span style="color:${escapeHtmlAttribute(color)}">${html.slice(range.start, range.end)}</span>`;
        strategy = 'wrap_text_node_with_color_span';
      }
    }
    patches.push({ range, replacement, key: candidate.data_hv_text_key, strategy });
  }
  patches.sort((left, right) => right.range.start - left.range.start);
  for (let index = 1; index < patches.length; index += 1) {
    if (patches[index - 1]!.range.start < patches[index]!.range.end) return notHandled('target_changed');
  }
  let patchedHtml = html;
  for (const patch of patches) {
    patchedHtml = `${patchedHtml.slice(0, patch.range.start)}${patch.replacement}${patchedHtml.slice(patch.range.end)}`;
  }
  const validation = validateAlbumHtmlBeforePersist(html, patchedHtml);
  if (!validation.ok) {
    return { handled: false, reason: 'validation_failed', validation_reasons: [...validation.reasons] };
  }
  const first = patches[patches.length - 1]!;
  const changedKeys = [...new Set(patches.map((patch) => patch.key))];
  return {
    handled: true,
    patch: {
      html: patchedHtml,
      changed_key: changedKeys[0]!,
      changed_keys: changedKeys,
      page_number: pageNumber,
      source_range: { ...first.range },
      replacement_range: { start: first.range.start, end: first.range.start + first.replacement.length },
      patch_strategy: patches.every((patch) => patch.strategy === first.strategy)
        ? first.strategy
        : 'wrap_text_node_with_color_span',
    },
  };
}

/** Locate exact text-node matches across data-hv-text fields without mutation. */
export function locateSimpleAlbumTextTargets(
  html: string,
  command: SimpleAlbumCommand,
): LocateSimpleAlbumTextTargetsResult {
  if (!html) return { handled: false, reason: 'empty_html' };
  const scan = scanAlbumHtml(html);
  if (scan.ambiguousPageStructure) return { handled: false, reason: 'ambiguous_page_structure' };
  const targetText = command.type === 'replace_text' ? command.old_text : command.target_text;
  const locations: SimpleAlbumTextTargetLocation[] = [];
  for (let pageNumber = 1; pageNumber <= scan.pageCount; pageNumber += 1) {
    const matches = findTextMatches(scan.textNodes, pageNumber, targetText);
    if (matches.length === 0) continue;
    locations.push({
      page_number: pageNumber,
      match_count: matches.length,
      changed_keys: [...new Set(matches.map((match) => match.node.hvTextKey))],
    });
  }
  return { handled: true, page_count: scan.pageCount, locations };
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
  const foldedTarget = foldAsciiCase(target);
  const matches: TextMatch[] = [];
  for (const node of nodes) {
    if (node.pageNumber !== pageNumber) continue;
    const foldedValue = foldAsciiCase(node.decoded.value);
    let from = 0;
    while (from <= node.decoded.value.length - target.length) {
      const index = foldedValue.indexOf(foldedTarget, from);
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

function buildTextTargetCandidates(
  html: string,
  nodes: readonly ScannedTextNode[],
  matches: readonly TextMatch[],
): SimpleTextTargetCandidate[] {
  const occurrences = new Map<string, number>();
  return matches.map((match) => {
    const occurrenceIndex = occurrences.get(match.node.hvTextKey) ?? 0;
    occurrences.set(match.node.hvTextKey, occurrenceIndex + 1);
    const decodedStart = sourceRangeDecodedIndex(match.node.decoded, match.range.start);
    const decodedEnd = sourceRangeDecodedIndex(match.node.decoded, match.range.end, true);
    const fieldNodes = nodes.filter(
      (node) => node.pageNumber === match.node.pageNumber && node.hvTextKey === match.node.hvTextKey,
    );
    const nodeFieldOffset = fieldNodes
      .slice(0, Math.max(0, fieldNodes.indexOf(match.node)))
      .reduce((total, node) => total + node.decoded.value.length, 0);
    const fieldText = fieldNodes.map((node) => node.decoded.value).join('');
    const fieldMatchStart = nodeFieldOffset + decodedStart;
    const fieldMatchEnd = nodeFieldOffset + decodedEnd;
    const field = [...match.node.ancestors].reverse().find(
      (ancestor) => ancestor.hvTextKey === match.node.hvTextKey && ancestor.closeEnd !== null,
    );
    const fieldSource = field
      ? html.slice(field.openStart, field.closeEnd ?? field.openEnd)
      : html.slice(match.node.start, match.node.end);
    const matchedText = match.node.decoded.value.slice(decodedStart, decodedEnd);
    const fingerprint = [
      match.node.pageNumber,
      match.node.hvTextKey,
      occurrenceIndex,
      match.range.start,
      match.range.end,
      matchedText,
      sha256(fieldSource),
    ].join('\u0000');
    return {
      candidate_id: `txt_${sha256(fingerprint).slice(0, 24)}`,
      page_number: match.node.pageNumber,
      data_hv_text_key: match.node.hvTextKey,
      occurrence_index: occurrenceIndex,
      matched_text: matchedText,
      context_before: fieldText.slice(Math.max(0, fieldMatchStart - 32), fieldMatchStart),
      context_after: fieldText.slice(fieldMatchEnd, fieldMatchEnd + 32),
      source_range: { ...match.range },
      source_hash: sha256(fieldSource),
    };
  });
}

function sameTextTargetCandidate(
  snapshot: SimpleTextTargetCandidate,
  current: SimpleTextTargetCandidate,
): boolean {
  return snapshot.candidate_id === current.candidate_id
    && snapshot.page_number === current.page_number
    && snapshot.data_hv_text_key === current.data_hv_text_key
    && snapshot.occurrence_index === current.occurrence_index
    && snapshot.matched_text === current.matched_text
    && snapshot.context_before === current.context_before
    && snapshot.context_after === current.context_after
    && snapshot.source_range.start === current.source_range.start
    && snapshot.source_range.end === current.source_range.end
    && snapshot.source_hash === current.source_hash;
}

function findMatchForCandidate(
  html: string,
  command: SimpleAlbumCommand,
  candidate: SimpleTextTargetCandidate,
): TextMatch | null {
  const scan = scanAlbumHtml(html);
  const targetText = command.type === 'replace_text' ? command.old_text : command.target_text;
  return findTextMatches(scan.textNodes, candidate.page_number, targetText).find(
    (match) => match.range.start === candidate.source_range.start
      && match.range.end === candidate.source_range.end
      && match.node.hvTextKey === candidate.data_hv_text_key,
  ) ?? null;
}

function sourceRangeDecodedIndex(decoded: DecodedSourceText, sourceOffset: number, end = false): number {
  const offsets = end ? decoded.sourceEnds : decoded.sourceStarts;
  const exact = offsets.indexOf(sourceOffset);
  if (exact >= 0) return end ? exact + 1 : exact;
  return end ? decoded.value.length : 0;
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function renderedFieldContainsTarget(nodes: ScannedTextNode[], pageNumber: number, target: string): boolean {
  if (!target) return false;
  const fields = new Map<string, string>();
  for (const node of nodes) {
    if (node.pageNumber !== pageNumber) continue;
    fields.set(node.hvTextKey, `${fields.get(node.hvTextKey) ?? ''}${node.decoded.value}`);
  }
  const foldedTarget = foldAsciiCase(target);
  return [...fields.values()].some((value) => foldAsciiCase(value).includes(foldedTarget));
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
