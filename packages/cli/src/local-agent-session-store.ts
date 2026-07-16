import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

export interface LegacyAgentSessionMigration {
  sessionId: string;
  sessionMigrated: boolean;
  messagesMigrated: boolean;
}

export class LocalAgentSessionStore {
  private readonly projectDir: string;
  private readonly projectId: string;

  constructor(projectDir: string, projectId: string) {
    this.projectDir = projectDir;
    this.projectId = projectId;
  }

  async listSessionIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.sessionsRoot(), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && isLocalAgentSessionId(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  async readSession<T>(sessionId: string): Promise<T | null> {
    return readJsonFile<T>(this.sessionFile(sessionId));
  }

  async writeSession(sessionId: string, value: unknown): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'session.json'), JSON.stringify(value, null, 2), 'utf8');
  }

  async readMessages<T>(sessionId: string): Promise<T[]> {
    const parsed = await readJsonFile<unknown>(this.messagesFile(sessionId));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  }

  async writeMessages(sessionId: string, value: unknown[]): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'messages.json'), JSON.stringify(value, null, 2), 'utf8');
  }

  async migrateLegacySession(): Promise<LegacyAgentSessionMigration | null> {
    const legacy = await readJsonFile<Record<string, unknown>>(
      join(this.projectDir, 'agent-session.json'),
    );
    if (
      !legacy ||
      legacy.projectId !== this.projectId ||
      typeof legacy.id !== 'string' ||
      !isLocalAgentSessionId(legacy.id)
    )
      return null;
    const sessionId = legacy.id;
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true });

    const sessionMigrated = await copyJsonIfTargetMissing(
      join(this.projectDir, 'agent-session.json'),
      join(dir, 'session.json'),
    );
    const messagesMigrated = await copyJsonIfTargetMissing(
      join(this.projectDir, 'messages.json'),
      join(dir, 'messages.json'),
    );
    return { sessionId, sessionMigrated, messagesMigrated };
  }

  private sessionsRoot(): string {
    return join(this.projectDir, 'agent-sessions');
  }

  private sessionDir(sessionId: string): string {
    return join(this.sessionsRoot(), assertLocalAgentSessionId(sessionId));
  }

  private sessionFile(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'session.json');
  }

  private messagesFile(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'messages.json');
  }
}

export function isLocalAgentSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

export function assertLocalAgentSessionId(value: string): string {
  if (!isLocalAgentSessionId(value)) {
    throw new Error(`Invalid agent session id: ${value}`);
  }
  return value;
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if (isMissingFile(error)) return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function copyJsonIfTargetMissing(source: string, target: string): Promise<boolean> {
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'EEXIST') return false;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
