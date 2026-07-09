import { createHash } from 'node:crypto';

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Converts an external identifier into one safe, case-stable path segment.
 * Already-safe lowercase ids retain their existing spelling. Other values get
 * a readable slug plus a hash so sanitization cannot merge distinct users.
 */
export function safeWorkDirectorySegment(value: string, fallback = 'unknown'): string {
  const trimmed = value.trim();
  if (SAFE_SEGMENT.test(trimmed) && !WINDOWS_RESERVED_NAME.test(trimmed)) {
    return trimmed;
  }
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || fallback;
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 12);
  return `${slug}--${hash}`;
}
