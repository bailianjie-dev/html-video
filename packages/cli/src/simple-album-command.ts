export type SimpleAlbumCommandPage =
  | { page_number: number; current_page?: never; page_match_policy?: 'strict' }
  | { current_page: true; page_number?: never };

export type SimpleAlbumCommand = SimpleAlbumCommandPage & (
  | {
      type: 'replace_text';
      old_text: string;
      new_text: string;
    }
  | {
      type: 'set_text_color';
      target_text: string;
      color: string;
    }
);

export type SimpleAlbumCommandNotHandledReason =
  | 'empty_input'
  | 'subjective_request'
  | 'compound_request'
  | 'ambiguous_page'
  | 'invalid_page'
  | 'ambiguous_command'
  | 'missing_old_text'
  | 'missing_new_text'
  | 'missing_target_text'
  | 'missing_color'
  | 'invalid_color'
  | 'non_text_style_request'
  | 'unsupported_command';

export type ParseSimpleAlbumCommandResult =
  | { handled: true; command: SimpleAlbumCommand }
  | { handled: false; reason: SimpleAlbumCommandNotHandledReason };

const SUBJECTIVE_REQUEST = /(?:更|再)?(?:高级|高級|好看|漂亮|美观|美觀|科技感|有质感|有質感|大气|大氣|精致|精緻|酷炫|炫酷|时尚|時尚|专业|專業|协调|協調|舒服|优化一下|優化一下|美化一下)/i;
const COMPOUND_REQUEST = /(?:并且|並且|同时|同時|然后|然後|以及|再把|再将|再將|;)/i;
const COLOR_STYLE_HINT = /(?:字体|字體|文字|文本)?(?:的)?(?:颜色|顏色|色彩)|字体|字體|字色|font\s*color|text\s*color/i;
const NON_TEXT_STYLE_TARGET = /(?:背景(?:色|颜色|顏色)?|渐变(?:色)?|漸變(?:色)?|边框|邊框|阴影|陰影|布局|佈局|字号|字號|动画|動畫|圆角|圓角|间距|間距|留白|透明度|蒙版|遮罩|滤镜|濾鏡|定位|对齐|對齊|尺寸|宽度|寬度|高度)/iu;
const CANONICAL_OPERATOR = '改为';
const OPERATOR = /改为/gu;
const OPERATOR_ALIASES = Object.freeze([
  '替换成', '替換成', '替换为', '替換為',
  '设置成', '設置成', '设置为', '設置為',
  '调整成', '調整成', '调整为', '調整為',
  '变成', '變成', '变为', '變為',
  '弄成', '搞成', '调成', '調成', '调为', '調為',
  '改成', '改为', '改為',
  '换成', '換成', '换为', '換為',
  '设为', '設為',
] as const);

const SAFE_COLORS: Readonly<Record<string, string>> = Object.freeze({
  '红色': '#FF0000',
  '紅色': '#FF0000',
  '蓝色': '#0000FF',
  '藍色': '#0000FF',
  '绿色': '#008000',
  '綠色': '#008000',
  '黄色': '#FFFF00',
  '黃色': '#FFFF00',
  '橙色': '#FFA500',
  '紫色': '#800080',
  '粉色': '#FFC0CB',
  '黑色': '#000000',
  '白色': '#FFFFFF',
  '灰色': '#808080',
  '品牌蓝': '#2563EB',
  '品牌藍': '#2563EB',
  '品牌红': '#FF5A36',
  '品牌紅': '#FF5A36',
  '品牌橙': '#FF5A36',
  red: '#FF0000',
  blue: '#0000FF',
  green: '#008000',
  yellow: '#FFFF00',
  orange: '#FFA500',
  purple: '#800080',
  pink: '#FFC0CB',
  black: '#000000',
  white: '#FFFFFF',
  gray: '#808080',
  grey: '#808080',
});

