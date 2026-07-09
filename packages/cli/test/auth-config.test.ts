import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createDevAuthToken,
  loadAuthConfig,
  verifyDevAuthToken,
  verifyDevCredentials,
} from '../src/auth-config.ts';

test('loads auth.toml and verifies the fixed admin account', () => {
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
    assert.equal(verifyDevCredentials(config, 'admin', 'a-secret#with-comment-char'), true);
    assert.equal(verifyDevCredentials(config, 'someone-else', 'a-secret#with-comment-char'), false);
    assert.equal(verifyDevCredentials(config, 'admin', 'wrong-password'), false);

    const token = createDevAuthToken(config);
    assert.equal(verifyDevAuthToken(config, token), true);
    assert.equal(verifyDevAuthToken(config, `${token}x`), false);
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
