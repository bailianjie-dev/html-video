import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileProjectPersistence, ProjectStore } from '@html-video/core';

import { bootstrap, type CliContext } from '../dist/context.js';
import { LocalAgentSessionStore } from '../dist/local-agent-session-store.js';
import {
  tryExecuteSimpleAlbumCommand,
  type TryExecuteSimpleAlbumCommandResult,
} from '../dist/studio-server.js';
import type { AlbumAgentSessionRecord } from '../dist/album-agent-v1.js';

const SAFE_HTML = `<!doctype html><html><head><style>.title{animation:rise 1s}</style></head><body>
<main id="album">
  <section data-album-page="page_1"><h1 data-hv-text="page_1.title">第一页</h1></section>
  <section data-album-page="page_2"><h1 class="title" data-hv-text="page_2.title">核心性能<br>全面领先</h1></section>
</main><script>window.keepAnimation = true;</script></body></html>`;

interface Fixture {
  root: string;
  ctx: CliContext;
  projectId: string;
  sessionA: string;
  sessionB: string;
  store: LocalAgentSessionStore;
}

test('executes a deterministic command, persists revision, and updates Session view-state', async () => {
  const fixture = await createFixture(SAFE_HTML);
  try {
    const result = await execute(fixture, fixture.sessionA, '第二页的全面领先，改为遥遥领先', 0);
    assert.equal(result.status, 'handled_success');
    assert.equal(result.executor, 'deterministic');
    assert.equal(result.strategy, 'replace_text_node_source');
    assert.ok(result.duration_ms >= 0);
    if (result.status !== 'handled_success') return;
    assert.equal(result.previous_revision, 0);
    assert.equal(result.revision, 1);
    assert.equal(result.page_number, 2);
    assert.equal(result.changed_key, 'page_2.title');

    const html = await fixture.ctx.orchestrator.readRawHtml(fixture.projectId);
    assert.match(html ?? '', /核心性能<br>遥遥领先/);
    assert.match(html ?? '', /window\.keepAnimation = true/);
    const project = await fixture.ctx.orchestrator.load(fixture.projectId);
    assert.equal(project.albumRevision, 1);
    const session = await fixture.store.readSession<AlbumAgentSessionRecord>(fixture.sessionA);
    assert.equal(session?.viewState?.activePageIndex, 1);
    assert.equal(session?.viewState?.previewRevision, 1);
  } finally {
    await destroyFixture(fixture);
  }
});

test('resolves 这一页 from Session view-state and executes without an Agent', async () => {
  const fixture = await createFixture(SAFE_HTML);
  try {
    const result = await execute(fixture, fixture.sessionA, '这一页的核心性能改为红色', 0);
    assert.equal(result.status, 'handled_success');
    assert.equal(result.executor, 'deterministic');
    assert.equal(result.strategy, 'wrap_text_node_with_color_span');
    if (result.status !== 'handled_success') return;
    assert.equal(result.page_number, 2);
    assert.equal(result.changed_key, 'page_2.title');
    assert.match(
      await fixture.ctx.orchestrator.readRawHtml(fixture.projectId) ?? '',
      /<span style="color:#FF0000">核心性能<\/span><br>全面领先/,
    );
  } finally {
    await destroyFixture(fixture);
  }
});

test('executes a colloquial color alias deterministically on the current page', async () => {
  const fixture = await createFixture(SAFE_HTML.replace('核心性能', 'XIAOMI'));
  try {
    const result = await execute(fixture, fixture.sessionA, 'xiaomi变成绿色', 0);
    assert.equal(result.status, 'handled_success');
    if (result.status !== 'handled_success') return;
    assert.equal(result.command.type, 'set_text_color');
    assert.equal(result.page_number, 2);
    assert.match(
      await fixture.ctx.orchestrator.readRawHtml(fixture.projectId) ?? '',
      /<span style="color:#008000">XIAOMI<\/span>/,
    );
  } finally {
    await destroyFixture(fixture);
  }
});