/** Parse a deliberately small, deterministic subset of album edit commands. */
export function parseSimpleAlbumCommand(input: string): ParseSimpleAlbumCommandResult {
  const normalized = normalizeSimpleCommandAliases(normalizeSimpleCommandText(input));
  if (!normalized) return notHandled('empty_input');
  if (SUBJECTIVE_REQUEST.test(normalized)) return notHandled('subjective_request');
  if (COMPOUND_REQUEST.test(normalized)) return notHandled('compound_request');

  const page = parsePageSelector(normalized);
  if (!page.ok) return notHandled(page.reason);
  const body = removePageSelectors(normalized)
    .replace(/^\s*就是\s*[,：:]?\s*/u, '')
    .replace(/^\s*(?:的|之中|中|里|裡)\s*/u, '')
    .trim();

  const operators = [...body.matchAll(OPERATOR)];
  if (operators.length === 0) {
    if (COLOR_STYLE_HINT.test(body)) return notHandled('missing_color');
    return notHandled('unsupported_command');
  }
  if (operators.length !== 1) return notHandled('ambiguous_command');

  const operatorMatch = operators[0]!;
  const operator = operatorMatch[0];
  const operatorIndex = operatorMatch.index ?? -1;
  if (operatorIndex < 0) return notHandled('ambiguous_command');
  const leftRaw = body.slice(0, operatorIndex);
  const rightRaw = body.slice(operatorIndex + operator.length);
  const left = cleanCommandValue(leftRaw, 'left');
  const right = cleanCommandValue(rightRaw, 'right');
  if (!hasExplicitTextTargetEvidence(input) && NON_TEXT_STYLE_TARGET.test(left)) {
    return notHandled('non_text_style_request');
  }

  const styleIntent = COLOR_STYLE_HINT.test(leftRaw);
  const color = normalizeSafeColor(right);
  if (styleIntent || color !== null) {
    if (!left) return notHandled('missing_target_text');
    if (!right) return notHandled('missing_color');
    if (!color) return notHandled('invalid_color');
    const target = cleanColorTarget(left);
    if (!target) return notHandled('missing_target_text');
    return {
      handled: true,
      command: {
        type: 'set_text_color',
        ...page.value,
        target_text: target,
        color,
      },
    };
  }

  if (!left) return notHandled('missing_old_text');
  if (!right) return notHandled('missing_new_text');
  return {
    handled: true,
    command: {
      type: 'replace_text',
      ...page.value,
      old_text: left,
      new_text: right,
    },
  };
}

/**
 * Evidence that the user explicitly refers to literal text rather than using
 * the generic "X 改成 Y" shape for an arbitrary visual property.
 */
export function hasExplicitTextTargetEvidence(input: string): boolean {
  const normalized = normalizeSimpleCommandText(input);
  if (/"[^"\r\n]{1,500}"/u.test(normalized)) return true;
  return /(?:文字|文本|文案|字样|字樣|词语|詞語|字符|(?:几|幾|[0-9一二三四五六七八九十]+)个字|字体|字體|字色|font\s*color|text\s*color)/iu.test(normalized);
}

export function normalizeSimpleCommandText(input: string): string {
  return String(input ?? '')
    .normalize('NFKC')
    .replace(/[“”‘’]/g, '"')
    .replace(/[，、]/g, ',')
    .replace(/[。]/g, '.')
    .replace(/[：]/g, ':')
    .replace(/[；]/g, ';')
    .replace(/\s+/g, ' ')
    .replace(/\s*([,:;.])\s*/g, '$1')
    .trim();
}

/**
 * Canonicalize a deliberately bounded operator vocabulary outside quoted
 * literal text. This is lexical normalization, not fuzzy language inference.
 */
export function normalizeSimpleCommandAliases(input: string): string {
  const source = String(input ?? '');
  let normalized = '';
  let quote = '';
  for (let index = 0; index < source.length;) {
    const char = source[index]!;
    if (quote) {
      normalized += char;
      if (char === quote) quote = '';
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      normalized += char;
      index += 1;
      continue;
    }
    const alias = OPERATOR_ALIASES.find(
      (candidate) => source.startsWith(candidate, index)
        && !isAliasEmbeddedInStyleTerm(source, index, candidate),
    );
    if (alias) {
      normalized += CANONICAL_OPERATOR;
      index += alias.length;
      continue;
    }
    normalized += char;
    index += 1;
  }
  return normalized;
}

function isAliasEmbeddedInStyleTerm(source: string, index: number, alias: string): boolean {
  // “渐变为/漸變為” describes a gradient and must not contribute a second
  // colloquial “变为” mutation operator.
  return /^(?:变|變)(?:成|为|為)$/u.test(alias) && /[渐漸]/u.test(source[index - 1] ?? '');
}

export function normalizeSafeColor(input: string): string | null {
  const value = stripBoundaryValue(String(input ?? ''));
  if (!value) return null;
  const named = SAFE_COLORS[value] ?? SAFE_COLORS[value.toLocaleLowerCase()];
  if (named) return named;

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value);
  if (hex?.[1]) return `#${hex[1].toUpperCase()}`;

  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(value);
  if (!rgb) return null;
  const channels = rgb.slice(1).map(Number);
  if (channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) return null;
  return `rgb(${channels.join(', ')})`;
}

