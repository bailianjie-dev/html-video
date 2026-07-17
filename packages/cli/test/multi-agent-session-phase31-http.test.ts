import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileProjectPersistence, ProjectStore } from '@html-video/core';

import { type CliContext, bootstrap } from '../dist/context.js';
import { startStudioServer } from '../dist/studio-server.js';

const RUN_TIMEOUT_MS = 15_000;

test('runtime bootstrap requires PostgreSQL configuration instead of falling back to files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'html-video-postgres-required-'));
  try {
    await assert.rejects(
      bootstrap({ cwd: root }),
      /PostgreSQL configuration is required/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit test persistence isolates concurrent Session runs through real HTTP and SSE', async () => {
  const root = await mkdtemp(join(tmpdir(), 'html-video-phase31-file-'));
  try {
    const ctx = await bootstrap({
      cwd: root,
      projects: new FileProjectPersistence(new ProjectStore(root)),
    });
    assert.notEqual(ctx.database?.mode, 'postgres');
    await withFakeAgentProvider(() => runHttpAcceptance(ctx, 'file'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'PostgreSQL mode isolates concurrent Session runs through real HTTP and SSE',
  { skip: process.env.HV_PHASE31_POSTGRES_ACCEPTANCE !== '1' },
  async () => {
    const ctx = await bootstrap({ cwd: process.cwd() });
    assert.equal(ctx.database?.mode, 'postgres');
    await withFakeAgentProvider(() => runHttpAcceptance(ctx, 'postgres'));
  },
);

async function runHttpAcceptance(ctx: CliContext, mode: string): Promise<void> {
  const studio = await startStudioServer(ctx, 0, '127.0.0.1');
  const userId = `phase31-${mode}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const headers = {
    'content-type': 'application/json',
    'x-user-id': userId,
  };
  let projectId = '';
  try {
    const created = await requestJson(studio.url, '/api/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: `Phase 3.1 ${mode}` }),
    });
    assert.equal(created.response.status, 200);
    projectId = String(asRecord(created.body.project).id);

    const sessionA = await createSession(studio.url, headers, projectId, 'Session A');
    const sessionB = await createSession(studio.url, headers, projectId, 'Session B');
    assert.notEqual(sessionA, sessionB);

    const runAResponse = await postMessage(studio.url, headers, projectId, sessionA, 'HOLD_A');
    assert.equal(runAResponse.status, 200);
    const runAId = requiredHeader(runAResponse, 'x-agent-run-id');
    assert.equal(requiredHeader(runAResponse, 'x-agent-session-id'), sessionA);

    const sameSessionConflict = await requestJson(
      studio.url,
      sessionMessagesPath(projectId, sessionA),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: 'MUST_NOT_PERSIST' }),
      },
    );
    assert.equal(sameSessionConflict.response.status, 409);
    assert.equal(sameSessionConflict.body.code, 'SESSION_HAS_ACTIVE_RUN');
    assert.equal(sameSessionConflict.body.active_run_id, runAId);

    const archiveConflict = await requestJson(studio.url, sessionPath(projectId, sessionA), {
      method: 'DELETE',
      headers,
    });
    assert.equal(archiveConflict.response.status, 409);
    assert.equal(archiveConflict.body.code, 'SESSION_HAS_ACTIVE_RUN');

    const runBResponse = await postMessage(studio.url, headers, projectId, sessionB, 'HOLD_B');
    assert.equal(runBResponse.status, 200);
    const runBId = requiredHeader(runBResponse, 'x-agent-run-id');
    assert.equal(requiredHeader(runBResponse, 'x-agent-session-id'), sessionB);

    const wrongSessionReplay = await fetch(
      `${studio.url}${sessionRunEventsPath(projectId, sessionB, runAId)}?after=0`,
      { headers },
    );
    assert.equal(wrongSessionReplay.status, 404);
    await wrongSessionReplay.text();

    const wrongSessionCancel = await requestJson(
      studio.url,
      sessionRunPath(projectId, sessionB, runAId),
      { method: 'DELETE', headers },
    );
    assert.equal(wrongSessionCancel.response.status, 404);

    const replayAPromise = fetch(
      `${studio.url}${sessionRunEventsPath(projectId, sessionA, runAId)}?after=1`,
      { headers },
    ).then(readSseEvents);

    const cancelB = await requestJson(studio.url, sessionRunPath(projectId, sessionB, runBId), {
      method: 'DELETE',
      headers,
    });
    assert.equal(cancelB.response.status, 202);
    assert.equal(cancelB.body.session_id, sessionB);

    const [eventsA, replayA, eventsB] = await withTimeout(
      Promise.all([readSseEvents(runAResponse), replayAPromise, readSseEvents(runBResponse)]),
      RUN_TIMEOUT_MS,
    );
    assert.ok(eventsA.some((event) => event.type === 'run.completed'));
    assert.ok(replayA.some((event) => event.type === 'run.completed'));
    assert.ok(eventsB.some((event) => event.type === 'run.cancelled'));
    assert.ok(eventsA.every((event) => event.sessionId === sessionA));
    assert.ok(replayA.every((event) => event.sessionId === sessionA));
    assert.ok(eventsB.every((event) => event.sessionId === sessionB));

    const messagesA = await getMessages(studio.url, headers, projectId, sessionA);
    const messagesB = await getMessages(studio.url, headers, projectId, sessionB);
    assert.ok(messagesA.some((message) => message.content.includes('HOLD_A')));
    assert.ok(messagesB.some((message) => message.content.includes('HOLD_B')));
    assert.ok(messagesA.every((message) => !message.content.includes('HOLD_B')));
    assert.ok(messagesB.every((message) => !message.content.includes('HOLD_A')));
    assert.ok(messagesA.every((message) => !message.content.includes('MUST_NOT_PERSIST')));

    const nextAResponse = await postMessage(
      studio.url,
      headers,
      projectId,
      sessionA,
      'FAST_AFTER_A',
    );
    assert.equal(nextAResponse.status, 200);
    const nextAEvents = await withTimeout(readSseEvents(nextAResponse), RUN_TIMEOUT_MS);
    assert.ok(nextAEvents.some((event) => event.type === 'run.completed'));

    const sessionC = await createSession(studio.url, headers, projectId, 'Session C race');
    const [raceC1, raceC2] = await Promise.all([
      postMessage(studio.url, headers, projectId, sessionC, 'RACE_C_ONE'),
      postMessage(studio.url, headers, projectId, sessionC, 'RACE_C_TWO'),
    ]);
    assert.deepEqual([raceC1.status, raceC2.status].sort(), [200, 409]);
    const activeRace = raceC1.status === 200 ? raceC1 : raceC2;
    const rejectedRace = raceC1.status === 409 ? raceC1 : raceC2;
    const rejectedRaceBody = (await rejectedRace.json()) as Record<string, unknown>;
    assert.equal(rejectedRaceBody.code, 'SESSION_HAS_ACTIVE_RUN');
    const raceRunId = requiredHeader(activeRace, 'x-agent-run-id');
    const cancelRace = await requestJson(
      studio.url,
      sessionRunPath(projectId, sessionC, raceRunId),
      { method: 'DELETE', headers },
    );
    assert.equal(cancelRace.response.status, 202);
    const raceEvents = await withTimeout(readSseEvents(activeRace), RUN_TIMEOUT_MS);
    assert.ok(raceEvents.some((event) => event.type === 'run.cancelled'));
    const messagesC = await getMessages(studio.url, headers, projectId, sessionC);
    const raceUserMessages = messagesC.filter((message) => message.content.includes('RACE_C_'));
    assert.equal(raceUserMessages.length, 1);

    const archiveA = await requestJson(studio.url, sessionPath(projectId, sessionA), {
      method: 'DELETE',
      headers,
    });
    const archiveB = await requestJson(studio.url, sessionPath(projectId, sessionB), {
      method: 'DELETE',
      headers,
    });
    const archiveC = await requestJson(studio.url, sessionPath(projectId, sessionC), {
      method: 'DELETE',
      headers,
    });
    assert.equal(archiveA.response.status, 200);
    assert.equal(archiveB.response.status, 200);
    assert.equal(archiveC.response.status, 200);
  } finally {
    if (projectId) {
      await fetch(`${studio.url}/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'DELETE',
        headers,
      })
        .then((response) => response.text())
        .catch(() => {});
    }
    studio.close();
  }
}

async function withFakeAgentProvider<T>(fn: () => Promise<T>): Promise<T> {
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const fast = raw.includes('FAST_AFTER_A');
      const delayMs = fast ? 20 : 1_000;
      const timer = setTimeout(() => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.write(
          openAiChunk({ role: 'assistant', content: fast ? 'fast reply' : 'held reply' }, null),
        );
        res.write(openAiChunk({}, 'stop'));
        res.end('data: [DONE]\n\n');
      }, delayMs);
      res.once('close', () => clearTimeout(timer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const previous = {
    apiKey: process.env.HV_PI_API_KEY,
    baseUrl: process.env.HV_PI_BASE_URL,
    model: process.env.HV_PI_MODEL,
  };
  process.env.HV_PI_API_KEY = 'phase31-local-test';
  process.env.HV_PI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.HV_PI_MODEL = 'phase31-fake';
  try {
    return await fn();
  } finally {
    restoreEnv('HV_PI_API_KEY', previous.apiKey);
    restoreEnv('HV_PI_BASE_URL', previous.baseUrl);
    restoreEnv('HV_PI_MODEL', previous.model);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function openAiChunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'phase31-fake',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1_000),
    model: 'phase31-fake',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

async function createSession(
  baseUrl: string,
  headers: Record<string, string>,
  projectId: string,
  title: string,
): Promise<string> {
  const result = await requestJson(
    baseUrl,
    `/api/projects/${encodeURIComponent(projectId)}/agent-sessions`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ title, model: 'phase31-fake' }),
    },
  );
  assert.equal(result.response.status, 201);
  return String(asRecord(result.body.session).id);
}

