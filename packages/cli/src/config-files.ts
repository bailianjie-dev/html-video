/**
 * Unified app config under `config/`:
 *
 *   config/config.toml          — base (committed, non-secret defaults)
 *   config/config.local.toml    — local overrides (gitignored, secrets)
 *   config/config.toml.example  — copy-paste template
 *
 * If the local file exists and has real content (non-empty after comments),
 * its keys override the base file. Otherwise only the base file is used.
 *
 * Legacy per-domain files (`config/database.toml`, `config/oss.toml`, …) and
 * `.html-video/<name>.toml` remain supported as a fallback.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const APP_CONFIG_NAME = 'config';

export interface ResolvedConfigFile {
  /** Path reported as the effective source (prefer local when both exist). */
  sourcePath: string;
  content: string;
  basePath: string | null;
  localPath: string | null;
}

/** True when the file has at least one non-comment, non-blank line. */
export function tomlFileHasContent(raw: string): boolean {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = stripLineComment(line).trim();
    if (trimmed) return true;
  }
  return false;
}

/**
 * Load the unified app config (`config.toml` + optional local override).
 * Returns null when neither base nor a non-empty local file exists.
 */
export function resolveAppTomlConfig(projectRoot: string): ResolvedConfigFile | null {
  const basePath = join(projectRoot, 'config', `${APP_CONFIG_NAME}.toml`);
  const localPath = join(projectRoot, 'config', `${APP_CONFIG_NAME}.local.toml`);
  const hasBase = existsSync(basePath);
  const localRaw = existsSync(localPath) ? readFileSync(localPath, 'utf8') : '';
  const hasLocalContent = Boolean(localRaw) && tomlFileHasContent(localRaw);

  if (hasLocalContent && hasBase) {
    const baseRaw = readFileSync(basePath, 'utf8');
    return {
      sourcePath: localPath,
      content: mergeUnifiedToml(baseRaw, localRaw),
      basePath,
      localPath,
    };
  }
  if (hasLocalContent) {
    return {
      sourcePath: localPath,
      content: localRaw,
      basePath: hasBase ? basePath : null,
      localPath,
    };
  }
  if (hasBase) {
    return {
      sourcePath: basePath,
      content: readFileSync(basePath, 'utf8'),
      basePath,
      localPath: existsSync(localPath) ? localPath : null,
    };
  }
  return null;
}

/**
 * Resolve a named config section.
 * Prefers the unified `config.toml` (+ local) when it contains the section;
 * otherwise falls back to legacy `config/<name>.toml` + `*.local.toml`.
 */
export function resolveTomlConfig(
  projectRoot: string,
  name: string,
  opts: { mergeSections?: boolean } = {},
): ResolvedConfigFile | null {
  const unified = resolveAppTomlConfig(projectRoot);
  if (unified && tomlHasSection(unified.content, name)) {
    return unified;
  }

  const basePath = join(projectRoot, 'config', `${name}.toml`);
  const localPath = join(projectRoot, 'config', `${name}.local.toml`);
  const hasBase = existsSync(basePath);
  const localRaw = existsSync(localPath) ? readFileSync(localPath, 'utf8') : '';
  const hasLocalContent = Boolean(localRaw) && tomlFileHasContent(localRaw);

  if (hasLocalContent) {
    const baseRaw = hasBase ? readFileSync(basePath, 'utf8') : '';
    if (hasBase && opts.mergeSections !== false) {
      return {
        sourcePath: localPath,
        content: mergeSimpleToml(baseRaw, localRaw),
        basePath,
        localPath,
      };
    }
    return {
      sourcePath: localPath,
      content: localRaw,
      basePath: hasBase ? basePath : null,
      localPath,
    };
  }

  // Migration: prefer existing legacy secrets over committed base templates.
  const legacy = [
    join(projectRoot, '.html-video', `${name}.toml`),
    join(projectRoot, `${name}.toml`),
  ];
  for (const path of legacy) {
    if (!existsSync(path)) continue;
    return {
      sourcePath: path,
      content: readFileSync(path, 'utf8'),
      basePath: null,
      localPath: null,
    };
  }

  if (hasBase) {
    return {
      sourcePath: basePath,
      content: readFileSync(basePath, 'utf8'),
      basePath,
      localPath: existsSync(localPath) ? localPath : null,
    };
  }

  return null;
}

