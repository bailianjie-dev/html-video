import test from 'node:test';
import assert from 'node:assert/strict';
import { albumRowToProject, projectToAlbumSettings } from '../dist/index.js';

test('album revision round-trips through project settings', () => {
  const project = albumRowToProject({
    id: 'album-1',
    source_project_id: 'project-1',
    title: 'Graduation',
    description: null,
    status: 'previewed',
    canvas_width: 1080,
    canvas_height: 1920,
    fps: 30,
    duration_ms: 0,
    page_count: 0,
    last_preview_html_url: null,
    settings: { album_revision: 7 },
    created_time: '2026-07-16T00:00:00.000Z',
    updated_time: '2026-07-16T00:00:00.000Z',
  });

  assert.equal(project.albumRevision, 7);
  assert.equal(projectToAlbumSettings(project).album_revision, 7);
});
