'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STORE_SCHEMA_VERSION = 1;

class SecureTokenStore {
  constructor({ safeStorage, filePath, fsModule = fs }) {
    if (!safeStorage) throw new Error('Electron safeStorage is required');
    if (!filePath) throw new Error('secure token file path is required');
    this.safeStorage = safeStorage;
    this.filePath = filePath;
    this.fs = fsModule;
  }

  isAvailable() {
    return Boolean(this.safeStorage.isEncryptionAvailable());
  }

  backend() {
    return typeof this.safeStorage.getSelectedStorageBackend === 'function'
      ? this.safeStorage.getSelectedStorageBackend()
      : 'os-credential-store';
  }

  loadRefreshToken() {
    if (!this.fs.existsSync(this.filePath)) return null;
    this.#requireAvailable();
    try {
      const stored = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'));
      if (stored.schemaVersion !== STORE_SCHEMA_VERSION || typeof stored.ciphertext !== 'string') {
        throw new Error('unsupported secure token record');
      }
      const plaintext = this.safeStorage.decryptString(Buffer.from(stored.ciphertext, 'base64'));
      return plaintext || null;
    } catch (error) {
      this.clear();
      throw new Error(`无法读取系统安全存储：${error.message}`);
    }
  }

  saveRefreshToken(refreshToken) {
    if (typeof refreshToken !== 'string' || refreshToken.length < 8) {
      throw new Error('refresh token is invalid');
    }
    this.#requireAvailable();
    const encrypted = this.safeStorage.encryptString(refreshToken);
    const payload = JSON.stringify({
      schemaVersion: STORE_SCHEMA_VERSION,
      backend: this.backend(),
      ciphertext: Buffer.from(encrypted).toString('base64'),
    });
    this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    this.fs.writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600 });
    this.fs.chmodSync(temporary, 0o600);
    this.fs.renameSync(temporary, this.filePath);
  }

  clear() {
    try {
      this.fs.unlinkSync(this.filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  #requireAvailable() {
    if (!this.isAvailable()) {
      throw new Error('系统安全存储不可用，AgentMesh360 不会以明文保存登录凭据');
    }
  }
}

module.exports = { SecureTokenStore, STORE_SCHEMA_VERSION };
