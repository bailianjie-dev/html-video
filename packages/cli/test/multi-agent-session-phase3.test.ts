import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const studioServerSource = readFileSync(
  new URL('../src/studio-server.ts', import.meta.url),
  'utf8',
);
const albumAgentSource = readFileSync(
  new URL('../src/album-agent-v1.ts', import.meta.url),
  'utf8',
);

test('Phase 3 runs explicit Session messages instead of returning the Phase 2 guard', () => {
  assert.doesNotMatch(studioServerSource, /MULTI_SESSION_AGENT_RUN_NOT_ENABLED/);
  assert.match(studioServerSource, /handleAlbumAgentV1Message\(\{[\s\S]*?sessionId/);
  assert.match(studioServerSource, /sessionId\?: string/);
  assert.match(studioServerSource, /loadMessagesForSession\(ctx, projectId, session\.id\)/);
});

test('Phase 3 binds tool state and message writes to the selected Session', () => {
  assert.match(studioServerSource, /interface ExecuteAlbumGenerationToolArgs \{[\s\S]*?sessionId: string/);
  assert.match(studioServerSource, /interface ExecuteAlbumUpdateToolArgs \{[\s\S]*?sessionId: string/);
  assert.match(studioServerSource, /interface ExecuteAlbumAssetReplacementToolArgs \{[\s\S]*?sessionId: string/);
  assert.match(
    studioServerSource,
    /getAlbumAgentSession\(\s*args\.ctx,\s*args\.projectId,\s*args\.sessionId,?\s*\)/,
  );
  assert.match(studioServerSource, /message: ChatMessage & \{ sessionId: string \}/);
});

test('Phase 3 exposes Session-scoped SSE replay and cancellation while retaining legacy routes', () => {
  assert.match(studioServerSource, /agent-sessions\\\/\(\[\^\/\]\+\)\\\/agent-runs/);
  assert.match(studioServerSource, /run\.sessionId !== sessionId/);
  assert.match(studioServerSource, /x-agent-events-url/);
  assert.match(studioServerSource, /\/api\\\/agent-runs\\\/\(\[\^\/\]\+\)\\\/events/);
  assert.match(albumAgentSource, /sessionId: string;/);
});
