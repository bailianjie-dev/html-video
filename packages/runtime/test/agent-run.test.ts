import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentRunEventLog,
  runAgentTurn,
  type AgentDef,
} from '../dist/index.js';

function fakeHttpAgent(handler: AgentDef['httpHandler']): AgentDef {
  return {
    id: 'fake-agent',
    name: 'Fake Agent',
    bin: 'fake-agent',
    versionArgs: [],
    buildArgs: () => [],
    streamFormat: 'plain',
    kind: 'http',
    httpHandler: handler,
  };
}

test('runAgentTurn emits ordered v1 events and buffers assistant text', async () => {
  const def = fakeHttpAgent(async (_prompt, _context, onEvent) => {
    onEvent({ type: 'text', chunk: 'hello' });
    onEvent({ type: 'text', chunk: ' world' });
    return { exitCode: 0 };
  });
  const events = new AgentRunEventLog('run-1', 'session-1');

  const result = await runAgentTurn({
    def,
    prompt: 'hi',
    context: { cwd: process.cwd(), systemPrompt: 'system' },
    events,
  });

  assert.equal(result.text, 'hello world');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(events.list().map((event) => event.type), [
    'run.started',
    'assistant.delta',
    'assistant.delta',
    'assistant.completed',
    'run.completed',
  ]);
  assert.deepEqual(events.list().map((event) => event.sequence), [1, 2, 3, 4, 5]);
  assert.ok(events.list().every((event) => event.version === 1));
});

test('event log replays only events after the requested sequence', () => {
  const events = new AgentRunEventLog('run-2', 'session-2');
  events.append('run.started');
  events.append('assistant.delta', { text: 'a' });
  const replayed: number[] = [];

  const unsubscribe = events.subscribe((event) => replayed.push(event.sequence), 1);
  events.append('run.completed');
  unsubscribe();

  assert.deepEqual(replayed, [2, 3]);
});

test('empty successful provider response is reported as a failed run', async () => {
  const def = fakeHttpAgent(async () => ({ exitCode: 0 }));
  const events = new AgentRunEventLog('run-3', 'session-3');

  const result = await runAgentTurn({
    def,
    prompt: 'hi',
    context: { cwd: process.cwd() },
    events,
  });

  assert.equal(result.error, 'Agent returned an empty response');
  assert.equal(events.list().at(-1)?.type, 'run.failed');
});

test('successful album tool results emit semantic change and preview events', async () => {
  const def = fakeHttpAgent(async (_prompt, _context, onEvent) => {
    onEvent({
      type: 'tool_result',
      id: 'tool-1',
      output: {
        details: {
          ok: true,
          album_changed: true,
          previous_revision: 2,
          revision: 3,
          page_count: 6,
          changed_pages: [2],
          change_summary: {
            page_count: 1,
            text_count: 1,
            structural_change: false,
          },
          operation: 'update_album_page',
          page_number: 2,
          preview_url: '/preview/project-1',
        },
      },
    });
    onEvent({ type: 'text', chunk: 'Album generated.' });
    return { exitCode: 0 };
  });
  const events = new AgentRunEventLog('run-4', 'session-4');

  await runAgentTurn({
    def,
    prompt: 'generate',
    context: { cwd: process.cwd() },
    events,
  });

  assert.deepEqual(events.list().map((event) => event.type), [
    'run.started',
    'tool.call.completed',
    'album.changed',
    'preview.ready',
    'assistant.delta',
    'assistant.completed',
    'run.completed',
  ]);
  assert.deepEqual(events.list().find((event) => event.type === 'preview.ready')?.data, {
    previewUrl: '/preview/project-1',
    revision: 3,
    previousRevision: 2,
    pageCount: 6,
    changedPages: [2],
    changeSummary: {
      page_count: 1,
      text_count: 1,
      structural_change: false,
    },
    operation: 'update_album_page',
    pageNumber: 2,
  });
});

test('revision conflicts do not emit album change or preview events', async () => {
  const def = fakeHttpAgent(async (_prompt, _context, onEvent) => {
    onEvent({
      type: 'tool_result',
      id: 'tool-conflict',
      output: {
        details: {
          ok: false,
          code: 'ALBUM_REVISION_CONFLICT',
          expected_revision: 2,
          current_revision: 3,
          album_changed: false,
        },
      },
    });
    onEvent({ type: 'text', chunk: 'The album changed. Please retry.' });
    return { exitCode: 0 };
  });
  const events = new AgentRunEventLog('run-conflict', 'session-conflict');

  await runAgentTurn({
    def,
    prompt: 'update',
    context: { cwd: process.cwd() },
    events,
  });

  assert.equal(events.list().some((event) => event.type === 'album.changed'), false);
  assert.equal(events.list().some((event) => event.type === 'preview.ready'), false);
});