test('creates a Session-scoped confirmation when explicit page misses a unique target on another page', async () => {
  const fixture = await createFixture(SAFE_HTML);
  try {
    const before = await fixture.ctx.orchestrator.readRawHtml(fixture.projectId);
    const result = await execute(fixture, fixture.sessionA, '把第一页的核心性能改成红色', 0);
    assert.equal(result.status, 'handled_confirmation_required');
    assert.equal(result.executor, 'deterministic');
    assert.equal(result.strategy, 'locate_text_cross_page');
    if (result.status !== 'handled_confirmation_required') return;
    assert.equal(result.code, 'PAGE_TARGET_MISMATCH');
    assert.equal(result.requested_page, 1);
    assert.equal(result.suggested_page, 2);
    assert.deepEqual(result.candidate_pages, [2]);
    assert.equal(await fixture.ctx.orchestrator.readRawHtml(fixture.projectId), before);
    assert.equal((await fixture.ctx.orchestrator.load(fixture.projectId)).albumRevision ?? 0, 0);
    const sessionA = await fixture.store.readSession<AlbumAgentSessionRecord>(fixture.sessionA);
    const sessionB = await fixture.store.readSession<AlbumAgentSessionRecord>(fixture.sessionB);
    assert.equal(sessionA?.pendingConfirmation?.kind, 'simple_page_target');
    assert.equal(sessionB?.pendingConfirmation, null);

    const confirmed = await execute(
      fixture,
      fixture.sessionA,
      `[fast-page-confirm:${result.action_id}:apply:2]`,
      0,
    );
    assert.equal(confirmed.status, 'handled_success');
    if (confirmed.status === 'handled_success') assert.equal(confirmed.page_number, 2);
    assert.match(
      await fixture.ctx.orchestrator.readRawHtml(fixture.projectId) ?? '',
      /<span style="color:#FF0000">核心性能<\/span><br>全面领先/,
    );
    assert.equal(
      (await fixture.store.readSession<AlbumAgentSessionRecord>(fixture.sessionA))?.pendingConfirmation,
      null,
    );
  } finally {
    await destroyFixture(fixture);
  }
});

test('cancels a page mismatch confirmation without mutation', async () => {
  const fixture = await createFixture(SAFE_HTML);
  try {
    const before = await fixture.ctx.orchestrator.readRawHtml(fixture.projectId);
    const pending = await execute(fixture, fixture.sessionA, '把第一页的核心性能改成红色', 0);
    assert.equal(pending.status, 'handled_confirmation_required');
    if (pending.status !== 'handled_confirmation_required') return;
    const cancelled = await execute(
      fixture,
      fixture.sessionA,
      `[fast-page-confirm:${pending.action_id}:cancel]`,
      0,
    );
    assert.equal(cancelled.status, 'handled_cancelled');
    assert.equal(await fixture.ctx.orchestrator.readRawHtml(fixture.projectId), before);
    assert.equal((await fixture.ctx.orchestrator.load(fixture.projectId)).albumRevision ?? 0, 0);
    assert.equal(
      (await fixture.store.readSession<AlbumAgentSessionRecord>(fixture.sessionA))?.pendingConfirmation,
      null,
    );
  } finally {
    await destroyFixture(fixture);
  }
});

test('strict explicit page and album-wide zero match are handled without cross-page correction', async () => {
  const fixture = await createFixture(SAFE_HTML);
  try {
    const strict = await execute(fixture, fixture.sessionA, '就是第一页，把核心性能改成红色', 0);
    assert.equal(strict.status, 'handled_target_not_found');
    if (strict.status === 'handled_target_not_found') {
      assert.equal(strict.code, 'TARGET_TEXT_NOT_FOUND');
      assert.equal(strict.requested_page, 1);
    }
    const absent = await execute(fixture, fixture.sessionA, '把第一页的“完全不存在”改成红色', 0);
    assert.equal(absent.status, 'handled_target_not_found');
    const unproven = await execute(fixture, fixture.sessionA, '把第一页的完全不存再改成红色', 0);
    assert.equal(unproven.status, 'not_handled');
    if (unproven.status === 'not_handled') assert.equal(unproven.reason, 'unproven_text_command');
    assert.equal((await fixture.ctx.orchestrator.load(fixture.projectId)).albumRevision ?? 0, 0);
  } finally {
    await destroyFixture(fixture);
  }
});

