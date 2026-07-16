import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const studioServerSource = readFileSync(
  new URL('../src/studio-server.ts', import.meta.url),
  'utf8',
);
const albumAgentSource = readFileSync(new URL('../src/album-agent-v1.ts', import.meta.url), 'utf8');
const studioAppSource = readFileSync(
  new URL('../../project-studio/public/app.js', import.meta.url),
  'utf8',
);

test('Phase 7 keeps chat on the Agent path without legacy workflow switches', () => {
  const allBackendSource = `${studioServerSource}\n${albumAgentSource}`;
  for (const removedIdentifier of [
    'HV_STUDIO_LEGACY_WORKFLOW',
    'useLegacyAlbumWorkflow',
    'detectPhase',
    'buildHtmlGenerationPrompt',
    'runSplitMultiFrameGenerate',
  ]) {
    assert.doesNotMatch(allBackendSource, new RegExp(removedIdentifier));
  }

  assert.match(studioServerSource, /handleAlbumAgentV1Message\(\{/);
  assert.doesNotMatch(studioAppSource, /ev\?\.type === ['"]preview_ready['"]/);
  assert.doesNotMatch(studioAppSource, /focus_frame_id|album_page_index|album_page_summary/);
});

test('Phase 7 retains manual HTML and multi-frame compatibility endpoints', () => {
  assert.match(studioServerSource, /const rawGetMatch = url\.pathname\.match/);
  assert.match(studioServerSource, /const frameRawMatch = url\.pathname\.match/);
  assert.match(studioServerSource, /const cgMatch = url\.pathname\.match/);
  assert.match(studioServerSource, /writePreviewHtmlRaw\(project\.id, hardenAlbumHtml\(html\)\)/);
  assert.match(studioServerSource, /writeFrameHtml\(projId, nodeId, html\)/);
});
