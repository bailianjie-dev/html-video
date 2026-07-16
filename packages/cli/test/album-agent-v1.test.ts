import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  albumAgentSystemPrompt,
  buildAlbumAgentPrompt,
  useLegacyAlbumWorkflow,
} from '../dist/album-agent-v1.js';

test('agent v1 is default and legacy workflow requires an explicit flag', () => {
  assert.equal(useLegacyAlbumWorkflow({}), false);
  assert.equal(useLegacyAlbumWorkflow({ HV_STUDIO_LEGACY_WORKFLOW: '1' }), true);
  assert.equal(useLegacyAlbumWorkflow({ HV_STUDIO_LEGACY_WORKFLOW: 'true' }), true);
  assert.equal(useLegacyAlbumWorkflow({ HV_STUDIO_LEGACY_WORKFLOW: '0' }), false);
});

test('phase 5.2 system policy delegates generation, updates, and explicit asset replacement', () => {
  const prompt = albumAgentSystemPrompt();
  assert.match(prompt, /generate_album/i);
  assert.match(prompt, /update_album_page/i);
  assert.match(prompt, /update_album/i);
  assert.match(prompt, /replace_album_assets/i);
  assert.match(prompt, /direct creation command/i);
  assert.match(prompt, /only expresses an idea or preference/i);
  assert.match(prompt, /confirmation_required/i);
  assert.match(prompt, /single-page modification/i);
  assert.match(prompt, /without confirmation/i);
  assert.match(prompt, /album_revision as expected_revision/i);
  assert.match(prompt, /ALBUM_REVISION_CONFLICT/i);
  assert.match(prompt, /full replacement/i);
  assert.match(prompt, /no built-in file editor/i);
  assert.match(prompt, /only through the registered album business tools/i);
  assert.match(prompt, /Never infer it from conversation history/i);
  assert.match(prompt, /Do not claim that you created/i);
  assert.match(prompt, /never select the first one/i);
  assert.match(prompt, /data-hv-image target_key/i);
});

test('agent prompt carries an opaque pending overwrite action without HTML', () => {
  const prompt = buildAlbumAgentPrompt({
    history: [{ role: 'user', content: 'Confirm the replacement' }],
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
  assert.doesNotMatch(prompt, /Create a graduation album/);
});

test('agent prompt carries bounded conversation and attachment metadata', () => {
  const prompt = buildAlbumAgentPrompt({
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
