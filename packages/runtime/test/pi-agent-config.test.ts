import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PI_MAX_TOKENS,
  parsePositiveIntEnv,
  resolvePiAgentConfig,
  waitForPiPromptOrAbort,
} from '../dist/index.js';

test('parsePositiveIntEnv accepts positive integers and falls back otherwise', () => {
  assert.equal(parsePositiveIntEnv('8192', DEFAULT_PI_MAX_TOKENS), 8192);
  assert.equal(parsePositiveIntEnv(' 32768 ', DEFAULT_PI_MAX_TOKENS), 32768);
  assert.equal(parsePositiveIntEnv(undefined, DEFAULT_PI_MAX_TOKENS), DEFAULT_PI_MAX_TOKENS);
  assert.equal(parsePositiveIntEnv('', DEFAULT_PI_MAX_TOKENS), DEFAULT_PI_MAX_TOKENS);
  assert.equal(parsePositiveIntEnv('abc', DEFAULT_PI_MAX_TOKENS), DEFAULT_PI_MAX_TOKENS);
  assert.equal(parsePositiveIntEnv('0', DEFAULT_PI_MAX_TOKENS), DEFAULT_PI_MAX_TOKENS);
  assert.equal(parsePositiveIntEnv('-1', DEFAULT_PI_MAX_TOKENS), DEFAULT_PI_MAX_TOKENS);
  assert.equal(parsePositiveIntEnv('1.5', DEFAULT_PI_MAX_TOKENS), DEFAULT_PI_MAX_TOKENS);
});

test('resolvePiAgentConfig reads HV_PI_MAX_TOKENS with alias fallback', () => {
  const prev = {
    HV_PI_API_KEY: process.env.HV_PI_API_KEY,
    DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    HV_PI_MAX_TOKENS: process.env.HV_PI_MAX_TOKENS,
    DASHSCOPE_MAX_TOKENS: process.env.DASHSCOPE_MAX_TOKENS,
    OPENAI_MAX_TOKENS: process.env.OPENAI_MAX_TOKENS,
  };

  try {
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.DASHSCOPE_MAX_TOKENS;
    delete process.env.OPENAI_MAX_TOKENS;
    process.env.HV_PI_API_KEY = 'sk-test';

    delete process.env.HV_PI_MAX_TOKENS;
    assert.equal(resolvePiAgentConfig()?.maxTokens, DEFAULT_PI_MAX_TOKENS);

    process.env.HV_PI_MAX_TOKENS = '32768';
    assert.equal(resolvePiAgentConfig()?.maxTokens, 32768);

    delete process.env.HV_PI_MAX_TOKENS;
    process.env.DASHSCOPE_MAX_TOKENS = '8192';
    assert.equal(resolvePiAgentConfig()?.maxTokens, 8192);

    process.env.HV_PI_MAX_TOKENS = 'not-a-number';
    assert.equal(resolvePiAgentConfig()?.maxTokens, DEFAULT_PI_MAX_TOKENS);
  } finally {
    restoreEnv('HV_PI_API_KEY', prev.HV_PI_API_KEY);
    restoreEnv('DASHSCOPE_API_KEY', prev.DASHSCOPE_API_KEY);
    restoreEnv('OPENAI_API_KEY', prev.OPENAI_API_KEY);
    restoreEnv('HV_PI_MAX_TOKENS', prev.HV_PI_MAX_TOKENS);
    restoreEnv('DASHSCOPE_MAX_TOKENS', prev.DASHSCOPE_MAX_TOKENS);
    restoreEnv('OPENAI_MAX_TOKENS', prev.OPENAI_MAX_TOKENS);
  }
});

test('Pi prompt wait settles when abort completes even if prompt stays pending', async () => {
  const controller = new AbortController();
  let abortCalls = 0;
  const waiting = waitForPiPromptOrAbort(
    new Promise<void>(() => {}),
    async () => { abortCalls += 1; },
    controller.signal,
  );

  controller.abort();

  assert.equal(await waiting, 'aborted');
  assert.equal(abortCalls, 1);
});

test('Pi prompt wait settles after the grace period when SDK abort never becomes idle', async () => {
  const controller = new AbortController();
  let abortCalls = 0;
  const startedAt = Date.now();
  const waiting = waitForPiPromptOrAbort(
    new Promise<void>(() => {}),
    async () => {
      abortCalls += 1;
      await new Promise<void>(() => {});
    },
    controller.signal,
    20,
  );

  controller.abort();

  assert.equal(await waiting, 'aborted');
  assert.equal(abortCalls, 1);
  assert.ok(Date.now() - startedAt < 500);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
