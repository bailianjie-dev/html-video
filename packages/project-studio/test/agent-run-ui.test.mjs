import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAgentViewStateSnapshot,
  createAgentRunUiState,
  isAgentRunExecutionActive,
  preserveActivePageIndex,
  reconcileRestoredAgentRunUi,
  reduceAgentRunUiEvent,
  restoreAgentRunUiState,
  serializeAgentRunUiState,
  summarizeToolArguments,
  toolUiFromStoredMessage,
} from '../public/agent-run-ui.js';

function event(sequence, type, data = {}) {
  return {
    version: 1,
    runId: 'run-1',
    sessionId: 'session-1',
    sequence,
    timestamp: new Date(0).toISOString(),
    type,
    data,
  };
}

function apply(events) {
  let state = createAgentRunUiState();
  const effects = [];
  for (const item of events) {
    const reduced = reduceAgentRunUiEvent(state, item);
    state = reduced.state;
    effects.push(...reduced.effects);
  }
  return { state, effects };
}

test('maps a complete tool run and exposes preview revision', () => {
  const { state, effects } = apply([
    event(1, 'run.started', { agent: 'pi-agent', model: 'qwen3.7-plus' }),
    event(2, 'tool.call.started', {
      callId: 'call-1',
      name: 'update_album_page',
      arguments: { page_number: 2, expected_revision: 4, request: '修改标题' },
    }),
    event(3, 'tool.call.completed', {
      callId: 'call-1',
      output: {
        details: {
          ok: true,
          album_changed: true,
          previous_revision: 4,
          revision: 5,
          changed_pages: [2],
          changed_text_keys: ['page_2.title'],
        },
      },
      isError: false,
    }),
    event(4, 'preview.ready', {
      previewUrl: '/preview/project-1',
      previousRevision: 4,
      revision: 5,
      changedPages: [2],
      pageCount: 3,
    }),
    event(5, 'run.completed'),
  ]);

  assert.equal(state.status, 'completed');
  assert.equal(state.agent, 'pi-agent');
  assert.equal(state.model, 'qwen3.7-plus');
  assert.equal(state.tools[0].name, 'update_album_page');
  assert.equal(state.tools[0].status, 'succeeded');
  assert.deepEqual(state.tools[0].argumentSummary, ['页码：2', '预期版本：4', '要求：修改标题']);
  assert.equal(state.latestRevision, 5);
  assert.deepEqual(state.preview.changedPages, [2]);
  assert.deepEqual(
    effects.map((item) => item.type),
    ['preview_ready', 'terminal'],
  );
});

test('maps overwrite confirmation without claiming success', () => {
  const { state } = apply([
    event(1, 'run.started'),
    event(2, 'tool.call.started', { callId: 'c', name: 'generate_album', arguments: {} }),
    event(3, 'tool.call.completed', {
      callId: 'c',
      output: {
        details: {
          ok: false,
          confirmation_required: true,
          code: 'OVERWRITE_CONFIRMATION_REQUIRED',
          action_id: 'confirm-1',
          summary: '将覆盖当前相册',
          expected_revision: 7,
        },
      },
    }),
  ]);
  assert.equal(state.tools[0].status, 'confirmation_required');
  assert.equal(state.confirmation.expectedRevision, 7);
  assert.equal(state.tools[0].result.ok, false);
});

test('maps revision conflicts and validation failures', () => {
  const conflict = apply([
    event(1, 'tool.call.started', {
      callId: 'c',
      name: 'update_album',
      arguments: { expected_revision: 2 },
    }),
    event(2, 'tool.call.completed', {
      callId: 'c',
      output: {
        details: {
          ok: false,
          code: 'ALBUM_REVISION_CONFLICT',
          expected_revision: 2,
          current_revision: 3,
          album_changed: false,
        },
      },
    }),
  ]).state;
  assert.equal(conflict.tools[0].status, 'conflict');
  assert.deepEqual(conflict.conflict, { expectedRevision: 2, currentRevision: 3 });

  const validation = apply([
    event(1, 'tool.call.started', { callId: 'v', name: 'replace_album_assets', arguments: {} }),
    event(2, 'tool.call.completed', {
      callId: 'v',
      output: {
        details: {
          ok: false,
          code: 'ASSET_NOT_FOUND',
          message: '资源不存在',
        },
      },
    }),
  ]).state;
  assert.equal(validation.tools[0].status, 'validation_failed');
  assert.equal(validation.validationFailure.code, 'ASSET_NOT_FOUND');
});

test('cancels an active tool and ignores replayed event sequences', () => {
  const state = apply([
    event(1, 'run.started'),
    event(2, 'tool.call.started', { callId: 'c', name: 'get_album_state', arguments: {} }),
    event(3, 'run.cancelled', { message: 'cancelled by user' }),
  ]).state;
  assert.equal(state.status, 'cancelled');
  assert.equal(state.tools[0].status, 'cancelled');

  const replay = reduceAgentRunUiEvent(state, event(2, 'tool.call.completed', { callId: 'c' }));
  assert.strictEqual(replay.state, state);
  assert.deepEqual(replay.effects, []);
});

