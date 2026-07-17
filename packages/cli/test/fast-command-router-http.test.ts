import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileProjectPersistence, ProjectStore } from '@html-video/core';

import { bootstrap } from '../dist/context.js';
import { startStudioServer } from '../dist/studio-server.js';

const ALBUM_HTML = `<!doctype html><html><head><style>.title{animation:rise 1s}</style></head><body>
<main id="album">
  <section data-album-page="page_1"><h1 data-hv-text="page_1.title">第一页</h1></section>
  <section data-album-page="page_2"><h1 class="title" data-hv-text="page_2.title">核心性能<br>全面领先</h1></section>
</main><script>window.keepAnimation = true;</script></body></html>`;

test('Fast Command Router reuses Session Run/SSE and falls back to Agent only for not_handled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'html-video-fast-command-http-'));
  const fake = await startFakeAgentProvider();
  const ctx = await bootstrap({
    cwd: root,
    projects: new FileProjectPersistence(new ProjectStore(root)),
  });
  const studio = await startStudioServer(ctx, 0, '127.0.0.1');
  const headers = {
    'content-type': 'application/json',
    'x-user-id': `fast-command-${Date.now()}`,
  };
  try {
    const created = await requestJson(studio.url, '/api/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Fast command HTTP acceptance' }),
    });
    assert.equal(created.response.status, 200);
    const projectId = String(asRecord(created.body.project).id);
    await ctx.orchestrator.writePreviewHtmlRaw(projectId, ALBUM_HTML);

    const sessionA = await createSession(studio.url, headers, projectId, 'Session A');
    await putViewState(studio.url, headers, projectId, sessionA, 1);

    const fastResponse = await postSessionMessage(
      studio.url,
      headers,
      projectId,
      sessionA,
      '第二页的全面领先，改为遥遥领先',
    );
    const fastRunId = requiredHeader(fastResponse, 'x-agent-run-id');
    const fastEvents = await readSseEvents(fastResponse);
    assert.deepEqual(fastEvents.map((event) => event.type), [
      'run.started',
      'tool.call.started',
      'tool.call.completed',
      'album.changed',
      'preview.ready',
      'assistant.completed',
      'run.completed',
    ]);
    assert.ok(fastEvents.every((event) => event.runId === fastRunId));
    assert.ok(fastEvents.every((event) => event.sessionId === sessionA));
    assert.equal(asRecord(fastEvents[0]?.data).executor, 'deterministic');
    assert.equal(asRecord(fastEvents[1]?.data).name, 'replace_album_text');
    assert.equal(fake.calls(), 0, 'handled fast command must not initialize the model provider');

    const messagesA = await getMessages(studio.url, headers, projectId, sessionA);
    assert.deepEqual(messagesA.map((message) => message.role), ['user', 'tool', 'assistant']);
    assert.ok(messagesA.every((message) => message.sessionId === sessionA));
    assert.ok(messagesA.every((message) => message.runId === fastRunId));
    assert.equal(messagesA[1]?.tool, 'replace_album_text');

    const timingResults: Array<Record<string, unknown>> = [fastTiming(fastEvents, 'replace_text')];

    const namedColorResponse = await postSessionMessage(
      studio.url,
      headers,
      projectId,
      sessionA,
      '第二页的遥遥领先字体改为红色',
    );
    const namedColorEvents = await readSseEvents(namedColorResponse);
    const namedColorTiming = fastTiming(namedColorEvents, 'set_text_color');
    assert.equal(namedColorTiming.strategy, 'wrap_text_node_with_color_span');
    assert.equal(fake.calls(), 0);
    timingResults.push(namedColorTiming);
    assert.match(
      await ctx.orchestrator.readRawHtml(projectId) ?? '',
      /核心性能<br><span style="color:#FF0000">遥遥领先<\/span>/,
    );

    const hexColorResponse = await postSessionMessage(
      studio.url,
      headers,
      projectId,
      sessionA,
      '第二页的遥遥领先字体改为 #FF5A36',
    );
    const hexColorEvents = await readSseEvents(hexColorResponse);
    const hexColorTiming = fastTiming(hexColorEvents, 'set_text_color');
    assert.equal(hexColorTiming.strategy, 'update_controlled_color_span');
    assert.equal(fake.calls(), 0);
    timingResults.push(hexColorTiming);
    const recoloredHtml = await ctx.orchestrator.readRawHtml(projectId) ?? '';
    assert.match(recoloredHtml, /核心性能<br><span style="color:#FF5A36">遥遥领先<\/span>/);
    assert.doesNotMatch(recoloredHtml, /<span style="color:#FF0000"><span/);
    process.stdout.write(`[fast-command-http-timing] ${JSON.stringify(timingResults)}\n`);
    const refreshedSessions = await listSessions(studio.url, headers, projectId);
    const refreshedSessionA = refreshedSessions.find((item) => item.id === sessionA);
    assert.equal(refreshedSessionA?.active_run, null);
    const refreshedViewA = await getViewState(studio.url, headers, projectId, sessionA);
    assert.equal(refreshedViewA.activePageIndex, 1);
    assert.equal(refreshedViewA.previewRevision, 3);
    const refreshedMessagesA = await getMessages(studio.url, headers, projectId, sessionA);
    const lastTool = [...refreshedMessagesA].reverse().find((message) => message.role === 'tool');
    assert.equal(asRecord(asRecord(lastTool?.output).details).executor, 'deterministic');
    assert.equal(asRecord(asRecord(lastTool?.output).details).revision, 3);

    const replay = await fetch(
      `${studio.url}${sessionRunEventsPath(projectId, sessionA, fastRunId)}?after=3`,
      { headers },
    ).then(readSseEvents);
    assert.deepEqual(replay.map((event) => event.sequence), [4, 5, 6, 7]);

    const fallbackResponse = await postSessionMessage(
      studio.url,
      headers,
      projectId,
      sessionA,
      '第二页做得更有科技感',
    );
    const fallbackEvents = await readSseEvents(fallbackResponse);
    assert.ok(fallbackEvents.some((event) => event.type === 'assistant.completed'));
    assert.ok(fallbackEvents.some((event) => event.type === 'run.completed'));
    assert.notEqual(asRecord(fallbackEvents[0]?.data).executor, 'deterministic');
    assert.equal(fake.calls(), 1, 'not_handled must retain the existing Agent path');

    const legacyResponse = await fetch(`${studio.url}/api/projects/${projectId}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: '第二页的遥遥领先改为领先未来' }),
    });
    assert.equal(requiredHeader(legacyResponse, 'x-agent-session-id'), sessionA);
    const legacyEvents = await readSseEvents(legacyResponse);
    assert.equal(asRecord(legacyEvents[0]?.data).executor, 'deterministic');
    assert.equal(fake.calls(), 1, 'legacy default Session fast command must also bypass the model');

    const htmlBeforeUnprovenRequests = await ctx.orchestrator.readRawHtml(projectId);
    for (const request of [
      '第一页背景色换成渐变色，上面蓝色，渐变为白色',
      '第一页的完全不存再改成红色',
    ]) {
      const callsBeforeRequest = fake.calls();
      const response = await postSessionMessage(studio.url, headers, projectId, sessionA, request);
      const events = await readSseEvents(response);
      assert.notEqual(asRecord(events[0]?.data).executor, 'deterministic');
      assert.equal(fake.calls(), callsBeforeRequest + 1, `${request} must fall back to the Agent`);
      assert.equal(await ctx.orchestrator.readRawHtml(projectId), htmlBeforeUnprovenRequests);
    }

    await verifySameSessionRunExclusion({
      ctx,
      baseUrl: studio.url,
      headers,
      projectId,
      sessionId: sessionA,
    });
    await verifyFastRunCancellation({
      ctx,
      baseUrl: studio.url,
      headers,
      projectId,
      sessionId: sessionA,
      providerCalls: fake.calls,
    });

    await verifyCurrentPageAliasBypassesAgent({
      ctx,
      baseUrl: studio.url,
      headers,
      providerCalls: fake.calls,
    });
    await verifySamePageTextTargetConfirmation({
      ctx,
      baseUrl: studio.url,
      headers,
      providerCalls: fake.calls,
    });
    await verifyPageMismatchConfirmation({
      ctx,
      baseUrl: studio.url,
      headers,
      providerCalls: fake.calls,
    });

    const sessionB = await createSession(studio.url, headers, projectId, 'Session B');
    assert.deepEqual(await getMessages(studio.url, headers, projectId, sessionB), []);
    await putViewState(studio.url, headers, projectId, sessionB, 0);
    const sessionBView = await getViewState(studio.url, headers, projectId, sessionB);
    assert.equal(sessionBView.activePageIndex, 0);
    assert.equal(sessionBView.previewRevision, 0);
    const finalHtml = await ctx.orchestrator.readRawHtml(projectId) ?? '';
    assert.match(finalHtml, /核心性能<br><span style="color:#FF5A36">最终领先<\/span>/);
    assert.match(finalHtml, /window\.keepAnimation = true/);

    await verifyCrossSessionRevisionConflict({
      ctx,
      baseUrl: studio.url,
      headers,
      providerCalls: fake.calls,
    });
    await verifyAmbiguousTextRequestsConfirmationWithoutMutation({
      ctx,
      baseUrl: studio.url,
      headers,
      providerCalls: fake.calls,
    });
  } finally {
    await studio.close();
    await fake.close();
    await rm(root, { recursive: true, force: true });
  }
});

function fastTiming(events: Array<Record<string, unknown>>, operation: string): Record<string, unknown> {
  const started = events.find((event) => event.type === 'run.started');
  const completed = events.find((event) => event.type === 'tool.call.completed');
  assert.equal(asRecord(started?.data).executor, 'deterministic');
  const details = asRecord(asRecord(asRecord(completed?.data).output).details);
  assert.equal(details.executor, 'deterministic');
  assert.equal(details.operation, operation);
  assert.deepEqual(details.changed_pages, [2]);
  const duration = Number(details.duration_ms);
  assert.ok(Number.isFinite(duration) && duration >= 0 && duration < 1_000, `duration=${duration}`);
  return {
    operation,
    executor: details.executor,
    strategy: details.strategy,
    duration_ms: duration,
  };
}

async function verifySamePageTextTargetConfirmation(args: {
  ctx: Awaited<ReturnType<typeof bootstrap>>;
  baseUrl: string;
  headers: Record<string, string>;
  providerCalls: () => number;
}): Promise<void> {
  const created = await requestJson(args.baseUrl, '/api/projects', {
    method: 'POST', headers: args.headers, body: JSON.stringify({ name: 'Same-page text confirmation' }),
  });
  const projectId = String(asRecord(created.body.project).id);
  const html = `<!doctype html><html><body><main>
    <section data-album-page="page_1"><h1 data-hv-text="page_1.title">One</h1></section>
    <section data-album-page="page_2"><h1 data-hv-text="page_2.title">Two</h1></section>
    <section data-album-page="page_3">
      <h1 data-hv-text="page_3.title">开启你的 SU7 之旅</h1>
      <p data-hv-text="page_3.subtitle">亲身感受小米 SU7 带来的极致体验</p>
      <p data-hv-text="page_3.email">su7@xiaomi.com</p>
      <p data-hv-text="page_3.footer_right">SU7 · 官方宣传</p>
    </section></main></body></html>`;
  await args.ctx.orchestrator.writePreviewHtmlRaw(projectId, html);
  const sessionA = await createSession(args.baseUrl, args.headers, projectId, 'Text target A');
  const sessionB = await createSession(args.baseUrl, args.headers, projectId, 'Text target B');
  await Promise.all([
    putViewState(args.baseUrl, args.headers, projectId, sessionA, 2),
    putViewState(args.baseUrl, args.headers, projectId, sessionB, 2),
  ]);
  const callsBefore = args.providerCalls();

  const ambiguousEvents = await postSessionMessage(
    args.baseUrl, args.headers, projectId, sessionA, '把 su7 改为蓝色',
  ).then(readSseEvents);
  const ambiguousDetails = asRecord(asRecord(asRecord(
    ambiguousEvents.find((event) => event.type === 'tool.call.completed')?.data,
  ).output).details);
  assert.equal(ambiguousDetails.code, 'TEXT_TARGET_AMBIGUOUS');
  assert.equal(ambiguousDetails.confirmation_kind, 'simple_text_target');
  assert.equal(ambiguousDetails.requested_page, 3);
  assert.equal(ambiguousDetails.strategy, 'locate_text_same_page');
  assert.equal(args.providerCalls(), callsBefore, 'ambiguous deterministic routing must not call the model');
  const candidates = ambiguousDetails.candidates as Array<Record<string, unknown>>;
  assert.equal(candidates.length, 4);
  assert.deepEqual(candidates.map((candidate) => candidate.matched_text), ['SU7', 'SU7', 'su7', 'SU7']);
  assert.ok(candidates.every((candidate) => !('source_range' in candidate) && !('source_hash' in candidate)));
  const actionId = String(ambiguousDetails.action_id);
  const titleId = String(candidates.find(
    (candidate) => candidate.data_hv_text_key === 'page_3.title',
  )?.candidate_id);

  const sessions = await listSessions(args.baseUrl, args.headers, projectId);
  const pendingA = asRecord(sessions.find((session) => session.id === sessionA)?.pending_confirmation);
  assert.equal(pendingA.kind, 'simple_text_target');
  assert.equal(pendingA.code, 'TEXT_TARGET_AMBIGUOUS');
  assert.equal((pendingA.candidates as unknown[]).length, 4);
  assert.equal(sessions.find((session) => session.id === sessionB)?.pending_confirmation, null);

  const crossSessionEvents = await postSessionMessage(
    args.baseUrl, args.headers, projectId, sessionB, `[fast-text-confirm:${actionId}:${titleId}]`,
  ).then(readSseEvents);
  const crossSessionDetails = asRecord(asRecord(asRecord(
    crossSessionEvents.find((event) => event.type === 'tool.call.completed')?.data,
  ).output).details);
  assert.equal(crossSessionDetails.code, 'CONFIRMATION_NOT_FOUND');
  assert.equal(await args.ctx.orchestrator.readRawHtml(projectId), html);

  const selectedEvents = await postSessionMessage(
    args.baseUrl, args.headers, projectId, sessionA, `[fast-text-confirm:${actionId}:${titleId}]`,
  ).then(readSseEvents);
  assert.ok(selectedEvents.some((event) => event.type === 'preview.ready'));
  let updatedHtml = await args.ctx.orchestrator.readRawHtml(projectId) ?? '';
  assert.match(updatedHtml, /开启你的 <span style="color:#0000FF">SU7<\/span> 之旅/);
  assert.equal((updatedHtml.match(/style="color:#0000FF"/g) ?? []).length, 1);
  assert.equal((await args.ctx.orchestrator.load(projectId)).albumRevision, 1);

  const allPendingEvents = await postSessionMessage(
    args.baseUrl, args.headers, projectId, sessionA, '把 su7 改为蓝色',
  ).then(readSseEvents);
  const allPendingDetails = asRecord(asRecord(asRecord(
    allPendingEvents.find((event) => event.type === 'tool.call.completed')?.data,
  ).output).details);
  const allActionId = String(allPendingDetails.action_id);
  await postSessionMessage(
    args.baseUrl, args.headers, projectId, sessionA, `[fast-text-confirm:${allActionId}:all]`,
  ).then(readSseEvents);
  updatedHtml = await args.ctx.orchestrator.readRawHtml(projectId) ?? '';
  assert.equal((updatedHtml.match(/style="color:#0000FF"/g) ?? []).length, 4);
  assert.equal((await args.ctx.orchestrator.load(projectId)).albumRevision, 2);
  assert.equal(args.providerCalls(), callsBefore);
}

async function verifyCurrentPageAliasBypassesAgent(args: {
  ctx: Awaited<ReturnType<typeof bootstrap>>;
  baseUrl: string;
  headers: Record<string, string>;
  providerCalls: () => number;
}): Promise<void> {
  const created = await requestJson(args.baseUrl, '/api/projects', {
    method: 'POST',
    headers: args.headers,
    body: JSON.stringify({ name: 'Current page fast command acceptance' }),
  });
  const projectId = String(asRecord(created.body.project).id);
  await args.ctx.orchestrator.writePreviewHtmlRaw(projectId, ALBUM_HTML);
  const sessionId = await createSession(args.baseUrl, args.headers, projectId, 'Current page Session');
  await putViewState(args.baseUrl, args.headers, projectId, sessionId, 1);
  const callsBefore = args.providerCalls();

  const response = await postSessionMessage(
    args.baseUrl,
    args.headers,
    projectId,
    sessionId,
    '这一页的核心性能改为红色',
  );
  const events = await readSseEvents(response);
  assert.equal(asRecord(events[0]?.data).executor, 'deterministic');
  assert.equal(asRecord(events[1]?.data).name, 'set_album_text_color');
  assert.equal(args.providerCalls(), callsBefore, '这一页 must bypass the model');
  assert.match(
    await args.ctx.orchestrator.readRawHtml(projectId) ?? '',
    /<span style="color:#FF0000">核心性能<\/span><br>全面领先/,
  );
}

async function verifyPageMismatchConfirmation(args: {
  ctx: Awaited<ReturnType<typeof bootstrap>>;
  baseUrl: string;
  headers: Record<string, string>;
  providerCalls: () => number;
}): Promise<void> {
  const created = await requestJson(args.baseUrl, '/api/projects', {
    method: 'POST',
    headers: args.headers,
    body: JSON.stringify({ name: 'Page mismatch confirmation acceptance' }),
  });
  const projectId = String(asRecord(created.body.project).id);
  await args.ctx.orchestrator.writePreviewHtmlRaw(projectId, ALBUM_HTML);
  const sessionA = await createSession(args.baseUrl, args.headers, projectId, 'Mismatch A');
  const sessionB = await createSession(args.baseUrl, args.headers, projectId, 'Mismatch B');
  const callsBefore = args.providerCalls();
  const before = await args.ctx.orchestrator.readRawHtml(projectId);

  const mismatchResponse = await postSessionMessage(
    args.baseUrl,
    args.headers,
    projectId,
    sessionA,
    '把第一页的核心性能改成红色',
  );
  const mismatchEvents = await readSseEvents(mismatchResponse);
  assert.deepEqual(mismatchEvents.map((event) => event.type), [
    'run.started',
    'tool.call.started',
    'tool.call.completed',
    'assistant.completed',
    'run.completed',
  ]);
  assert.equal(asRecord(mismatchEvents[0]?.data).executor, 'deterministic');
  assert.equal(asRecord(mismatchEvents[1]?.data).name, 'locate_album_text');
  const mismatchDetails = asRecord(asRecord(asRecord(mismatchEvents[2]?.data).output).details);
  assert.equal(mismatchDetails.code, 'PAGE_TARGET_MISMATCH');
  assert.equal(mismatchDetails.strategy, 'locate_text_cross_page');
  assert.equal(mismatchDetails.requested_page, 1);
  assert.equal(mismatchDetails.suggested_page, 2);
  assert.deepEqual(mismatchDetails.candidate_pages, [2]);
  assert.equal(args.providerCalls(), callsBefore);
  assert.equal(await args.ctx.orchestrator.readRawHtml(projectId), before);
  assert.equal((await args.ctx.orchestrator.load(projectId)).albumRevision ?? 0, 0);
  const actionId = String(mismatchDetails.action_id);

  let sessions = await listSessions(args.baseUrl, args.headers, projectId);
  const publicA = sessions.find((session) => session.id === sessionA);
  const publicB = sessions.find((session) => session.id === sessionB);
  assert.equal(asRecord(publicA?.pending_confirmation).kind, 'simple_page_target');
  assert.equal(asRecord(publicA?.pending_confirmation).action_id, actionId);
  assert.deepEqual(asRecord(publicA?.pending_confirmation).candidate_pages, [2]);
  assert.equal(publicB?.pending_confirmation, null);

  const crossSessionResponse = await postSessionMessage(
    args.baseUrl,
    args.headers,
    projectId,
    sessionB,
    `[fast-page-confirm:${actionId}:apply:2]`,
  );
  const crossSessionEvents = await readSseEvents(crossSessionResponse);
  const crossSessionDetails = asRecord(asRecord(asRecord(
    crossSessionEvents.find((event) => event.type === 'tool.call.completed')?.data,
  ).output).details);
  assert.equal(crossSessionDetails.code, 'CONFIRMATION_NOT_FOUND');
  assert.equal(args.providerCalls(), callsBefore);
  assert.equal(await args.ctx.orchestrator.readRawHtml(projectId), before);

  const confirmResponse = await postSessionMessage(
    args.baseUrl,
    args.headers,
    projectId,
    sessionA,
    `[fast-page-confirm:${actionId}:apply:2]`,
  );
  const confirmEvents = await readSseEvents(confirmResponse);
  assert.equal(asRecord(confirmEvents[0]?.data).executor, 'deterministic');
  assert.equal(asRecord(confirmEvents[1]?.data).name, 'set_album_text_color');
  assert.ok(confirmEvents.some((event) => event.type === 'album.changed'));
  assert.ok(confirmEvents.some((event) => event.type === 'preview.ready'));
  assert.equal(args.providerCalls(), callsBefore);
  assert.match(
    await args.ctx.orchestrator.readRawHtml(projectId) ?? '',
    /<span style="color:#FF0000">核心性能<\/span><br>全面领先/,
  );
  sessions = await listSessions(args.baseUrl, args.headers, projectId);
  assert.equal(sessions.find((session) => session.id === sessionA)?.pending_confirmation, null);

  const cancelPendingResponse = await postSessionMessage(
    args.baseUrl,
    args.headers,
    projectId,
    sessionA,
    '把第一页的全面领先改成红色',
  );
  const cancelPendingEvents = await readSseEvents(cancelPendingResponse);
  const cancelPendingDetails = asRecord(asRecord(asRecord(
    cancelPendingEvents.find((event) => event.type === 'tool.call.completed')?.data,
  ).output).details);
  const cancelActionId = String(cancelPendingDetails.action_id);
  const beforeCancel = await args.ctx.orchestrator.readRawHtml(projectId);
  const revisionBeforeCancel = (await args.ctx.orchestrator.load(projectId)).albumRevision;
  const cancelResponse = await postSessionMessage(
    args.baseUrl,
    args.headers,
    projectId,
    sessionA,
    `[fast-page-confirm:${cancelActionId}:cancel]`,
  );
  const cancelEvents = await readSseEvents(cancelResponse);
  const cancelDetails = asRecord(asRecord(asRecord(
    cancelEvents.find((event) => event.type === 'tool.call.completed')?.data,
  ).output).details);
  assert.equal(cancelDetails.code, 'PAGE_TARGET_CONFIRMATION_CANCELLED');
  assert.equal(await args.ctx.orchestrator.readRawHtml(projectId), beforeCancel);
  assert.equal((await args.ctx.orchestrator.load(projectId)).albumRevision, revisionBeforeCancel);
  assert.equal(args.providerCalls(), callsBefore);

  const keepPendingEvents = await postSessionMessage(
    args.baseUrl, args.headers, projectId, sessionA, '把第一页的全面领先改成红色',
  ).then(readSseEvents);
  const keepPendingDetails = asRecord(asRecord(asRecord(
    keepPendingEvents.find((event) => event.type === 'tool.call.completed')?.data,
  ).output).details);
  const keepEvents = await postSessionMessage(
    args.baseUrl,
    args.headers,
    projectId,
    sessionA,
    `[fast-page-confirm:${String(keepPendingDetails.action_id)}:keep]`,
  ).then(readSseEvents);
  const keepDetails = asRecord(asRecord(asRecord(
    keepEvents.find((event) => event.type === 'tool.call.completed')?.data,
  ).output).details);
  assert.equal(keepDetails.code, 'REQUESTED_PAGE_TARGET_NOT_FOUND');
  assert.equal(args.providerCalls(), callsBefore);

  for (const request of [
    '把第一页的“完全不存在”改成红色',
    '就是第一页，把全面领先改成红色',
  ]) {
    const response = await postSessionMessage(args.baseUrl, args.headers, projectId, sessionA, request);
    const events = await readSseEvents(response);
    const details = asRecord(asRecord(asRecord(
      events.find((event) => event.type === 'tool.call.completed')?.data,
    ).output).details);
    assert.equal(details.code, 'TARGET_TEXT_NOT_FOUND');
    assert.equal(asRecord(events[0]?.data).executor, 'deterministic');
    assert.equal(args.providerCalls(), callsBefore);
  }

  await verifyPageMismatchRevisionConflict(args, callsBefore);
  await verifyMultiplePageCandidates(args, callsBefore);
}

async function verifyPageMismatchRevisionConflict(
  args: {
    ctx: Awaited<ReturnType<typeof bootstrap>>;
    baseUrl: string;
    headers: Record<string, string>;
    providerCalls: () => number;
  },
  callsBefore: number,
): Promise<void> {
  const created = await requestJson(args.baseUrl, '/api/projects', {
    method: 'POST', headers: args.headers, body: JSON.stringify({ name: 'Mismatch revision conflict' }),
  });
  const projectId = String(asRecord(created.body.project).id);
  await args.ctx.orchestrator.writePreviewHtmlRaw(projectId, ALBUM_HTML);
  const sessionA = await createSession(args.baseUrl, args.headers, projectId, 'Conflict confirmation A');
  const sessionB = await createSession(args.baseUrl, args.headers, projectId, 'Conflict confirmation B');
  const pendingEvents = await postSessionMessage(
    args.baseUrl, args.headers, projectId, sessionA, '把第一页的核心性能改成红色',
  ).then(readSseEvents);
  const pendingDetails = asRecord(asRecord(asRecord(
    pendingEvents.find((event) => event.type === 'tool.call.completed')?.data,
  ).output).details);
  const actionId = String(pendingDetails.action_id);
  await postSessionMessage(
    args.baseUrl, args.headers, projectId, sessionB, '第二页的全面领先改成遥遥领先',
  ).then(readSseEvents);
  const conflictEvents = await postSessionMessage(
    args.baseUrl, args.headers, projectId, sessionA, `[fast-page-confirm:${actionId}:apply:2]`,
  ).then(readSseEvents);
  const conflictDetails = asRecord(asRecord(asRecord(
    conflictEvents.find((event) => event.type === 'tool.call.completed')?.data,
  ).output).details);
  assert.equal(conflictDetails.code, 'ALBUM_REVISION_CONFLICT');
  assert.equal(conflictDetails.expected_revision, 0);
  assert.equal(conflictDetails.current_revision, 1);
  assert.equal(args.providerCalls(), callsBefore);
  assert.equal(
    (await listSessions(args.baseUrl, args.headers, projectId))
      .find((session) => session.id === sessionA)?.pending_confirmation,
    null,
  );
}

async function verifyMultiplePageCandidates(
  args: {
    ctx: Awaited<ReturnType<typeof bootstrap>>;
    baseUrl: string;
    headers: Record<string, string>;
    providerCalls: () => number;
  },
  callsBefore: number,
): Promise<void> {
  const created = await requestJson(args.baseUrl, '/api/projects', {
    method: 'POST', headers: args.headers, body: JSON.stringify({ name: 'Multiple page candidates' }),
  });
  const projectId = String(asRecord(created.body.project).id);
  const html = ALBUM_HTML.replace(
    '</main>',
    '<section data-album-page="page_3"><h1 data-hv-text="page_3.title">核心性能</h1></section></main>',
  );
  await args.ctx.orchestrator.writePreviewHtmlRaw(projectId, html);
  const sessionId = await createSession(args.baseUrl, args.headers, projectId, 'Multiple candidates');
  const events = await postSessionMessage(
    args.baseUrl, args.headers, projectId, sessionId, '把第一页的核心性能改成红色',
  ).then(readSseEvents);
  const details = asRecord(asRecord(asRecord(
    events.find((event) => event.type === 'tool.call.completed')?.data,
  ).output).details);
  assert.equal(details.code, 'PAGE_TARGET_MISMATCH');
  assert.equal(details.suggested_page, null);
  assert.deepEqual(details.candidate_pages, [2, 3]);
  assert.equal(await args.ctx.orchestrator.readRawHtml(projectId), html);
  assert.equal(args.providerCalls(), callsBefore);
}

async function verifyCrossSessionRevisionConflict(args: {
  ctx: Awaited<ReturnType<typeof bootstrap>>;
  baseUrl: string;
  headers: Record<string, string>;
  providerCalls: () => number;
}): Promise<void> {
  const created = await requestJson(args.baseUrl, '/api/projects', {
    method: 'POST',
    headers: args.headers,
    body: JSON.stringify({ name: 'Revision conflict acceptance' }),
  });
  const projectId = String(asRecord(created.body.project).id);
  await args.ctx.orchestrator.writePreviewHtmlRaw(projectId, ALBUM_HTML);
  const sessionA = await createSession(args.baseUrl, args.headers, projectId, 'Conflict A');
  const sessionB = await createSession(args.baseUrl, args.headers, projectId, 'Conflict B');
  await Promise.all([
    putViewState(args.baseUrl, args.headers, projectId, sessionA, 1),
    putViewState(args.baseUrl, args.headers, projectId, sessionB, 1),
  ]);

  const callsBefore = args.providerCalls();
  const originalRead = args.ctx.orchestrator.readRawHtml.bind(args.ctx.orchestrator);
  const originalWrite = args.ctx.orchestrator.writePreviewHtmlRawIfRevision.bind(args.ctx.orchestrator);
  let readCount = 0;
  let markSecondSnapshot!: () => void;
  const secondSnapshot = new Promise<void>((resolve) => { markSecondSnapshot = resolve; });
  let releaseWrite!: () => void;
  let markWriteEntered!: () => void;
  const writeEntered = new Promise<void>((resolve) => { markWriteEntered = resolve; });
  const writeReleased = new Promise<void>((resolve) => { releaseWrite = resolve; });
  args.ctx.orchestrator.readRawHtml = async (...params) => {
    const value = await originalRead(...params);
    readCount += 1;
    if (readCount >= 3) markSecondSnapshot();
    return value;
  };
  args.ctx.orchestrator.writePreviewHtmlRawIfRevision = async (...params) => {
    markWriteEntered();
    await writeReleased;
    return originalWrite(...params);
  };
  try {
    const firstPromise = postSessionMessage(
      args.baseUrl,
      args.headers,
      projectId,
      sessionA,
      '第二页的全面领先改为遥遥领先',
    );
    await writeEntered;
    const secondPromise = postSessionMessage(
      args.baseUrl,
      args.headers,
      projectId,
      sessionB,
      '第二页的全面领先改为领先未来',
    );
    await secondSnapshot;
    releaseWrite();
    const [firstEvents, secondEvents] = await Promise.all([
      firstPromise.then(readSseEvents),
      secondPromise.then(readSseEvents),
    ]);
    const eventSets = [firstEvents, secondEvents];
    const conflictEvents = eventSets.find((events) =>
      events.some((event) => {
        if (event.type !== 'tool.call.completed') return false;
        const details = asRecord(asRecord(asRecord(event.data).output).details);
        return details.code === 'ALBUM_REVISION_CONFLICT';
      }));
    assert.ok(conflictEvents, 'one sibling Session must receive a stable revision conflict');
    const conflictTool = conflictEvents.find((event) => event.type === 'tool.call.completed');
    const conflictDetails = asRecord(asRecord(asRecord(conflictTool?.data).output).details);
    assert.equal(conflictDetails.code, 'ALBUM_REVISION_CONFLICT');
    assert.equal(conflictDetails.expected_revision, 0);
    assert.equal(conflictDetails.current_revision, 1);
    assert.equal(conflictDetails.executor, 'deterministic');
    assert.equal(args.providerCalls(), callsBefore);
    assert.equal((await args.ctx.orchestrator.load(projectId)).albumRevision, 1);
  } finally {
    releaseWrite();
    args.ctx.orchestrator.readRawHtml = originalRead;
    args.ctx.orchestrator.writePreviewHtmlRawIfRevision = originalWrite;
  }
}

async function verifyAmbiguousTextRequestsConfirmationWithoutMutation(args: {
  ctx: Awaited<ReturnType<typeof bootstrap>>;
  baseUrl: string;
  headers: Record<string, string>;
  providerCalls: () => number;
}): Promise<void> {
  const created = await requestJson(args.baseUrl, '/api/projects', {
    method: 'POST',
    headers: args.headers,
    body: JSON.stringify({ name: 'Ambiguous target acceptance' }),
  });
  const projectId = String(asRecord(created.body.project).id);
  const ambiguousHtml = ALBUM_HTML.replace('核心性能<br>全面领先', '全面领先<br>全面领先');
  await args.ctx.orchestrator.writePreviewHtmlRaw(projectId, ambiguousHtml);
  const sessionId = await createSession(args.baseUrl, args.headers, projectId, 'Ambiguous');
  await putViewState(args.baseUrl, args.headers, projectId, sessionId, 1);
  const callsBefore = args.providerCalls();
  const response = await postSessionMessage(
    args.baseUrl,
    args.headers,
    projectId,
    sessionId,
    '第二页的全面领先改为遥遥领先',
  );
  const events = await readSseEvents(response);
  assert.equal(asRecord(events[0]?.data).executor, 'deterministic');
  const details = asRecord(asRecord(asRecord(
    events.find((event) => event.type === 'tool.call.completed')?.data,
  ).output).details);
  assert.equal(details.code, 'TEXT_TARGET_AMBIGUOUS');
  assert.equal((details.candidates as unknown[]).length, 2);
  assert.equal(args.providerCalls(), callsBefore);
  assert.equal(await args.ctx.orchestrator.readRawHtml(projectId), ambiguousHtml);
  assert.equal((await args.ctx.orchestrator.load(projectId)).albumRevision ?? 0, 0);
}

async function verifySameSessionRunExclusion(args: {
  ctx: Awaited<ReturnType<typeof bootstrap>>;
  baseUrl: string;
  headers: Record<string, string>;
  projectId: string;
  sessionId: string;
}): Promise<void> {
  const originalWrite = args.ctx.orchestrator.writePreviewHtmlRawIfRevision.bind(args.ctx.orchestrator);
  let releaseWrite!: () => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const released = new Promise<void>((resolve) => { releaseWrite = resolve; });
  args.ctx.orchestrator.writePreviewHtmlRawIfRevision = async (...params) => {
    markEntered();
    await released;
    return originalWrite(...params);
  };
  try {
    const firstPromise = postSessionMessage(
      args.baseUrl,
      args.headers,
      args.projectId,
      args.sessionId,
      '第二页的领先未来改为最终领先',
    );
    await entered;
    const rejected = await requestJson(
      args.baseUrl,
      sessionMessagesPath(args.projectId, args.sessionId),
      {
        method: 'POST',
        headers: args.headers,
        body: JSON.stringify({ content: '第二页的领先未来改为不应写入' }),
      },
    );
    assert.equal(rejected.response.status, 409);
    assert.equal(rejected.body.code, 'SESSION_HAS_ACTIVE_RUN');
    releaseWrite();
    const firstEvents = await firstPromise.then(readSseEvents);
    assert.ok(firstEvents.some((event) => event.type === 'run.completed'));
  } finally {
    releaseWrite();
    args.ctx.orchestrator.writePreviewHtmlRawIfRevision = originalWrite;
  }
}

async function verifyFastRunCancellation(args: {
  ctx: Awaited<ReturnType<typeof bootstrap>>;
  baseUrl: string;
  headers: Record<string, string>;
  projectId: string;
  sessionId: string;
  providerCalls: () => number;
}): Promise<void> {
  const before = await args.ctx.orchestrator.readRawHtml(args.projectId);
  const callsBefore = args.providerCalls();
  const originalRead = args.ctx.orchestrator.readRawHtml.bind(args.ctx.orchestrator);
  let releaseRead!: () => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const released = new Promise<void>((resolve) => { releaseRead = resolve; });
  let block = true;
  args.ctx.orchestrator.readRawHtml = async (...params) => {
    if (block) {
      block = false;
      markEntered();
      await released;
    }
    return originalRead(...params);
  };
  try {
    const responsePromise = postSessionMessage(
      args.baseUrl,
      args.headers,
      args.projectId,
      args.sessionId,
      '第二页的最终领先改为取消文字',
    );
    await entered;
    const sessions = await listSessions(args.baseUrl, args.headers, args.projectId);
    const session = sessions.find((item) => item.id === args.sessionId);
    const activeRunId = String(asRecord(session?.active_run).run_id);
    const cancelled = await requestJson(
      args.baseUrl,
      sessionRunPath(args.projectId, args.sessionId, activeRunId),
      { method: 'DELETE', headers: args.headers },
    );
    assert.equal(cancelled.response.status, 202);
    releaseRead();
    const events = await responsePromise.then(readSseEvents);
    assert.ok(events.some((event) => event.type === 'run.cancelled'));
    assert.equal(args.providerCalls(), callsBefore);
    assert.equal(await originalRead(args.projectId), before);
  } finally {
    releaseRead();
    args.ctx.orchestrator.readRawHtml = originalRead;
  }
}

async function startFakeAgentProvider(): Promise<{
  calls: () => number;
  close: () => Promise<void>;
}> {
  let callCount = 0;
  const server = createServer((req, res) => {
    callCount += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write(openAiChunk({ role: 'assistant', content: '这是 Agent 回退回复。' }, null));
      res.write(openAiChunk({}, 'stop'));
      res.end('data: [DONE]\n\n');
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
  process.env.HV_PI_API_KEY = 'fast-command-test';
  process.env.HV_PI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.HV_PI_MODEL = 'fast-command-fake';
  return {
    calls: () => callCount,
    close: async () => {
      restoreEnv('HV_PI_API_KEY', previous.apiKey);
      restoreEnv('HV_PI_BASE_URL', previous.baseUrl);
      restoreEnv('HV_PI_MODEL', previous.model);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function openAiChunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'fast-command-fake',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1_000),
    model: 'fast-command-fake',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

async function createSession(
  baseUrl: string,
  headers: Record<string, string>,
  projectId: string,
  title: string,
): Promise<string> {
  const result = await requestJson(baseUrl, sessionsPath(projectId), {
    method: 'POST',
    headers,
    body: JSON.stringify({ title, model: 'fast-command-fake' }),
  });
  assert.equal(result.response.status, 201);
  return String(asRecord(result.body.session).id);
}

async function putViewState(
  baseUrl: string,
  headers: Record<string, string>,
  projectId: string,
  sessionId: string,
  activePageIndex: number,
): Promise<void> {
  const result = await requestJson(baseUrl, `${sessionPath(projectId, sessionId)}/view-state`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      view_state: { activePageIndex, pageCount: 2, previewRevision: 0, clientRevision: 1 },
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
  const result = await requestJson(baseUrl, `${sessionPath(projectId, sessionId)}/view-state`, {
    headers,
  });
  assert.equal(result.response.status, 200);
  return asRecord(result.body.view_state);
}

function postSessionMessage(
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
): Promise<Array<Record<string, unknown>>> {
  const result = await requestJson(baseUrl, sessionMessagesPath(projectId, sessionId), { headers });
  assert.equal(result.response.status, 200);
  return result.body.messages as Array<Record<string, unknown>>;
}

async function listSessions(
  baseUrl: string,
  headers: Record<string, string>,
  projectId: string,
): Promise<Array<Record<string, unknown>>> {
  const result = await requestJson(baseUrl, `${sessionsPath(projectId)}?status=active`, { headers });
  assert.equal(result.response.status, 200);
  return result.body.sessions as Array<Record<string, unknown>>;
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
  init: RequestInit = {},
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
  assert.ok(value, `Missing ${name}`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
