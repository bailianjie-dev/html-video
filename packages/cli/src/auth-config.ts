import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEV_AUTH_USERNAME = 'admin';

export interface AuthConfig {
  password: string;
  sourcePath: string;
}

export function loadAuthConfig(projectRoot: string): AuthConfig | null {
  const sourcePath = join(projectRoot, '.html-video', 'auth.toml');
  if (!existsSync(sourcePath)) return null;
  const password = parseAuthToml(readFileSync(sourcePath, 'utf8'));
  if (!password || isPlaceholderPassword(password)) return null;
  return { password, sourcePath };
}

export function verifyDevCredentials(config: AuthConfig, username: string, password: string): boolean {
  return safeEqual(username.trim(), DEV_AUTH_USERNAME)
    && safeEqual(password, config.password);
}

export function createDevAuthToken(config: AuthConfig): string {
  return createHmac('sha256', config.password)
    .update(`html-video-dev-auth:v1:${DEV_AUTH_USERNAME}`)
    .digest('base64url');
}

export function verifyDevAuthToken(config: AuthConfig, token: string | undefined): boolean {
  if (!token) return false;
  return safeEqual(token, createDevAuthToken(config));
}

function parseAuthToml(raw: string): string {
  let inAuth = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = stripTomlComment(line).trim();
    if (!trimmed) continue;
    const section = /^\[([^\]]+)\]$/.exec(trimmed);
    if (section) {
      inAuth = section[1] === 'auth';
      continue;
    }
    if (!inAuth) continue;
    const match = /^password\s*=\s*"((?:\\.|[^"])*)"\s*$/.exec(trimmed);
    if (match) {
      return match[1]!
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
  }
  return '';
}

function stripTomlComment(line: string): string {
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

function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function isPlaceholderPassword(password: string): boolean {
  return /^(change[_-]?me|your[_-]?password|replace[_-]?with[_-]?real[_-]?password)$/i.test(password.trim());
}
