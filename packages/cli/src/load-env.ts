/**
 * Minimal env loader (no dotenv dependency).
 *
 * Load order:
 *   1. config/agent.env          (base, committed)
 *   2. config/agent.local.env    (local overrides, gitignored)
 *   3. .env                      (legacy root file)
 *
 * Keys already present in process.env (shell) are never overwritten.
 * Local file may override values previously set by the base file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fileSourcedKeys = new Set<string>();

export function loadEnvFile(cwd = process.cwd()): string | null {
  fileSourcedKeys.clear();
  const candidates: Array<{ path: string; allowOverrideFileKeys: boolean }> = [
    { path: resolve(cwd, 'config', 'agent.env'), allowOverrideFileKeys: false },
    { path: resolve(cwd, 'config', 'agent.local.env'), allowOverrideFileKeys: true },
    { path: resolve(cwd, '.env'), allowOverrideFileKeys: true },
  ];
  let lastLoaded: string | null = null;
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    applyEnvFile(candidate.path, candidate.allowOverrideFileKeys);
    lastLoaded = candidate.path;
  }
  return lastLoaded;
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

    const alreadySet = Object.prototype.hasOwnProperty.call(process.env, key);
    if (alreadySet && !fileSourcedKeys.has(key)) {
      // Came from the shell / parent process — never override.
      continue;
    }
    if (alreadySet && fileSourcedKeys.has(key) && !allowOverrideFileKeys) {
      continue;
    }

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    fileSourcedKeys.add(key);
  }
}
