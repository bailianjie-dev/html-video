/**
 * Unified config layout under `config/`:
 *
 *   config/<name>.toml         — base (committed, non-secret defaults)
 *   config/<name>.local.toml   — local overrides (gitignored, secrets)
 *
 * Local wins over base for the same keys. Legacy paths under `.html-video/`
 * and the project root remain supported for migration — and take precedence
 * over base-only config when no `*.local.toml` exists yet.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ResolvedConfigFile {
  /** Path reported as the effective source (prefer local when both exist). */
  sourcePath: string;
  content: string;
  basePath: string | null;
  localPath: string | null;
}

export function resolveTomlConfig(
  projectRoot: string,
  name: string,
  opts: { mergeSections?: boolean } = {},
): ResolvedConfigFile | null {
  const basePath = join(projectRoot, 'config', `${name}.toml`);
  const localPath = join(projectRoot, 'config', `${name}.local.toml`);
  const hasBase = existsSync(basePath);
  const hasLocal = existsSync(localPath);

  // New layout: local present → merge with base (or local alone).
  if (hasLocal) {
    const baseRaw = hasBase ? readFileSync(basePath, 'utf8') : '';
    const localRaw = readFileSync(localPath, 'utf8');
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
      localPath: null,
    };
  }

  return null;
}

/**
 * Merge two simple TOML documents (section + key=value only).
 * Local keys override base keys within the same section.
 * Array tables (`[[...]]`) are not merged — callers should prefer local-only.
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
    '# Merged from config/<name>.toml + config/<name>.local.toml',
    '# Local keys override base keys.',
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
    const trimmed = line.replace(/#.*$/, '').trim();
    if (!trimmed) continue;
    if (/^\[\[/.test(trimmed)) {
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
