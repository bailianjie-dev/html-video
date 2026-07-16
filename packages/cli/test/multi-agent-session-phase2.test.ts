import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const studioServerSource = readFileSync(
  new URL('../src/studio-server.ts', import.meta.url),
  'utf8',
);

test('Phase 2 exposes lifecycle and session-scoped resource routes', () => {
  assert.match(studioServerSource, /\/agent-sessions\(\?:\\\/\(\[\^\/\]\+\)\)\?/);
  assert.match(studioServerSource, /childResource === 'messages'/);
  assert.match(studioServerSource, /childResource === 'view-state'/);
  assert.match(studioServerSource, /createAlbumAgentSession/);
  assert.match(studioServerSource, /patchAlbumAgentSession/);
  assert.match(studioServerSource, /archiveAlbumAgentSession/);
  assert.match(studioServerSource, /sessionId && childResource === 'messages' && m === 'POST'/);
});

test('Phase 2 retains compatibility routes backed by the default Session', () => {
  assert.match(studioServerSource, /\/api\\\/projects\\\/\(\[\^\/\]\+\)\\\/messages/);
  assert.match(studioServerSource, /\/agent-session\\\/view-state/);
  assert.match(studioServerSource, /ensureAlbumAgentSession\(ctx, projectId, model\)/);
  assert.match(studioServerSource, /loadMessagesForSession\(ctx, projectId, session\.id\)/);
});
