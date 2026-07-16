import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { bootstrap } from '../dist/context.js';
import { startStudioServer } from '../dist/studio-server.js';

test('Phase 4 Session UI contract passes real HTTP lifecycle and isolated view-state acceptance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'html-video-phase4-http-'));
  try {
    const ctx = await bootstrap({ cwd: root });
    const studio = await startStudioServer(ctx, 0, '127.0.0.1');
    const headers = {
      'content-type': 'application/json',
      'x-user-id': `phase4-${Date.now()}`,
    };
    try {
      const created = await requestJson(studio.url, '/api/projects', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Phase 4 UI acceptance' }),
      });
      assert.equal(created.response.status, 200);
      const projectId = String(asRecord(created.body.project).id);

      const albumHtml = await requestJson(studio.url, `/api/projects/${projectId}/raw-html`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          html: '<!doctype html><html><head><meta charset="utf-8"><title>Acceptance</title></head><body><main id="album"><section data-album-page="page_1">A</section><section data-album-page="page_2">B</section><section data-album-page="page_3">C</section></main></body></html>',
        }),
      });
      assert.equal(albumHtml.response.status, 200);

      // Compatibility access creates/migrates the oldest active default Session.
      const legacyMessages = await requestJson(studio.url, `/api/projects/${projectId}/messages`, { headers });
      assert.equal(legacyMessages.response.status, 200);

      const firstList = await listSessions(studio.url, headers, projectId);
      assert.equal(firstList.length, 1);
      const defaultSession = firstList[0];
      assert.equal(defaultSession.status, 'active');
      assert.equal(defaultSession.active_run, null);
      assert.equal(defaultSession.pending_confirmation, null);

      const secondResult = await requestJson(studio.url, sessionsPath(projectId), {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: '备选方案' }),
      });
      assert.equal(secondResult.response.status, 201);
      const secondSession = asRecord(secondResult.body.session);
      const secondSessionId = String(secondSession.id);

      const renamed = await requestJson(studio.url, sessionPath(projectId, secondSessionId), {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ title: '夏季改版' }),
      });
      assert.equal(renamed.response.status, 200);
      assert.equal(asRecord(renamed.body.session).title, '夏季改版');

      await putViewState(studio.url, headers, projectId, String(defaultSession.id), 0, 11, 101);
      await putViewState(studio.url, headers, projectId, secondSessionId, 2, 22, 202);
      const defaultView = await getViewState(studio.url, headers, projectId, String(defaultSession.id));
      const secondView = await getViewState(studio.url, headers, projectId, secondSessionId);
      assert.equal(defaultView.activePageIndex, 0);
      assert.equal(defaultView.previewRevision, 11);
      assert.equal(defaultView.clientRevision, 101);
      assert.equal(secondView.activePageIndex, 2);
      assert.equal(secondView.previewRevision, 22);
      assert.equal(secondView.clientRevision, 202);

      const archived = await requestJson(studio.url, sessionPath(projectId, secondSessionId), {
        method: 'DELETE',
        headers,
      });
      assert.equal(archived.response.status, 200);
      assert.equal(asRecord(archived.body.session).status, 'archived');
      const activeAfterArchive = await listSessions(studio.url, headers, projectId);
      assert.deepEqual(activeAfterArchive.map((session) => session.id), [defaultSession.id]);

      const appScript = await fetch(`${studio.url}/app.js`).then((response) => response.text());
      assert.match(appScript, /agent-sessions\/\$\{encodeURIComponent\(genSessionId\)\}\/messages/);
      assert.match(appScript, /agent-runs\/\$\{encodeURIComponent\(runId\)\}/);
      assert.match(appScript, /selectedAgentSessionStorageKey/);
      assert.doesNotMatch(appScript, /state\.selected\.id\}\/messages/);
      const sessionModule = await fetch(`${studio.url}/agent-session-ui.js`);
      assert.equal(sessionModule.status, 200);
    } finally {
      await studio.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function listSessions(
  baseUrl: string,
  headers: Record<string, string>,
  projectId: string,
): Promise<Array<Record<string, unknown>>> {
  const result = await requestJson(baseUrl, `${sessionsPath(projectId)}?status=active`, { headers });
  assert.equal(result.response.status, 200);
  return result.body.sessions as Array<Record<string, unknown>>;
}

async function putViewState(
  baseUrl: string,
  headers: Record<string, string>,
  projectId: string,
  sessionId: string,
  activePageIndex: number,
  previewRevision: number,
  clientRevision: number,
): Promise<void> {
  const result = await requestJson(baseUrl, `${sessionPath(projectId, sessionId)}/view-state`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      view_state: { activePageIndex, pageCount: 3, previewRevision, clientRevision },
    }),
  });
  assert.equal(result.response.status, 200);
}

async function getViewState(
  baseUrl: string,
  headers: Record<string, string>,
  projectId: string,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const result = await requestJson(baseUrl, `${sessionPath(projectId, sessionId)}/view-state`, { headers });
  assert.equal(result.response.status, 200);
  return asRecord(result.body.view_state);
}

async function requestJson(
  baseUrl: string,
  path: string,
  init: RequestInit,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

function sessionsPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/agent-sessions`;
}

function sessionPath(projectId: string, sessionId: string): string {
  return `${sessionsPath(projectId)}/${encodeURIComponent(sessionId)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
