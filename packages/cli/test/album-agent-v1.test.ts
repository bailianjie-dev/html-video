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

test('phase 3 system policy delegates only complete generation and preserves live-state rules', () => {
  const prompt = albumAgentSystemPrompt();
  assert.match(prompt, /generate_album/i);
  assert.match(prompt, /direct creation command/i);
  assert.match(prompt, /only expresses an idea or preference/i);
  assert.match(prompt, /confirmation_required/i);
  assert.match(prompt, /no file, shell, network, editing/i);
  assert.match(prompt, /Never infer it from conversation history/i);
  assert.match(prompt, /Do not claim that you created/i);
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
    attachmentNames: ['photo.jpg'],
  });

  assert.match(prompt, /我想做毕业主题/);
  assert.match(prompt, /photo\.jpg/);
  assert.doesNotMatch(prompt, /ignore this persisted system event/);
});
