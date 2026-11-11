import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../server/config.js';

function fixture(t, contents) {
  const directory = mkdtempSync(path.join(tmpdir(), 'lan-room-env-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, '.env');
  if (contents !== undefined) writeFileSync(file, contents);
  return file;
}

test('missing env file uses the existing default address', t => {
  assert.deepEqual(loadConfig(fixture(t), {}), {
    host: '0.0.0.0', port: 8181, maxEncryptedMembers: 100, maxPlainMembers: 100,
  });
});

test('env file supports quoted values and comments', t => {
  const file = fixture(t, '# Local server\nPORT="9321" # Port\nHOST=127.0.0.1\n');
  assert.equal(loadConfig(file, {}).port, 9321);
  assert.equal(loadConfig(file, {}).host, '127.0.0.1');
});

test('system variables override env file values without mutating the environment', t => {
  const file = fixture(t, 'PORT=9321\nHOST=0.0.0.0\n');
  const env = { PORT: '9322', HOST: '127.0.0.1' };
  assert.equal(loadConfig(file, env).port, 9322);
  assert.equal(loadConfig(file, env).host, '127.0.0.1');
  assert.deepEqual(env, { PORT: '9322', HOST: '127.0.0.1' });
});

test('invalid ports fail clearly instead of listening on an unexpected port', t => {
  const file = fixture(t);
  for (const port of ['', '0', '-1', '65536', 'abc', '9000.5', '1e3', '0x2000']) {
    assert.throws(() => loadConfig(file, { PORT: port }), /PORT.*1.*65535/);
  }
  assert.equal(loadConfig(file, { PORT: '1' }).port, 1);
  assert.equal(loadConfig(file, { PORT: '65535' }).port, 65535);
});

test('invalid ports from env files are rejected too', t => {
  assert.throws(() => loadConfig(fixture(t, 'PORT=invalid\n'), {}), /PORT.*1.*65535/);
});

test('development server uses shared config with strict port binding', async () => {
  const { default: config } = await import('../vite.config.js');
  const { host, port } = loadConfig();
  assert.deepEqual(config.server, { host, port, strictPort: true });
});

test('room capacity defaults, file values and environment precedence are independent', t => {
  const file = fixture(t, 'MAX_ENCRYPTED_MEMBERS=150\nMAX_PLAIN_MEMBERS=200\n');
  assert.equal(loadConfig(file, {}).maxEncryptedMembers, 150);
  assert.equal(loadConfig(file, {}).maxPlainMembers, 200);
  const config = loadConfig(file, { MAX_ENCRYPTED_MEMBERS: '50' });
  assert.equal(config.maxEncryptedMembers, 50);
  assert.equal(config.maxPlainMembers, 200);
});

test('room capacity rejects invalid or unsafe integers instead of ignoring limits', t => {
  const file = fixture(t);
  for (const key of ['MAX_ENCRYPTED_MEMBERS', 'MAX_PLAIN_MEMBERS']) {
    for (const value of ['', '0', '-1', '1.5', '1e3', 'Infinity', '9007199254740992']) {
      assert.throws(() => loadConfig(file, { [key]: value }), new RegExp(key));
    }
    assert.throws(() => loadConfig(fixture(t, `${key}=invalid\n`), {}), new RegExp(key));
    assert.equal(loadConfig(file, { [key]: '1' })[
      key === 'MAX_ENCRYPTED_MEMBERS' ? 'maxEncryptedMembers' : 'maxPlainMembers'
    ], 1);
  }
});
