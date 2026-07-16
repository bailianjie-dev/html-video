import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentRunEvent } from '@html-video/runtime';
import { AgentWorkflowMetrics } from '../src/agent-workflow-metrics.ts';

function event(sequence: number, type: AgentRunEvent['type'], data: unknown): AgentRunEvent {
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

test('records per-run and cumulative Agent tool failure rates', () => {
  const metrics = new AgentWorkflowMetrics();
  const first = metrics.record({
    projectId: 'project-1',
    runId: 'run-1',
    outcome: 'completed',
    events: [
      event(1, 'tool.call.started', { callId: 'a', name: 'get_album_state' }),
      event(2, 'tool.call.completed', { callId: 'a', output: { details: { ok: true } } }),
      event(3, 'tool.call.started', { callId: 'b', name: 'update_album_page' }),
      event(4, 'tool.call.completed', {
        callId: 'b',
        output: { details: { ok: false, code: 'ALBUM_REVISION_CONFLICT' } },
      }),
    ],
  });
  assert.equal(first.toolCalls, 2);
  assert.equal(first.toolFailures, 1);
  assert.equal(first.toolFailureRate, 0.5);
  assert.deepEqual(first.failuresByTool, { update_album_page: 1 });
  assert.equal(first.legacyFallbackUsed, false);
  assert.equal(first.legacyFallbackReason, null);

  const second = metrics.record({
    projectId: 'project-1',
    runId: 'run-2',
    outcome: 'completed',
    events: [
      event(1, 'tool.call.started', { callId: 'c', name: 'get_current_page' }),
      event(2, 'tool.call.completed', { callId: 'c', output: { details: { ok: true } } }),
    ],
  });
  assert.equal(second.cumulativeRuns, 2);
  assert.equal(second.cumulativeToolCalls, 3);
  assert.equal(second.cumulativeToolFailures, 1);
  assert.equal(second.cumulativeToolFailureRate, 1 / 3);
});