/** Whether `raw` declares `[name]`, `[[name]]`, or `[[name.…]]`. */
export function tomlHasSection(raw: string, name: string): boolean {
  const re = new RegExp(
    `^\\s*\\[{1,2}\\s*${escapeRegExp(name)}(?:\\.[^\\]]*)?\\s*\\]{1,2}\\s*$`,
    'm',
  );
  return re.test(raw);
}

/**
 * Merge two unified TOML documents.
 * - Simple `[section]` key/values: local overrides base.
 * - Array tables `[[section]]`: if local defines any rows for that section name,
 *   local rows replace base rows; otherwise base rows are kept.
 */
export function mergeUnifiedToml(baseRaw: string, localRaw: string): string {
  const simple = mergeSimpleToml(baseRaw, localRaw);
  const baseArrays = extractArrayTableBlocks(baseRaw);
  const localArrays = extractArrayTableBlocks(localRaw);
  const names = new Set([...baseArrays.keys(), ...localArrays.keys()]);
  if (names.size === 0) return simple;

  const lines: string[] = [simple.trimEnd(), ''];
  for (const name of names) {
    const blocks = (localArrays.get(name)?.length ? localArrays.get(name) : baseArrays.get(name)) ?? [];
    for (const block of blocks) {
      lines.push(block.trimEnd(), '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Merge two simple TOML documents (section + key=value only).
 * Local keys override base keys within the same section.
 * Array tables (`[[...]]`) are not emitted here — see mergeUnifiedToml.
 */
export function mergeSimpleToml(baseRaw: string, localRaw: string): string {
  const base = parseSimpleTomlSections(baseRaw);
  const local = parseSimpleTomlSections(localRaw);
  const ordered: string[] = [];
  for (const name of base.keys()) ordered.push(name);
  for (const name of local.keys()) {
    if (!ordered.includes(name)) ordered.push(name);
  }

  const lines: string[] = [
    '# Merged from config/config.toml + config/config.local.toml',
    '# (or legacy config/<name>.toml + *.local.toml). Local keys override base.',
    '',
  ];
  for (const section of ordered) {
    if (section) lines.push(`[${section}]`);
    const merged = new Map<string, string>();
    for (const [k, v] of base.get(section) ?? []) merged.set(k, v);
    for (const [k, v] of local.get(section) ?? []) merged.set(k, v);
    for (const [k, v] of merged) lines.push(`${k} = ${v}`);
    lines.push('');
  }
  return lines.join('\n');
}

function parseSimpleTomlSections(raw: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current = '';
  sections.set(current, new Map());

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = stripLineComment(line).trim();
    if (!trimmed) continue;
    if (/^\[\[/.test(trimmed)) {
      // Skip array-table bodies in the simple map.
      current = `__array__${trimmed}`;
      if (!sections.has(current)) sections.set(current, new Map());
      continue;
    }
    const section = /^\[([^\]]+)\]$/.exec(trimmed);
    if (section) {
      current = section[1]!;
      if (!sections.has(current)) sections.set(current, new Map());
      continue;
    }
    if (current.startsWith('__array__')) continue;
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(trimmed);
    if (!kv) continue;
    const bag = sections.get(current) ?? new Map();
    bag.set(kv[1]!, kv[2]!.trim());
    sections.set(current, bag);
  }

  for (const key of [...sections.keys()]) {
    if (key.startsWith('__array__')) sections.delete(key);
  }
  return sections;
}

/** Map of array-table root name → full `[[name]]…` blocks (raw text). */
function extractArrayTableBlocks(raw: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const lines = raw.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const trimmed = stripLineComment(lines[i]!).trim();
    const header = /^\[\[([^\]]+)\]\]$/.exec(trimmed);
    if (!header) {
      i += 1;
      continue;
    }
    const fullName = header[1]!;
    const rootName = fullName.split('.')[0]!;
    const blockLines = [lines[i]!];
    i += 1;
    while (i < lines.length) {
      const next = stripLineComment(lines[i]!).trim();
      if (/^\[/.test(next)) break;
      blockLines.push(lines[i]!);
      i += 1;
    }
    const list = out.get(rootName) ?? [];
    list.push(blockLines.join('\n'));
    out.set(rootName, list);
  }
  return out;
}

function stripLineComment(line: string): string {
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quoted) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === '#' && !quoted) return line.slice(0, i);
  }
  return line;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
