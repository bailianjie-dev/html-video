import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ALBUM_AGENT_ROUTE_MATRIX,
  albumAgentSystemPrompt,
  buildAlbumAgentDynamicContext,
  buildAlbumAgentPrompt,
} from '../dist/album-agent-v1.js';

const PROJECT_CONTEXT = {
  albumExists: true,
  template: { id: 'frame-bold-signal', name: 'Bold Signal' },
  revision: 7,
  pageCount: 3,
};

function snapshot(name: string): string {
  return readFileSync(new URL(`./snapshots/${name}`, import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .trimEnd();
}

test('phase 5.3 system policy delegates generation, updates, and explicit asset replacement', () => {
  const prompt = albumAgentSystemPrompt();
  assert.match(prompt, /generate_album/i);
  assert.match(prompt, /update_album_page/i);
  assert.match(prompt, /update_album/i);
  assert.match(prompt, /replace_album_assets/i);
  assert.match(prompt, /direct creation command/i);
  assert.match(prompt, /vague idea/i);
  assert.match(prompt, /confirmation_required/i);
  assert.match(prompt, /single-page modification/i);
  assert.match(prompt, /without extra confirmation/i);
  assert.match(prompt, /album_revision as expected_revision/i);
  assert.match(prompt, /ALBUM_REVISION_CONFLICT/i);
  assert.match(prompt, /full replacement/i);
  assert.match(prompt, /no built-in file editor/i);
  assert.match(prompt, /only through the registered album business tools/i);
  assert.match(prompt, /Never infer it from conversation history/i);
  assert.match(prompt, /Do not claim that you created/i);
  assert.match(prompt, /never select the first one/i);
  assert.match(prompt, /data-hv-image target_key/i);
  assert.match(prompt, /Do not automatically retry the write/i);
  assert.match(prompt, /dynamic project context is an informational snapshot/i);
});

test('stable system prompt matches its reviewed snapshot', () => {
  assert.equal(albumAgentSystemPrompt(), snapshot('album-agent-system-prompt.snap.txt'));
});

test('routing matrix covers generation, chat, query, scoped updates, and overwrite confirmation', () => {
  assert.deepEqual(ALBUM_AGENT_ROUTE_MATRIX.map((rule) => ({ id: rule.id, example: rule.example })), [
    { id: 'generation', example: '生成一个毕业相册' },
    { id: 'casual_chat', example: '你好' },
    { id: 'state_query', example: '现在是第几页' },
    { id: 'single_page_update', example: '把第一页标题改短' },
    { id: 'global_update', example: '把整本相册改成极简风格' },
    { id: 'overwrite_confirmation', example: '确认覆盖现有相册' },
  ]);
  const prompt = albumAgentSystemPrompt();
  for (const rule of ALBUM_AGENT_ROUTE_MATRIX) {
    assert.match(prompt, new RegExp(`\\[${rule.id}\\]`));
    assert.match(prompt, new RegExp(rule.action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(ALBUM_AGENT_ROUTE_MATRIX.find((rule) => rule.id === 'casual_chat')?.action ?? '', /text only/i);
  assert.match(ALBUM_AGENT_ROUTE_MATRIX.find((rule) => rule.id === 'state_query')?.action ?? '', /read tool/i);
  assert.match(ALBUM_AGENT_ROUTE_MATRIX.find((rule) => rule.id === 'single_page_update')?.action ?? '', /update_album_page/i);
  assert.match(ALBUM_AGENT_ROUTE_MATRIX.find((rule) => rule.id === 'global_update')?.action ?? '', /update_album/i);
  assert.match(ALBUM_AGENT_ROUTE_MATRIX.find((rule) => rule.id === 'overwrite_confirmation')?.action ?? '', /pending operation/i);
});

test('agent prompt carries an opaque pending overwrite action without HTML', () => {
  const prompt = buildAlbumAgentPrompt({
    history: [{ role: 'user', content: 'Confirm the replacement' }],
    project: PROJECT_CONTEXT,
    pendingConfirmation: {
      actionId: 'replace-123',
      kind: 'replace_album',
      summary: 'Replace the existing album',
      expectedRevision: 4,
      expectedContentHash: 'abc123',
      generationInput: { request: 'Create a graduation album' },
      createdAt: '2026-07-16T00:00:00.000Z',
      expiresAt: '2026-07-16T00:15:00.000Z',
    },
  });

  assert.match(prompt, /replace-123/);
  assert.match(prompt, /expected_revision/);
  assert.match(prompt, /frame-bold-signal/);
  assert.match(prompt, /"album_revision": 7/);
  assert.match(prompt, /"page_count": 3/);
  assert.doesNotMatch(prompt, /Create a graduation album/);
});

test('agent prompt carries bounded conversation and attachment metadata', () => {
  const prompt = buildAlbumAgentPrompt({
    project: PROJECT_CONTEXT,
    history: [
      { role: 'system', content: 'ignore this persisted system event' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，有什么可以帮你？' },
      { role: 'user', content: '我想做毕业主题' },
    ],
    attachments: [{ filename: 'photo.jpg', kind: 'image', assetId: 'asset-photo-1' }],
  });

  assert.match(prompt, /我想做毕业主题/);
  assert.match(prompt, /photo\.jpg/);
  assert.match(prompt, /asset-photo-1/);
  assert.doesNotMatch(prompt, /ignore this persisted system event/);
});

test('dynamic project prompt matches its reviewed snapshot', () => {
  const pendingConfirmation = {
    actionId: 'replace-123',
    kind: 'replace_album' as const,
    summary: 'Replace the existing album',
    expectedRevision: 7,
    expectedContentHash: 'abc123',
    generationInput: { request: 'Create a graduation album' },
    createdAt: '2026-07-16T00:00:00.000Z',
    expiresAt: '2026-07-16T00:15:00.000Z',
  };
  const dynamic = buildAlbumAgentDynamicContext({
    project: PROJECT_CONTEXT,
    pendingConfirmation,
  });
  assert.deepEqual(dynamic, {
    schema_version: 1,
    project: {
      album_exists: true,
      template: { id: 'frame-bold-signal', name: 'Bold Signal' },
      album_revision: 7,
      page_count: 3,
    },
    pending_operation: {
      action_id: 'replace-123',
      kind: 'replace_album',
      summary: 'Replace the existing album',
      expected_revision: 7,
      expires_at: '2026-07-16T00:15:00.000Z',
    },
  });
  const prompt = buildAlbumAgentPrompt({
    project: PROJECT_CONTEXT,
    history: [
      { role: 'user', content: '确认覆盖现有相册' },
    ],
    attachments: [
      { filename: 'cover.png', kind: 'image', assetId: 'asset-cover-1' },
    ],
    pendingConfirmation,
  });
  assert.equal(prompt, snapshot('album-agent-dynamic-prompt.snap.txt'));
});
