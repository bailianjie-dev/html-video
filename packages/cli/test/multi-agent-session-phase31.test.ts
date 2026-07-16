import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const studioServerSource = readFileSync(
  new URL('../src/studio-server.ts', import.meta.url),
  'utf8',
);

test('Phase 3.1 returns a stable conflict for a second run in one Session', () => {
  assert.match(studioServerSource, /SESSION_HAS_ACTIVE_RUN/);
  assert.match(studioServerSource, /AGENT_RUNS\.tryAdd\(runId, registeredRun\)/);
  assert.match(studioServerSource, /agentSessionRunConflict/);
});

test('Phase 3.1 prevents archiving a Session with an active run', () => {
  assert.match(studioServerSource, /getActiveForSession/);
  assert.match(studioServerSource, /archiveAlbumAgentSession/);
  assert.match(studioServerSource, /status: 409/);
});
