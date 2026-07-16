import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeAgentSessions,
  agentRunSessionStorageKey,
  chooseAgentSession,
  normalizedAgentViewState,
  selectedAgentSessionStorageKey,
  sessionDisplayTitle,
} from '../public/agent-session-ui.js';

const sessions = [
  { id: 'newer', status: 'active', title: null, created_at: '2026-07-16T02:00:00.000Z' },
  { id: 'archived', status: 'archived', title: 'old', created_at: '2026-07-15T00:00:00.000Z' },
  { id: 'default', status: 'active', title: null, created_at: '2026-07-16T01:00:00.000Z' },
];

test('chooses a saved active Session, otherwise the earliest active Session', () => {
  assert.equal(chooseAgentSession(sessions, 'newer')?.id, 'newer');
  assert.equal(chooseAgentSession(sessions, 'archived')?.id, 'default');
  assert.equal(chooseAgentSession(sessions)?.id, 'default');
  assert.equal(chooseAgentSession([{ id: 'gone', status: 'archived' }]), null);
  assert.deepEqual(activeAgentSessions(sessions).map((item) => item.id), ['newer', 'default']);
});

test('restores the previously selected Session after a browser refresh', () => {
  const storage = new Map();
  const key = selectedAgentSessionStorageKey('user-1', 'project-1');
  storage.set(key, 'newer');
  assert.equal(chooseAgentSession(sessions, storage.get(key))?.id, 'newer');
});

test('falls back after archiving the selected Session and signals when a replacement is needed', () => {
  const afterArchive = sessions.map((session) => (
    session.id === 'newer' ? { ...session, status: 'archived' } : session
  ));
  assert.equal(chooseAgentSession(afterArchive, 'newer')?.id, 'default');
  assert.equal(chooseAgentSession(afterArchive.filter((session) => session.id !== 'default')), null);
});

test('storage keys isolate selected Session and run cursor by user, project and Session', () => {
  assert.equal(
    selectedAgentSessionStorageKey('user/a', 'project 1'),
    'html-video:selected-agent-session:v1:user%2Fa:project%201',
  );
  assert.notEqual(
    agentRunSessionStorageKey('user', 'project', 'session-a'),
    agentRunSessionStorageKey('user', 'project', 'session-b'),
  );
});

test('normalizes restored Session view state and clamps its page', () => {
  assert.deepEqual(normalizedAgentViewState({
    view_state: { activePageIndex: 8, pageCount: 3, previewRevision: 4, clientRevision: 9 },
  }), {
    activePageIndex: 2,
    pageCount: 3,
    previewRevision: 4,
    clientRevision: 9,
  });
  assert.equal(normalizedAgentViewState(null), null);
});

test('uses explicit titles and stable chronological fallback titles', () => {
  assert.equal(sessionDisplayTitle({ ...sessions[0], title: '改版方案' }, sessions), '改版方案');
  assert.equal(sessionDisplayTitle(sessions[2], sessions), 'Session 1');
  assert.equal(sessionDisplayTitle(sessions[0], sessions), 'Session 2');
});
