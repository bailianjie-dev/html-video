import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  LocalAgentSessionStore,
  assertLocalAgentSessionId,
} from '../src/local-agent-session-store.ts';

test('migrates legacy single-Session files once without overwriting new storage', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'html-video-agent-session-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const store = new LocalAgentSessionStore(projectDir, 'project-1');
  const legacySession = {
    id: 'session-old',
    projectId: 'project-1',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  await writeFile(join(projectDir, 'agent-session.json'), JSON.stringify(legacySession), 'utf8');
  await writeFile(
    join(projectDir, 'messages.json'),
    JSON.stringify([{ content: 'legacy' }]),
    'utf8',
  );

  assert.deepEqual(await store.migrateLegacySession(), {
    sessionId: 'session-old',
    sessionMigrated: true,
    messagesMigrated: true,
  });
  assert.deepEqual(await store.readSession('session-old'), legacySession);
  assert.deepEqual(await store.readMessages('session-old'), [{ content: 'legacy' }]);

  await store.writeMessages('session-old', [{ content: 'new storage wins' }]);
  await writeFile(
    join(projectDir, 'messages.json'),
    JSON.stringify([{ content: 'changed legacy' }]),
    'utf8',
  );
  assert.deepEqual(await store.migrateLegacySession(), {
    sessionId: 'session-old',
    sessionMigrated: false,
    messagesMigrated: false,
  });
  assert.deepEqual(await store.readMessages('session-old'), [{ content: 'new storage wins' }]);
  assert.deepEqual(JSON.parse(await readFile(join(projectDir, 'messages.json'), 'utf8')), [
    { content: 'changed legacy' },
  ]);
});

test('isolates messages under each Session directory', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'html-video-agent-session-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const store = new LocalAgentSessionStore(projectDir, 'project-1');
  await store.writeSession('session-a', { id: 'session-a' });
  await store.writeSession('session-b', { id: 'session-b' });
  await store.writeMessages('session-a', [{ content: 'A' }]);
  await store.writeMessages('session-b', [{ content: 'B' }]);

  assert.deepEqual(await store.listSessionIds(), ['session-a', 'session-b']);
  assert.deepEqual(await store.readMessages('session-a'), [{ content: 'A' }]);
  assert.deepEqual(await store.readMessages('session-b'), [{ content: 'B' }]);
});

test('rejects unsafe Session ids before resolving filesystem paths', async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), 'html-video-agent-session-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const store = new LocalAgentSessionStore(projectDir, 'project-1');

  assert.throws(() => assertLocalAgentSessionId('../outside'), /Invalid agent session id/);
  await assert.rejects(() => store.writeMessages('..\\outside', []), /Invalid agent session id/);
});
