'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SecureTokenStore } = require('../src/auth/secure-token-store');

test('refresh token is encrypted at rest with owner-only permissions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh360-token-'));
  const filePath = path.join(directory, 'identity', 'refresh.secure.json');
  const store = new SecureTokenStore({ safeStorage: fakeSafeStorage(), filePath });

  store.saveRefreshToken('refresh-token-private');

  const stored = fs.readFileSync(filePath, 'utf8');
  assert.equal(stored.includes('refresh-token-private'), false);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.equal(store.loadRefreshToken(), 'refresh-token-private');
  store.clear();
  assert.equal(fs.existsSync(filePath), false);
});

test('plaintext fallback is refused when the OS secure store is unavailable', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh360-token-'));
  const filePath = path.join(directory, 'refresh.secure.json');
  const safeStorage = fakeSafeStorage();
  safeStorage.isEncryptionAvailable = () => false;
  const store = new SecureTokenStore({ safeStorage, filePath });

  assert.throws(() => store.saveRefreshToken('refresh-token-private'), /不会以明文保存/);
  assert.equal(fs.existsSync(filePath), false);
});

test('corrupt secure records are removed instead of repeatedly reused', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh360-token-'));
  const filePath = path.join(directory, 'refresh.secure.json');
  fs.writeFileSync(filePath, '{broken', { mode: 0o600 });
  const store = new SecureTokenStore({ safeStorage: fakeSafeStorage(), filePath });

  assert.throws(() => store.loadRefreshToken(), /无法读取系统安全存储/);
  assert.equal(fs.existsSync(filePath), false);
});

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test-keychain',
    encryptString: (value) => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),
    decryptString: (value) => Buffer.from(value.toString().slice('encrypted:'.length), 'base64').toString(),
  };
}
