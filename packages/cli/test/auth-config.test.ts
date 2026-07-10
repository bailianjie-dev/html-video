import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createDevAuthToken,
  findAuthUser,
  loadAuthConfig,
  verifyDevAuthToken,
  verifyDevCredentials,
} from '../src/auth-config.ts';

test('loads legacy single-admin auth.toml', () => {
  const root = mkdtempSync(join(tmpdir(), 'html-video-auth-'));
  try {
    mkdirSync(join(root, '.html-video'));
    writeFileSync(
      join(root, '.html-video', 'auth.toml'),
      '[auth]\npassword = "a-secret#with-comment-char" # comment\n',
      'utf8',
    );

    const config = loadAuthConfig(root);
    assert.ok(config);
    assert.equal(config.users.length, 1);
    assert.equal(config.users[0]?.userId, 'admin');
    assert.equal(verifyDevCredentials(config, 'admin', 'a-secret#with-comment-char'), true);
    assert.equal(verifyDevCredentials(config, 'someone-else', 'a-secret#with-comment-char'), false);
    assert.equal(verifyDevCredentials(config, 'admin', 'wrong-password'), false);

    const token = createDevAuthToken(config, 'admin');
    assert.equal(verifyDevAuthToken(config, 'admin', token), true);
    assert.equal(verifyDevAuthToken(config, 'alice', token), false);
    assert.equal(verifyDevAuthToken(config, 'admin', `${token}x`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loads multi-user auth.toml with shared and per-user passwords', () => {
  const root = mkdtempSync(join(tmpdir(), 'html-video-auth-'));
  try {
    mkdirSync(join(root, '.html-video'));
    writeFileSync(
      join(root, '.html-video', 'auth.toml'),
      `
[auth]
password = "shared-password"

[[auth.users]]
user_id = "admin"
display_name = "管理员"

[[auth.users]]
user_id = "alice"
display_name = "Alice"

[[auth.users]]
user_id = "bob"
display_name = "Bob"
password = "bob-only-password"
`.trim(),
      'utf8',
    );

    const config = loadAuthConfig(root);
    assert.ok(config);
    assert.equal(config.users.length, 3);
    assert.equal(findAuthUser(config, 'alice')?.displayName, 'Alice');
    assert.equal(verifyDevCredentials(config, 'admin', 'shared-password'), true);
    assert.equal(verifyDevCredentials(config, 'alice', 'shared-password'), true);
    assert.equal(verifyDevCredentials(config, 'bob', 'shared-password'), false);
    assert.equal(verifyDevCredentials(config, 'bob', 'bob-only-password'), true);

    const aliceToken = createDevAuthToken(config, 'alice');
    assert.equal(verifyDevAuthToken(config, 'alice', aliceToken), true);
    assert.equal(verifyDevAuthToken(config, 'bob', aliceToken), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects missing and placeholder passwords', () => {
  const root = mkdtempSync(join(tmpdir(), 'html-video-auth-'));
  try {
    mkdirSync(join(root, '.html-video'));
    assert.equal(loadAuthConfig(root), null);
    writeFileSync(join(root, '.html-video', 'auth.toml'), '[auth]\npassword = "CHANGE_ME"\n', 'utf8');
    assert.equal(loadAuthConfig(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