test('returns handled_conflict without overwriting HTML or revision', async () => {
  const fixture = await createFixture(SAFE_HTML);
  try {
    const before = await fixture.ctx.orchestrator.readRawHtml(fixture.projectId);
    const result = await execute(fixture, fixture.sessionA, '第二页的全面领先改为遥遥领先', 7);
    assert.equal(result.status, 'handled_conflict');
    assert.equal(result.executor, 'deterministic');
    assert.equal(result.strategy, 'replace_text_node_source');
    if (result.status === 'handled_conflict') {
      assert.equal(result.expected_revision, 7);
      assert.equal(result.current_revision, 0);
    }
    assert.equal(await fixture.ctx.orchestrator.readRawHtml(fixture.projectId), before);
    assert.equal((await fixture.ctx.orchestrator.load(fixture.projectId)).albumRevision ?? 0, 0);
  } finally {
    await destroyFixture(fixture);
  }
});

test('returns parser fallback and deterministic confirmation for ambiguous HTML without writing', async () => {
  const fixture = await createFixture(SAFE_HTML.replace('核心性能<br>全面领先', '全面领先<br>全面领先'));
  try {
    const before = await fixture.ctx.orchestrator.readRawHtml(fixture.projectId);
    const subjective = await execute(fixture, fixture.sessionA, '把第二页做得更高级', 0);
    assert.equal(subjective.status, 'not_handled');
    if (subjective.status === 'not_handled') assert.equal(subjective.reason, 'subjective_request');
    const ambiguous = await execute(fixture, fixture.sessionA, '第二页的全面领先改为遥遥领先', 0);
    assert.equal(ambiguous.status, 'handled_confirmation_required');
    if (ambiguous.status === 'handled_confirmation_required') {
      assert.equal(ambiguous.code, 'TEXT_TARGET_AMBIGUOUS');
      assert.equal(ambiguous.candidates.length, 2);
    }
    assert.equal(await fixture.ctx.orchestrator.readRawHtml(fixture.projectId), before);
    assert.equal((await fixture.ctx.orchestrator.load(fixture.projectId)).albumRevision ?? 0, 0);
  } finally {
    await destroyFixture(fixture);
  }
});

test('same-page target confirmation supports cancel and rejects a stale album revision', async () => {
  const html = SAFE_HTML
    .replace('核心性能<br>全面领先', 'SU7<br>SU7')
    .replace('</h1></section>', '</h1><p data-hv-text="page_1.body">其他内容</p></section>');
  const fixture = await createFixture(html);
  try {
    const pending = await execute(fixture, fixture.sessionA, '把 su7 改成蓝色', 0);
    assert.equal(pending.status, 'handled_confirmation_required');
    if (pending.status !== 'handled_confirmation_required') return;
    assert.equal(pending.code, 'TEXT_TARGET_AMBIGUOUS');
    const cancelled = await execute(
      fixture, fixture.sessionA, `[fast-text-confirm:${pending.action_id}:cancel]`, 0,
    );
    assert.equal(cancelled.status, 'handled_cancelled');
    assert.equal((await fixture.ctx.orchestrator.load(fixture.projectId)).albumRevision ?? 0, 0);

    const pendingAgain = await execute(fixture, fixture.sessionA, '把 su7 改成蓝色', 0);
    assert.equal(pendingAgain.status, 'handled_confirmation_required');
    if (pendingAgain.status !== 'handled_confirmation_required') return;
    const otherWrite = await execute(fixture, fixture.sessionB, '把第一页的“其他内容”改为“新内容”', 0);
    assert.equal(otherWrite.status, 'handled_success');
    const conflict = await execute(
      fixture,
      fixture.sessionA,
      `[fast-text-confirm:${pendingAgain.action_id}:${pendingAgain.candidates[0]!.candidate_id}]`,
      0,
    );
    assert.equal(conflict.status, 'handled_conflict');
    const stored = await fixture.store.readSession(fixture.sessionA);
    assert.equal(stored?.pendingConfirmation, null);
  } finally {
    await destroyFixture(fixture);
  }
});

test('returns not_handled for a deterministic no-op instead of writing a revision', async () => {
  const fixture = await createFixture(SAFE_HTML);
  try {
    const result = await execute(fixture, fixture.sessionA, '第二页的全面领先改为全面领先', 0);
    assert.equal(result.status, 'not_handled');
    if (result.status === 'not_handled') assert.equal(result.reason, 'no_effect');
    assert.equal((await fixture.ctx.orchestrator.load(fixture.projectId)).albumRevision ?? 0, 0);
    assert.equal(await fixture.ctx.orchestrator.readRawHtml(fixture.projectId), SAFE_HTML);
  } finally {
    await destroyFixture(fixture);
  }
});