async function postMessage(
  baseUrl: string,
  headers: Record<string, string>,
  projectId: string,
  sessionId: string,
  content: string,
): Promise<Response> {
  return fetch(`${baseUrl}${sessionMessagesPath(projectId, sessionId)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content }),
  });
}

async function getMessages(
  baseUrl: string,
  headers: Record<string, string>,
  projectId: string,
  sessionId: string,
): Promise<Array<{ content: string }>> {
  const result = await requestJson(baseUrl, sessionMessagesPath(projectId, sessionId), { headers });
  assert.equal(result.response.status, 200);
  return result.body.messages as Array<{ content: string }>;
}

async function readSseEvents(response: Response): Promise<Array<Record<string, unknown>>> {
  assert.equal(response.status, 200);
  const text = await response.text();
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

async function requestJson(
  baseUrl: string,
  path: string,
  init: RequestInit,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  return { response, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

function sessionPath(projectId: string, sessionId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/agent-sessions/${encodeURIComponent(sessionId)}`;
}

function sessionMessagesPath(projectId: string, sessionId: string): string {
  return `${sessionPath(projectId, sessionId)}/messages`;
}

function sessionRunPath(projectId: string, sessionId: string, runId: string): string {
  return `${sessionPath(projectId, sessionId)}/agent-runs/${encodeURIComponent(runId)}`;
}

function sessionRunEventsPath(projectId: string, sessionId: string, runId: string): string {
  return `${sessionRunPath(projectId, sessionId, runId)}/events`;
}

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  assert.ok(value, `Missing ${name} response header`);
  return value;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
