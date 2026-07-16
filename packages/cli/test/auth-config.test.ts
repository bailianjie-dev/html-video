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
} from '../dist/auth-config.js';
import { loadDatabaseConfig } from '../dist/database-config.js';
import { loadOssConfig } from '../dist/oss-config.js';
import {
  mergeSimpleToml,
  mergeUnifiedToml,
  resolveAppTomlConfig,
  resolveTomlConfig,
  tomlFileHasContent,
} from '../dist/config-files.js';
import { parseAgentTomlSection } from '../dist/load-env.js';

test('loads legacy single-admin auth.toml under .html-video', () => {
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

test('loads multi-user auth from unified config.local.toml', () => {
  const root = mkdtempSync(join(tmpdir(), 'html-video-auth-'));
  try {
    mkdirSync(join(root, 'config'));
    writeFileSync(
      join(root, 'config', 'config.toml'),
      '[auth]\npassword = "CHANGE_ME"\n',
      'utf8',
    );
    writeFileSync(
      join(root, 'config', 'config.local.toml'),
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
    mkdirSync(join(root, 'config'));
    assert.equal(loadAuthConfig(root), null);
    writeFileSync(join(root, 'config', 'config.toml'), '[auth]\npassword = "CHANGE_ME"\n', 'utf8');
    assert.equal(loadAuthConfig(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('merges database from unified config.toml + local', () => {
  const root = mkdtempSync(join(tmpdir(), 'html-video-db-'));
  try {
    mkdirSync(join(root, 'config'));
    writeFileSync(
      join(root, 'config', 'config.toml'),
      `
[database]
enabled = false
host = "127.0.0.1"
port = 5432
name = "html_video"
user = "postgres"
password = "YOUR_PASSWORD"
pool_max_size = 10
`.trim(),
      'utf8',
    );
    writeFileSync(
      join(root, 'config', 'config.local.toml'),
      `
[database]
enabled = true
password = "local-secret"
pool_max_size = 4
`.trim(),
      'utf8',
    );

    const config = loadDatabaseConfig(root);
    assert.ok(config);
    assert.equal(config.enabled, true);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.password, 'local-secret');
    assert.equal(config.poolMaxSize, 4);
    assert.match(config.sourcePath.replace(/\\/g, '/'), /config\/config\.local\.toml$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('merges oss from unified config.toml + local', () => {
  const root = mkdtempSync(join(tmpdir(), 'html-video-oss-'));
  try {
    mkdirSync(join(root, 'config'));
    writeFileSync(
      join(root, 'config', 'config.toml'),
      `
[oss]
enabled = false
endpoint = "oss-cn-example.aliyuncs.com"
bucket = "base-bucket"
access_key_id = "BASE_ID"
access_key_secret = "BASE_SECRET"
prefix = "html-video/dev"
`.trim(),
      'utf8',
    );
    writeFileSync(
      join(root, 'config', 'config.local.toml'),
      `
[oss]
enabled = true
access_key_id = "LOCAL_ID"
access_key_secret = "LOCAL_SECRET"
`.trim(),
      'utf8',
    );

    const config = loadOssConfig(root);
    assert.ok(config);
    assert.equal(config.enabled, true);
    assert.equal(config.bucket, 'base-bucket');
    assert.equal(config.accessKeyId, 'LOCAL_ID');
    assert.equal(config.accessKeySecret, 'LOCAL_SECRET');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('empty local file is ignored; base config is used', () => {
  const root = mkdtempSync(join(tmpdir(), 'html-video-empty-local-'));
  try {
    mkdirSync(join(root, 'config'));
    writeFileSync(
      join(root, 'config', 'config.toml'),
      '[database]\nenabled = false\nhost = "base"\nname = "n"\nuser = "u"\npassword = "base"\n',
      'utf8',
    );
    writeFileSync(
      join(root, 'config', 'config.local.toml'),
      '# only comments\n\n',
      'utf8',
    );
    assert.equal(tomlFileHasContent('# only comments\n\n'), false);
    const resolved = resolveAppTomlConfig(root);
    assert.ok(resolved);
    assert.match(resolved.sourcePath.replace(/\\/g, '/'), /config\.toml$/);
    assert.doesNotMatch(resolved.sourcePath.replace(/\\/g, '/'), /\.local\.toml$/);
    const config = loadDatabaseConfig(root);
    assert.equal(config?.host, 'base');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy split database.toml still works when unified is absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'html-video-legacy-split-'));
  try {
    mkdirSync(join(root, 'config'));
    writeFileSync(
      join(root, 'config', 'database.toml'),
      '[database]\nenabled = false\nhost = "split"\nname = "n"\nuser = "u"\npassword = "p"\n',
      'utf8',
    );
    writeFileSync(
      join(root, 'config', 'database.local.toml'),
      '[database]\nenabled = true\npassword = "local"\n',
      'utf8',
    );
    const config = loadDatabaseConfig(root);
    assert.equal(config?.host, 'split');
    assert.equal(config?.password, 'local');
    assert.equal(config?.enabled, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Loading order: local → legacy → base. Legacy secrets still win until migrated.
test('resolveTomlConfig prefers legacy over base-only config', () => {
  const root = mkdtempSync(join(tmpdir(), 'html-video-legacy-'));
  try {
    mkdirSync(join(root, 'config'));
    mkdirSync(join(root, '.html-video'));
    writeFileSync(
      join(root, 'config', 'database.toml'),
      '[database]\nenabled = false\nhost = "base"\nname = "n"\nuser = "u"\npassword = "base"\n',
      'utf8',
    );
    writeFileSync(
      join(root, '.html-video', 'database.toml'),
      '[database]\nenabled = true\nhost = "legacy"\nname = "n"\nuser = "u"\npassword = "legacy"\n',
      'utf8',
    );
    const resolved = resolveTomlConfig(root, 'database');
    assert.ok(resolved);
    assert.match(resolved.sourcePath.replace(/\\/g, '/'), /\.html-video\/database\.toml$/);
    const config = loadDatabaseConfig(root);
    assert.equal(config?.host, 'legacy');
    assert.equal(config?.enabled, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveTomlConfig local overrides legacy', () => {
  const root = mkdtempSync(join(tmpdir(), 'html-video-local-first-'));
  try {
    mkdirSync(join(root, 'config'));
    mkdirSync(join(root, '.html-video'));
    writeFileSync(
      join(root, 'config', 'database.toml'),
      '[database]\nenabled = false\nhost = "base"\nname = "n"\nuser = "u"\npassword = "base"\n',
      'utf8',
    );
    writeFileSync(
      join(root, 'config', 'database.local.toml'),
      '[database]\nenabled = true\nhost = "local"\npassword = "local"\n',
      'utf8',
    );
    writeFileSync(
      join(root, '.html-video', 'database.toml'),
      '[database]\nenabled = true\nhost = "legacy"\nname = "n"\nuser = "u"\npassword = "legacy"\n',
      'utf8',
    );
    const config = loadDatabaseConfig(root);
    assert.equal(config?.host, 'local');
    assert.equal(config?.password, 'local');
    assert.equal(config?.name, 'n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mergeSimpleToml prefers local keys', () => {
  const merged = mergeSimpleToml(
    '[database]\nenabled = false\npassword = "base"\n',
    '[database]\nenabled = true\npassword = "local"\n',
  );
  assert.match(merged, /enabled = true/);
  assert.match(merged, /password = "local"/);
  assert.doesNotMatch(merged, /password = "base"/);
});

test('mergeUnifiedToml replaces auth.users from local when present', () => {
  const merged = mergeUnifiedToml(
    `
[auth]
password = "base"

[[auth.users]]
user_id = "admin"
display_name = "Base Admin"
`.trim(),
    `
[auth]
password = "local"

[[auth.users]]
user_id = "alice"
display_name = "Alice"
`.trim(),
  );
  assert.match(merged, /password = "local"/);
  assert.match(merged, /user_id = "alice"/);
  assert.doesNotMatch(merged, /user_id = "admin"/);
});

test('parseAgentTomlSection maps snake_case to HV_PI_*', () => {
  const parsed = parseAgentTomlSection(`
[agent]
api_key = "sk-test"
base_url = "https://example.com/v1"
model = "qwen-test"
max_tokens = 8192
`);
  assert.deepEqual(parsed, {
    HV_PI_API_KEY: 'sk-test',
    HV_PI_BASE_URL: 'https://example.com/v1',
    HV_PI_MODEL: 'qwen-test',
    HV_PI_MAX_TOKENS: '8192',
  });
});
