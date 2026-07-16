import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentRunEventLog } from '@html-video/runtime';
import { AgentRunRegistry, type RegisteredAgentRun } from '../src/album-agent-v1.ts';

function makeRun(runId: string, sessionId: string): RegisteredAgentRun {
  return {
    projectKey: 'user-1\0project-1',
    projectId: 'project-1',
    sessionId,
    log: new AgentRunEventLog(runId, sessionId),
    abortController: new AbortController(),
    createdAt: Date.now(),
  };
}

test('allows one active run per Session while sibling Sessions run concurrently', () => {
  const registry = new AgentRunRegistry();
  const firstA = makeRun('run-a-1', 'session-a');
  const secondA = makeRun('run-a-2', 'session-a');
  const firstB = makeRun('run-b-1', 'session-b');

  assert.equal(registry.tryAdd('run-a-1', firstA), true);
  assert.equal(registry.tryAdd('run-a-2', secondA), false);
  assert.equal(registry.tryAdd('run-b-1', firstB), true);
  assert.equal(registry.getActiveForSession(firstA.projectKey, 'session-a'), firstA);
  assert.equal(registry.getActiveForSession(firstB.projectKey, 'session-b'), firstB);
});

test('releases the Session reservation only when its active run completes', () => {
  const registry = new AgentRunRegistry();
  const first = makeRun('run-a-1', 'session-a');
  const rejected = makeRun('run-a-2', 'session-a');
  const next = makeRun('run-a-3', 'session-a');

  assert.equal(registry.tryAdd('run-a-1', first), true);
  assert.equal(registry.tryAdd('run-a-2', rejected), false);
  registry.markCompleted('run-a-2');
  assert.equal(registry.getActiveForSession(first.projectKey, 'session-a'), first);
  registry.markCompleted('run-a-1');
  assert.equal(registry.getActiveForSession(first.projectKey, 'session-a'), undefined);
  assert.equal(registry.tryAdd('run-a-3', next), true);
});
