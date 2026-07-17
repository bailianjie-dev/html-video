import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { resolveTomlConfig } from './config-files.js';

/** Legacy single-account username; used when authhas no [[auth.users]]. */
export const DEV_AUTH_USERNAME = 'admin';

export interface AuthUser {
  userId: string;
  displayName: string;
  password: string;
}

export interface AuthConfig {
  defaultPassword: string;
  users: AuthUser[];
  sourcePath: string;
}

export function loadAuthConfig(projectRoot: string): AuthConfig | null {
  // Auth uses [[auth.users]] array tables — prefer local file wholesale over base.
  const resolved = resolveTomlConfig(projectRoot, 'auth', { mergeSections: false });
  if (!resolved) return null;
  // Prefer local when both exist (resolveTomlConfig already chose local content
  // when mergeSections is false and local exists).
  const parsed = parseAuthToml(resolved.content);
  if (!parsed || isPlaceholderPassword(parsed.defaultPassword)) return null;

  const users = parsed.users.length > 0
    ? parsed.users.map((user) => ({
        userId: user.user_id,
        displayName: user.display_name?.trim() || user.user_id,
        password: user.password?.trim() || parsed.defaultPassword,
      }))
    : [{
        userId: DEV_AUTH_USERNAME,
        displayName: 'Administrator',
        password: parsed.defaultPassword,
      }];

  if (users.some((user) => isPlaceholderPassword(user.password))) return null;
  return { defaultPassword: parsed.defaultPassword, users, sourcePath: resolved.sourcePath };
}

export function findAuthUser(config: AuthConfig, userId: string): AuthUser | undefined {
  const normalized = normalizeAuthUserId(userId);
  if (!normalized) return undefined;
  return config.users.find((user) => user.userId === normalized);
}

export function verifyDevCredentials(
  config: AuthConfig,
  username: string,
  password: string,
): boolean {
  const user = findAuthUser(config, username);
  return Boolean(user && safeEqual(password, user.password));
}

export function createDevAuthToken(config: AuthConfig, userId: string): string {
  const user = findAuthUser(config, userId);
  if (!user) {
    throw new Error(`Unknown auth user: ${userId}`);
  }
  return createHmac('sha256', user.password)
    .update(`html-video-dev-auth:v2:${user.userId}`)
    .digest('base64url');
}

export function verifyDevAuthToken(
  config: AuthConfig,
  userId: string,
  token: string | undefined,
): boolean {
  if (!token) return false;
  const user = findAuthUser(config, userId);
  if (!user) return false;
  try {
    return safeEqual(token, createDevAuthToken(config, user.userId));
  } catch {
    return false;
  }
}

interface ParsedAuthUser {
  user_id: string;
  display_name?: string;
  password?: string;
}

interface ParsedAuthToml {
  defaultPassword: string;
  users: ParsedAuthUser[];
}

function parseAuthToml(raw: string): ParsedAuthToml | null {
  let currentSection = '';
  let defaultPassword = '';
  const users: ParsedAuthUser[] = [];
  let currentUser: ParsedAuthUser | null = null;

  const flushUser = () => {
    if (!currentUser?.user_id) {
      currentUser = null;
      return;
    }
    users.push(currentUser);
    currentUser = null;
  };

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = stripTomlComment(line).trim();
    if (!trimmed) continue;

    const arraySection = /^\[\[([^\]]+)\]\]$/.exec(trimmed);
    if (arraySection) {
      if (arraySection[1] === 'auth.users') {
        flushUser();
        currentSection = 'auth.users';
        currentUser = { user_id: '' };
      } else {
        flushUser();
        currentSection = '';
        currentUser = null;
      }
      continue;
    }

    const section = /^\[([^\]]+)\]$/.exec(trimmed);
    if (section) {
      flushUser();
      currentSection = section[1] ?? '';
      currentUser = null;
      continue;
    }

    const keyValue = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(trimmed);
    if (!keyValue) continue;
    const key = keyValue[1]!;
    const value = parseTomlScalar(keyValue[2]!.trim());

    if (currentSection === 'auth' && key === 'password' && typeof value === 'string') {
      defaultPassword = value;
      continue;
    }

    if (currentSection !== 'auth.users' || !currentUser) continue;
    if (key === 'user_id' && typeof value === 'string') {
      currentUser.user_id = normalizeAuthUserId(value);
    } else if (key === 'display_name' && typeof value === 'string') {
      currentUser.display_name = value;
    } else if (key === 'password' && typeof value === 'string') {
      currentUser.password = value;
    }
  }

  flushUser();
  if (!defaultPassword) return null;
  return { defaultPassword, users };
}

function parseTomlScalar(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const quoted = /^"((?:\\.|[^"])*)"$/.exec(value);
  if (quoted) {
    return quoted[1]!
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

function normalizeAuthUserId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const safe = trimmed.replace(/[^A-Za-z0-9_.:@-]/g, '_').slice(0, 64);
  return safe || '';
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
  return /^(change[_-]?me|your[_-]?password|replace[_-]?with[_-]?(real[_-]?)?password|replace[_-]?with[_-]?demo[_-]?password)$/i
    .test(password.trim());
}
