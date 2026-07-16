/**
 * Minimal env loader (no dotenv dependency).
 *
 * Load order (later file overrides earlier file keys; shell env never overwritten):
 *   1. [agent] section from config/config.toml (+ config.local.toml)
 *   2. config/agent.env              (legacy base)
 *   3. config/agent.local.env        (legacy local)
 *   4. .env                          (legacy root)
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveAppTomlConfig } from './config-files.js';

const fileSourcedKeys = new Set<string>();

const AGENT_TOML_TO_ENV: Record<string, string> = {
  api_key: 'HV_PI_API_KEY',
  base_url: 'HV_PI_BASE_URL',
  model: 'HV_PI_MODEL',
  max_tokens: 'HV_PI_MAX_TOKENS',
  HV_PI_API_KEY: 'HV_PI_API_KEY',
  HV_PI_BASE_URL: 'HV_PI_BASE_URL',
  HV_PI_MODEL: 'HV_PI_MODEL',
  HV_PI_MAX_TOKENS: 'HV_PI_MAX_TOKENS',
};

export function loadEnvFile(cwd = process.cwd()): string | null {
  fileSourcedKeys.clear();
  let lastLoaded: string | null = null;

  const fromToml = applyAgentSectionFromAppConfig(cwd);
  if (fromToml) lastLoaded = fromToml;

  const candidates: Array<{ path: string; allowOverrideFileKeys: boolean }> = [
    { path: resolve(cwd, 'config', 'agent.env'), allowOverrideFileKeys: false },
    { path: resolve(cwd, 'config', 'agent.local.env'), allowOverrideFileKeys: true },
    { path: resolve(cwd, '.env'), allowOverrideFileKeys: true },
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    applyEnvFile(candidate.path, candidate.allowOverrideFileKeys);
    lastLoaded = candidate.path;
  }
  return lastLoaded;
}

function applyAgentSectionFromAppConfig(cwd: string): string | null {
  const resolved = resolveAppTomlConfig(cwd);
  if (!resolved) return null;
  const values = parseAgentTomlSection(resolved.content);
  if (!values) return null;
  for (const [key, value] of Object.entries(values)) {
    setFileEnv(key, value, true);
  }
  return resolved.sourcePath;
}

/** Exported for tests — parse `[agent]` keys into HV_PI_* env map. */
export function parseAgentTomlSection(raw: string): Record<string, string> | null {
  let inAgent = false;
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.replace(/#.*$/, '').trim();
    if (!trimmed) continue;
    const section = /^\[([^\]]+)\]$/.exec(trimmed);
    if (section) {
      inAgent = section[1] === 'agent';
      continue;
    }
    if (/^\[\[/.test(trimmed)) {
      inAgent = false;
      continue;
    }
    if (!inAgent) continue;
    const match = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(trimmed);
    if (!match) continue;
    const envKey = AGENT_TOML_TO_ENV[match[1]!];
    if (!envKey) continue;
    const value = parseTomlString(match[2]!.trim());
    if (value !== '') out[envKey] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function parseTomlString(value: string): string {
  if (value === 'true' || value === 'false') return value;
  const quoted = /^"((?:\\.|[^"])*)"$/.exec(value);
  if (quoted) {
    return quoted[1]!
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  const single = /^'([^']*)'$/.exec(value);
  if (single) return single[1]!;
  return value;
}

function applyEnvFile(path: string, allowOverrideFileKeys: boolean): void {
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    setFileEnv(key, value, allowOverrideFileKeys);
  }
}

function setFileEnv(key: string, value: string, allowOverrideFileKeys: boolean): void {
  const alreadySet = Object.prototype.hasOwnProperty.call(process.env, key);
  if (alreadySet && !fileSourcedKeys.has(key)) {
    // Came from the shell / parent process — never override.
    return;
  }
  if (alreadySet && fileSourcedKeys.has(key) && !allowOverrideFileKeys) {
    return;
  }
  process.env[key] = value;
  fileSourcedKeys.add(key);
}