function parsePageSelector(input: string):
  | { ok: true; value: SimpleAlbumCommandPage }
  | { ok: false; reason: 'ambiguous_page' | 'invalid_page' } {
  const explicitPages = [...input.matchAll(/第\s*([0-9〇零一二三四五六七八九十百两兩]+)\s*页/gu)];
  const hasCurrentPage = /(?:当前|當前|本|这(?:一)?|這(?:一)?)\s*页/u.test(input);
  if (hasCurrentPage && explicitPages.length > 0) return { ok: false, reason: 'ambiguous_page' };

  const pageNumbers = explicitPages.map((match) => parsePageNumber(match[1] ?? ''));
  if (pageNumbers.some((pageNumber) => pageNumber === null || pageNumber < 1 || pageNumber > 30)) {
    return { ok: false, reason: 'invalid_page' };
  }
  const uniquePages = [...new Set(pageNumbers as number[])];
  if (uniquePages.length > 1) return { ok: false, reason: 'ambiguous_page' };
  if (uniquePages.length === 1) {
    return {
      ok: true,
      value: {
        page_number: uniquePages[0]!,
        ...(/就是\s*第/u.test(input) && { page_match_policy: 'strict' as const }),
      },
    };
  }
  return { ok: true, value: { current_page: true } };
}

function removePageSelectors(input: string): string {
  return input
    .replace(/第\s*[0-9〇零一二三四五六七八九十百两兩]+\s*页/gu, ' ')
    .replace(/(?:当前|當前|本|这(?:一)?|這(?:一)?)\s*页/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePageNumber(input: string): number | null {
  if (/^\d+$/.test(input)) return Number(input);
  const digits: Readonly<Record<string, number>> = {
    '〇': 0, '零': 0, '一': 1, '二': 2, '两': 2, '兩': 2, '三': 3, '四': 4,
    '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
  };
  let total = 0;
  let current = 0;
  for (const char of input) {
    if (char === '十' || char === '百') {
      const unit = char === '十' ? 10 : 100;
      total += (current || 1) * unit;
      current = 0;
      continue;
    }
    const digit = digits[char];
    if (digit === undefined) return null;
    current = digit;
  }
  return total + current;
}

function cleanCommandValue(input: string, side: 'left' | 'right'): string {
  let value = String(input ?? '').trim();
  if (side === 'left') {
    value = value
      .replace(/^\s*(?:把|将|將)\s*/u, '')
      .replace(/^\s*的\s*/u, '')
      .replace(/\s*(?:,|:)\s*$/u, '')
      .replace(/\s*(?:的)?(?:字体|字體|文字|文本)?(?:颜色|顏色|色彩|字色|font\s*color|text\s*color)\s*$/iu, '')
      .replace(/\s*(?:的)?(?:字体|字體)\s*$/u, '');
  } else {
    value = value
      .replace(/\s*(?:其他|其它)(?:内容|內容)?(?:保持)?不变\.?\s*$/u, '')
      .replace(/\s*(?:即可|就行|就可以)\.?\s*$/u, '');
  }
  return stripBoundaryValue(value);
}

function cleanColorTarget(input: string): string {
  const target = stripBoundaryValue(
    input
      .replace(/\s*(?:的)?(?:字体|字體|文字|文本)?(?:颜色|顏色|色彩|字色|font\s*color|text\s*color)\s*$/iu, '')
      .replace(/\s*(?:的)?(?:字体|字體)\s*$/u, '')
      .trim(),
  );
  return /^(?:主标题|主標題|副标题|副標題|标题|標題|正文|文案|描述)$/u.test(target)
    ? ''
    : target;
}

function stripBoundaryValue(input: string): string {
  let value = input.trim();
  let previous = '';
  while (value !== previous) {
    previous = value;
    value = stripBoundaryQuotes(stripBoundaryPunctuation(value));
  }
  return value.trim();
}

function stripBoundaryQuotes(input: string): string {
  let value = input.trim();
  while (value.length >= 2 && (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  )) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function stripBoundaryPunctuation(input: string): string {
  return input.replace(/^[,:.]+|[,:.]+$/g, '').trim();
}

function notHandled(reason: SimpleAlbumCommandNotHandledReason): ParseSimpleAlbumCommandResult {
  return { handled: false, reason };
}
