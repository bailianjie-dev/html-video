import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestContextStorage } from '../dist/index.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('isolates users across concurrent async request scopes', async () => {
  const contexts = new RequestContextStorage();

  const runAs = (userId, waits) => contexts.run({
    requestId: `request-${userId}`,
    source: 'header',
    user: { userId, actorId: userId },
  }, async () => {
    const observed = [];
    for (const wait of waits) {
      observed.push(contexts.getRequiredUser().userId);
      await delay(wait);
    }
    observed.push(contexts.getRequiredUser().userId);
    return observed;
  });

  const [alice, bob] = await Promise.all([
    runAs('alice', [8, 1, 6]),
    runAs('bob', [1, 8, 1]),
  ]);

  assert.deepEqual(alice, ['alice', 'alice', 'alice', 'alice']);
  assert.deepEqual(bob, ['bob', 'bob', 'bob', 'bob']);
  assert.equal(contexts.get(), undefined);
});

test('restores the outer request scope after a nested scope finishes', async () => {
  const contexts = new RequestContextStorage();

  await contexts.run({
    requestId: 'outer',
    source: 'cookie',
    user: { userId: 'outer-user', actorId: 'outer-user' },
  }, async () => {
    assert.equal(contexts.getRequiredUser().userId, 'outer-user');

    await contexts.run({
      requestId: 'inner',
      source: 'header',
      user: { userId: 'inner-user', actorId: 'inner-user' },
    }, async () => {
      await delay(1);
      assert.equal(contexts.getRequiredUser().userId, 'inner-user');
    });

    assert.equal(contexts.getRequiredUser().userId, 'outer-user');
  });
});

test('throws when a required context is accessed outside a request', () => {
  const contexts = new RequestContextStorage();
  assert.throws(
    () => contexts.getRequiredUser(),
    /unavailable outside an authenticated request/,
  );
});