test('terminal events settle tools when a local cursor missed tool completion', () => {
  const completed = apply([
    event(1, 'run.started'),
    event(2, 'tool.call.started', { callId: 'c', name: 'generate_album', arguments: {} }),
    event(3, 'run.completed'),
  ]).state;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.tools[0].status, 'completed');

  const failed = apply([
    event(1, 'run.started'),
    event(2, 'tool.call.started', { callId: 'c', name: 'update_album_page', arguments: {} }),
    event(3, 'run.failed', { code: 'MODEL_FAILED', message: 'failed' }),
  ]).state;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.tools[0].status, 'failed');
});

test('album.changed settles its write tool when the completion event was missed', () => {
  const state = apply([
    event(1, 'run.started'),
    event(2, 'tool.call.started', {
      callId: 'write-1',
      name: 'update_album_page',
      arguments: { page_number: 1, expected_revision: 1 },
    }),
    event(4, 'album.changed', {
      toolCallId: 'write-1',
      revision: 2,
      pageCount: 3,
    }),
  ]).state;

  assert.equal(state.tools[0].status, 'succeeded');
  assert.equal(state.tools[0].result.albumChanged, true);
  assert.equal(state.tools[0].result.revision, 2);
});

test('deterministic runs reuse the existing reducer with a fast-edit status', () => {
  const started = reduceAgentRunUiEvent(
    createAgentRunUiState({ runId: 'fast-run', sessionId: 'fast-session' }),
    event(1, 'run.started', {
      agent: 'fast-command-router',
      model: null,
      executor: 'deterministic',
    }),
  );
  assert.equal(started.state.status, 'running');
  assert.equal(started.state.statusText, '正在快速修改');
});

test('persisted deterministic tools restore as completed after a browser refresh', () => {
  const tool = toolUiFromStoredMessage({
    role: 'tool',
    tool: 'set_album_text_color',
    runId: 'fast-run',
    sessionId: 'session-a',
    output: {
      details: {
        ok: true,
        album_changed: true,
        executor: 'deterministic',
        strategy: 'update_controlled_color_span',
        revision: 3,
        previous_revision: 2,
        changed_pages: [2],
      },
    },
  });
  assert.equal(tool.name, 'set_album_text_color');
  assert.equal(tool.status, 'succeeded');
  assert.equal(tool.result.revision, 3);
  assert.deepEqual(tool.result.changedPages, [2]);
});

test('serializes and restores a running event cursor', () => {
  const state = apply([event(1, 'run.started'), event(2, 'assistant.delta', { text: 'hi' })]).state;
  const restored = restoreAgentRunUiState(serializeAgentRunUiState(state));
  assert.equal(restored.runId, 'run-1');
  assert.equal(restored.status, 'running');
  assert.equal(restored.lastSequence, 2);
});

test('server active_run is authoritative when reconciling restored UI state', () => {
  const local = apply([
    event(1, 'run.started'),
    event(2, 'tool.call.started', { callId: 'c', name: 'generate_album', arguments: {} }),
  ]).state;

  assert.equal(reconcileRestoredAgentRunUi(local, null, 'session-1'), null);

  const matching = reconcileRestoredAgentRunUi(
    local,
    { run_id: 'run-1' },
    'session-1',
  );
  assert.equal(matching.lastSequence, 2);
  assert.equal(matching.tools[0].status, 'running');

  const replaced = reconcileRestoredAgentRunUi(
    local,
    { run_id: 'run-2' },
    'session-1',
  );
  assert.equal(replaced.runId, 'run-2');
  assert.equal(replaced.lastSequence, 0);
  assert.deepEqual(replaced.tools, []);
});

test('tool argument summaries hide HTML, URLs and local paths', () => {
  assert.deepEqual(
    summarizeToolArguments('update_album', {
      expected_revision: 2,
      request: '<html><body>secret</body></html>',
      source_url: 'https://example.com/a.png',
      local_path: 'C:\\secret\\a.png',
    }),
    ['预期版本：2', '要求：[已隐藏]'],
  );
});

test('page state snapshot contains only Session view state fields', () => {
  const snapshot = buildAgentViewStateSnapshot({
    activePageIndex: 9,
    pageCount: 3,
    previewRevision: 8,
    clientRevision: 12,
    message: 'must not leak',
    tool: 'must_not_run',
  });
  assert.deepEqual(snapshot, {
    activePageIndex: 2,
    pageCount: 3,
    previewRevision: 8,
    clientRevision: 12,
  });
});

test('running execution state is independent from whether a preview already exists', () => {
  assert.equal(isAgentRunExecutionActive({ runStatus: 'running' }), true);
  assert.equal(isAgentRunExecutionActive({ composing: true }), true);
  assert.equal(isAgentRunExecutionActive({ runStatus: 'completed' }), false);
});

test('preview refresh keeps the active page and only clamps when pages shrink', () => {
  assert.equal(preserveActivePageIndex(1, 3), 1);
  assert.equal(preserveActivePageIndex(2, 2), 1);
  assert.equal(preserveActivePageIndex(2, 0), 0);
});