test('returns validation_failed and performs zero writes', async () => {
  const unsafeHtml = SAFE_HTML.replace(
    '</main>',
    '<input type="file" accept="image/*" id="uploadInput"></main>',
  );
  const fixture = await createFixture(unsafeHtml);
  try {
    const result = await execute(fixture, fixture.sessionA, '第二页的全面领先改为遥遥领先', 0);
    assert.equal(result.status, 'validation_failed');
    assert.equal(result.executor, 'deterministic');
    assert.ok(result.duration_ms >= 0);
    if (result.status === 'validation_failed') assert.ok(result.validation_reasons.length > 0);
    assert.equal(await fixture.ctx.orchestrator.readRawHtml(fixture.projectId), unsafeHtml);
    assert.equal((await fixture.ctx.orchestrator.load(fixture.projectId)).albumRevision ?? 0, 0);
  } finally {
    await destroyFixture(fixture);
  }
});

test('serializes sibling Session writes and allows only one winner for one revision', async () => {
  const fixture = await createFixture(SAFE_HTML);
  try {
    const [replace, color] = await Promise.all([
      execute(fixture, fixture.sessionA, '第二页的全面领先改为遥遥领先', 0),
      execute(fixture, fixture.sessionB, '第二页“全面领先”的字体改为 #FF5A36', 0),
    ]);
    const statuses = [replace.status, color.status].sort();
    assert.deepEqual(statuses, ['handled_conflict', 'handled_success']);
    assert.equal((await fixture.ctx.orchestrator.load(fixture.projectId)).albumRevision, 1);
    const html = await fixture.ctx.orchestrator.readRawHtml(fixture.projectId) ?? '';
    const replaceWon = /核心性能<br>遥遥领先/.test(html);
    const colorWon = /核心性能<br><span style="color:#FF5A36">全面领先<\/span>/.test(html);
    assert.notEqual(replaceWon, colorWon);
  } finally {
    await destroyFixture(fixture);
  }
});

async function createFixture(html: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'html-video-simple-command-'));
  const ctx = await bootstrap({
    cwd: root,
    projects: new FileProjectPersistence(new ProjectStore(root)),
  });
  const project = await ctx.orchestrator.create({ name: 'Simple command fixture' });
  await ctx.orchestrator.writePreviewHtmlRaw(project.id, html);
  const projectDir = await ctx.projects.ensureDir(project.id);
  const store = new LocalAgentSessionStore(projectDir, project.id);
  const sessionA = 'simple-session-a';
  const sessionB = 'simple-session-b';
  await Promise.all([
    store.writeSession(sessionA, sessionRecord(project.id, sessionA)),
    store.writeSession(sessionB, sessionRecord(project.id, sessionB)),
  ]);
  return { root, ctx, projectId: project.id, sessionA, sessionB, store };
}

function sessionRecord(projectId: string, id: string): AlbumAgentSessionRecord {
  const now = new Date().toISOString();
  return {
    id,
    projectId,
    title: id,
    status: 'active',
    model: null,
    systemPromptVersion: 'test',
    toolsetVersion: 'test',
    viewState: {
      activePageIndex: 1,
      pageCount: 2,
      previewRevision: 0,
      clientRevision: 1,
      updatedAt: now,
    },
    pendingConfirmation: null,
    completedToolCalls: {},
    createdAt: now,
    updatedAt: now,
  };
}

function execute(
  fixture: Fixture,
  sessionId: string,
  userText: string,
  expectedRevision: number,
): Promise<TryExecuteSimpleAlbumCommandResult> {
  return tryExecuteSimpleAlbumCommand({
    ctx: fixture.ctx,
    projectId: fixture.projectId,
    sessionId,
    userText,
    expectedRevision,
  });
}

async function destroyFixture(fixture: Fixture): Promise<void> {
  await fixture.ctx.database?.handle?.close();
  await rm(fixture.root, { recursive: true, force: true });
}
