'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_LINK_CHARS = 2_048;
const ATTACHMENT_ID_PATTERN = /^attachment-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;
const MANIFEST_SCHEMA_VERSION = 1;
const MANIFEST_FILENAME = 'manifest-v1.json';
const RESERVATION_STATUSES = new Set(['submitting', 'accepted', 'unknown']);

const EXTENSION_MIME_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.pdf', 'application/pdf'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.ipynb', 'application/x-ipynb+json'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.csv', 'text/csv'],
  ['.tsv', 'text/tab-separated-values'],
  ['.json', 'application/json'],
  ['.jsonl', 'application/x-ndjson'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
  ['.xml', 'application/xml'],
  ['.html', 'text/html'],
  ['.css', 'text/css'],
  ['.js', 'text/javascript'],
  ['.jsx', 'text/jsx'],
  ['.mjs', 'text/javascript'],
  ['.cjs', 'text/javascript'],
  ['.ts', 'text/typescript'],
  ['.tsx', 'text/tsx'],
  ['.py', 'text/x-python'],
  ['.rs', 'text/x-rust'],
  ['.go', 'text/x-go'],
  ['.java', 'text/x-java-source'],
  ['.kt', 'text/x-kotlin'],
  ['.swift', 'text/x-swift'],
  ['.c', 'text/x-c'],
  ['.h', 'text/x-c'],
  ['.cpp', 'text/x-c++'],
  ['.hpp', 'text/x-c++'],
  ['.sh', 'text/x-shellscript'],
  ['.zsh', 'text/x-shellscript'],
  ['.sql', 'application/sql'],
  ['.toml', 'application/toml'],
]);

const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

class ConversationAttachmentStore {
  constructor({ rootDir, fsPromises = fsp } = {}) {
    if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) {
      throw new Error('附件暂存目录无效');
    }
    this.rootDir = rootDir;
    this.fs = fsPromises;
    this.records = new Map();
    this.initialized = false;
    this.persistPromise = Promise.resolve();
  }

  async initialize() {
    await this.fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await this.fs.chmod?.(this.rootDir, 0o700).catch(() => {});
    const restored = await this.#restoreManifest().catch(() => false);
    if (!restored) {
      await this.fs.rm(this.rootDir, { recursive: true, force: true });
      await this.fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      this.records.clear();
    }
    this.initialized = true;
    await this.#persistManifest();
  }

  list({ accountId, agentId }) {
    const scope = attachmentScope(accountId, agentId);
    return [...this.records.values()]
      .filter((record) => record.scope === scope && !record.reservation)
      .map(publicAttachment);
  }

  listReservations({ accountId, agentId, sessionId = null }) {
    const scope = attachmentScope(accountId, agentId);
    const requestedSessionId = sessionId === null ? null : validatePrivateValue(sessionId, '会话标识');
    const grouped = new Map();
    for (const record of this.records.values()) {
      const reservation = record.scope === scope ? record.reservation : null;
      if (!reservation || (requestedSessionId && reservation.sessionId !== requestedSessionId)) continue;
      const key = `${reservation.sessionId}\u0000${reservation.promptId}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          sessionId: reservation.sessionId,
          promptId: reservation.promptId,
          status: reservation.status,
          attachments: [],
        });
      }
      grouped.get(key).attachments.push(publicAttachment(record));
    }
    return [...grouped.values()].map((reservation) => ({
      ...reservation,
      attachments: reservation.attachments.map((attachment) => ({ ...attachment })),
    }));
  }

  async stagePaths({ accountId, agentId, paths }) {
    this.#requireInitialized();
    const scope = attachmentScope(accountId, agentId);
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_ATTACHMENTS) {
      throw new Error('请选择 1 至 10 个文件');
    }
    const staged = [];
    const createdIds = [];
    try {
      for (const sourcePath of paths) {
        if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) {
          throw new Error('所选文件无效');
        }
        const handle = await this.fs.open(
          sourcePath,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
        );
        let bytes;
        let stat;
        try {
          stat = await handle.stat();
          if (!stat.isFile()) throw new Error('暂不支持文件夹，请选择具体文件');
          validateFileSize(stat.size);
          bytes = await handle.readFile();
        } finally {
          await handle.close();
        }
        const before = new Set(this.records.keys());
        const record = await this.#stageBytes(scope, {
          name: path.basename(sourcePath),
          mimeType: mimeForName(sourcePath),
          bytes,
        });
        staged.push(record);
        if (!before.has(record.attachmentId)) createdIds.push(record.attachmentId);
      }
      await this.#persistManifest();
      return staged.map(publicAttachment);
    } catch (error) {
      await this.#removeRecords(createdIds);
      await this.#persistManifest().catch(() => {});
      throw error;
    }
  }

  async stageBytes({ accountId, agentId, items }) {
    this.#requireInitialized();
    const scope = attachmentScope(accountId, agentId);
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ATTACHMENTS) {
      throw new Error('请选择 1 至 10 个文件');
    }
    const staged = [];
    const createdIds = [];
    try {
      for (const item of items) {
        const bytes = normalizeBytes(item?.bytes);
        const before = new Set(this.records.keys());
        const record = await this.#stageBytes(scope, {
          name: item?.name,
          mimeType: item?.mimeType,
          bytes,
        });
        staged.push(record);
        if (!before.has(record.attachmentId)) createdIds.push(record.attachmentId);
      }
      await this.#persistManifest();
      return staged.map(publicAttachment);
    } catch (error) {
      await this.#removeRecords(createdIds);
      await this.#persistManifest().catch(() => {});
      throw error;
    }
  }

  async stageLink({ accountId, agentId, url }) {
    this.#requireInitialized();
    const scope = attachmentScope(accountId, agentId);
    const normalized = normalizeLink(url);
    const duplicate = [...this.records.values()].find(
      (record) => (
        record.scope === scope
        && !record.reservation
        && record.kind === 'link'
        && record.url === normalized
      ),
    );
    if (duplicate) return publicAttachment(duplicate);
    this.#ensureCapacity(scope, 0);
    const parsed = new URL(normalized);
    const record = {
      attachmentId: `attachment-${crypto.randomUUID()}`,
      scope,
      kind: 'link',
      name: parsed.hostname,
      mimeType: 'text/uri-list',
      sizeBytes: Buffer.byteLength(normalized),
      url: normalized,
    };
    this.records.set(record.attachmentId, record);
    await this.#persistManifest();
    return publicAttachment(record);
  }

  async discard({ accountId, agentId, attachmentId }) {
    const scope = attachmentScope(accountId, agentId);
    const record = this.#ownedRecord(scope, attachmentId);
    if (record.reservation) throw new Error('附件已用于待处理消息，不能移除');
    await this.#removeRecords([record.attachmentId]);
    await this.#persistManifest();
    return this.list({ accountId, agentId });
  }

  async preparePrompt({ accountId, agentId, text, attachmentIds }) {
    this.#requireInitialized();
    const scope = attachmentScope(accountId, agentId);
    if (!Array.isArray(attachmentIds) || attachmentIds.length > MAX_ATTACHMENTS) {
      throw new Error('附件数量无效');
    }
    const uniqueIds = [...new Set(attachmentIds)];
    if (uniqueIds.length !== attachmentIds.length) throw new Error('附件列表无效');
    const records = uniqueIds.map((id) => this.#ownedDraftRecord(scope, id));
    const prompt = await this.#buildPrompt(text, records);
    return { prompt, attachmentIds: uniqueIds };
  }

  async reservePrompt({
    accountId,
    agentId,
    sessionId,
    promptId,
    text,
    attachmentIds,
  }) {
    this.#requireInitialized();
    const scope = attachmentScope(accountId, agentId);
    const privateSessionId = validatePrivateValue(sessionId, '会话标识');
    const privatePromptId = validatePrivateValue(promptId, '消息标识');
    if (!Array.isArray(attachmentIds) || attachmentIds.length > MAX_ATTACHMENTS) {
      throw new Error('附件数量无效');
    }
    const uniqueIds = [...new Set(attachmentIds)];
    if (uniqueIds.length !== attachmentIds.length) throw new Error('附件列表无效');
    const records = uniqueIds.map((id) => this.#ownedDraftRecord(scope, id));
    const reservation = {
      sessionId: privateSessionId,
      promptId: privatePromptId,
      status: 'submitting',
    };
    for (const record of records) record.reservation = { ...reservation };
    await this.#persistManifest();
    try {
      const prompt = await this.#buildPrompt(text, records);
      return { prompt, attachmentIds: uniqueIds, promptId: privatePromptId };
    } catch (error) {
      for (const record of records) delete record.reservation;
      await this.#persistManifest().catch(() => {});
      throw error;
    }
  }

  async markReservationAccepted({ accountId, agentId, sessionId, promptId }) {
    return this.#setReservationStatus({
      accountId,
      agentId,
      sessionId,
      promptId,
      status: 'accepted',
    });
  }

  async markReservationUnknown({ accountId, agentId, sessionId, promptId }) {
    return this.#setReservationStatus({
      accountId,
      agentId,
      sessionId,
      promptId,
      status: 'unknown',
    });
  }

  async releaseReservation({ accountId, agentId, sessionId, promptId }) {
    const records = this.#reservationRecords({ accountId, agentId, sessionId, promptId });
    for (const record of records) delete record.reservation;
    await this.#persistManifest();
    return this.list({ accountId, agentId });
  }

  async consumeReservation({ accountId, agentId, sessionId, promptId }) {
    const records = this.#reservationRecords({ accountId, agentId, sessionId, promptId });
    await this.#removeRecords(records.map((record) => record.attachmentId));
    await this.#persistManifest();
  }

  async #buildPrompt(text, records) {
    const promptText = promptTextWithAttachmentSummary(text, records);
    const prompt = [{ type: 'text', text: promptText }];
    for (const record of records) {
      if (record.kind === 'link') {
        prompt.push({
          type: 'resource_link',
          name: record.name,
          title: record.url,
          uri: record.url,
          _meta: { agentmesh360: { kind: 'user_link' } },
        });
        continue;
      }
      const bytes = await this.fs.readFile(record.stagedPath);
      if (bytes.byteLength !== record.sizeBytes) throw new Error('附件暂存内容已变化，请重新添加');
      if (record.kind === 'image') {
        validateImageSignature(bytes, record.mimeType);
        prompt.push({
          type: 'image',
          data: bytes.toString('base64'),
          mimeType: record.mimeType,
        });
        continue;
      }
      const uri = `file:///agentmesh360-attachment/${encodeURIComponent(record.name)}`;
      if (record.encoding === 'utf8') {
        prompt.push({
          type: 'resource',
          resource: {
            uri,
            mimeType: record.mimeType,
            text: bytes.toString('utf8'),
          },
        });
      } else {
        prompt.push({
          type: 'resource',
          resource: {
            uri,
            mimeType: record.mimeType,
            blob: bytes.toString('base64'),
          },
        });
      }
    }
    return prompt;
  }

  async consume({ accountId, agentId, attachmentIds }) {
    const scope = attachmentScope(accountId, agentId);
    const ids = [...new Set(Array.isArray(attachmentIds) ? attachmentIds : [])];
    for (const id of ids) this.#ownedDraftRecord(scope, id);
    await this.#removeRecords(ids);
    await this.#persistManifest();
  }

  async clearAccount(accountId) {
    const prefix = `${String(accountId)}\u0000`;
    const ids = [...this.records.values()]
      .filter((record) => record.scope.startsWith(prefix))
      .map((record) => record.attachmentId);
    await this.#removeRecords(ids);
    await this.#persistManifest();
  }

  async clearAll() {
    const ids = [...this.records.keys()];
    await this.#removeRecords(ids);
    await this.#persistManifest();
  }

  async dispose() {
    if (this.initialized) await this.#persistManifest().catch(() => {});
    this.records.clear();
    this.initialized = false;
  }

  async #stageBytes(scope, { name, mimeType, bytes }) {
    const safeName = sanitizeFilename(name);
    validateFileSize(bytes.byteLength);
    const inferredMime = mimeForName(safeName);
    const providedMime = normalizeMimeType(mimeType);
    const resolvedMime = IMAGE_MIME_TYPES.has(inferredMime)
      ? inferredMime
      : providedMime && providedMime !== 'application/octet-stream'
        ? providedMime
        : inferredMime;
    const kind = IMAGE_MIME_TYPES.has(resolvedMime) ? 'image' : 'file';
    if (kind === 'image') validateImageSignature(bytes, resolvedMime);
    validateSupportedFile(safeName, resolvedMime, bytes, kind);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const duplicate = [...this.records.values()].find(
      (record) => (
        record.scope === scope
        && !record.reservation
        && record.digest === digest
        && record.name === safeName
      ),
    );
    if (duplicate) return duplicate;
    this.#ensureCapacity(scope, bytes.byteLength);
    const attachmentId = `attachment-${crypto.randomUUID()}`;
    const stagedPath = path.join(this.rootDir, `${attachmentId}.bin`);
    await this.fs.writeFile(stagedPath, bytes, { mode: 0o600, flag: 'wx' });
    const record = {
      attachmentId,
      scope,
      kind,
      name: safeName,
      mimeType: resolvedMime,
      sizeBytes: bytes.byteLength,
      stagedPath,
      digest,
      encoding: kind === 'file' && isSafeUtf8(bytes, resolvedMime) ? 'utf8' : 'base64',
    };
    this.records.set(attachmentId, record);
    return record;
  }

  #ensureCapacity(scope, addedBytes) {
    const records = [...this.records.values()].filter((record) => record.scope === scope);
    const drafts = records.filter((record) => !record.reservation);
    if (drafts.length >= MAX_ATTACHMENTS) throw new Error('每条消息最多添加 10 个附件');
    const currentBytes = records.reduce((sum, record) => sum + record.sizeBytes, 0);
    if (currentBytes + addedBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error('附件合计不能超过 50 MB');
    }
  }

  #ownedRecord(scope, attachmentId) {
    if (typeof attachmentId !== 'string' || !ATTACHMENT_ID_PATTERN.test(attachmentId)) {
      throw new Error('附件标识无效');
    }
    const record = this.records.get(attachmentId);
    if (!record || record.scope !== scope) throw new Error('附件不存在或不属于当前 Agent');
    return record;
  }

  #ownedDraftRecord(scope, attachmentId) {
    const record = this.#ownedRecord(scope, attachmentId);
    if (record.reservation) throw new Error('附件已用于另一条待处理消息');
    return record;
  }

  #reservationRecords({ accountId, agentId, sessionId, promptId }) {
    const scope = attachmentScope(accountId, agentId);
    const privateSessionId = validatePrivateValue(sessionId, '会话标识');
    const privatePromptId = validatePrivateValue(promptId, '消息标识');
    return [...this.records.values()].filter((record) => (
      record.scope === scope
      && record.reservation?.sessionId === privateSessionId
      && record.reservation?.promptId === privatePromptId
    ));
  }

  async #setReservationStatus({ accountId, agentId, sessionId, promptId, status }) {
    if (!RESERVATION_STATUSES.has(status)) throw new Error('附件预留状态无效');
    const records = this.#reservationRecords({ accountId, agentId, sessionId, promptId });
    for (const record of records) record.reservation.status = status;
    await this.#persistManifest();
    return records.length;
  }

  async #restoreManifest() {
    const manifestPath = path.join(this.rootDir, MANIFEST_FILENAME);
    let parsed;
    try {
      parsed = JSON.parse(await this.fs.readFile(manifestPath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    if (
      parsed?.schemaVersion !== MANIFEST_SCHEMA_VERSION
      || !Array.isArray(parsed.records)
      || parsed.records.length > 1_000
    ) {
      throw new Error('附件暂存清单无效');
    }
    const restored = new Map();
    for (const value of parsed.records) {
      const record = await this.#restoreRecord(value);
      if (restored.has(record.attachmentId)) throw new Error('附件暂存清单重复');
      restored.set(record.attachmentId, record);
    }
    const scopeTotals = new Map();
    const scopeDraftCounts = new Map();
    for (const record of restored.values()) {
      scopeTotals.set(record.scope, (scopeTotals.get(record.scope) || 0) + record.sizeBytes);
      if (!record.reservation) {
        scopeDraftCounts.set(record.scope, (scopeDraftCounts.get(record.scope) || 0) + 1);
      }
    }
    if (
      [...scopeTotals.values()].some((total) => total > MAX_TOTAL_ATTACHMENT_BYTES)
      || [...scopeDraftCounts.values()].some((count) => count > MAX_ATTACHMENTS)
    ) {
      throw new Error('附件暂存容量无效');
    }
    this.records = restored;
    const expectedFiles = new Set([
      MANIFEST_FILENAME,
      ...[...restored.values()]
        .filter((record) => record.stagedPath)
        .map((record) => path.basename(record.stagedPath)),
    ]);
    for (const name of await this.fs.readdir(this.rootDir)) {
      if (!expectedFiles.has(name)) {
        await this.fs.rm(path.join(this.rootDir, name), { recursive: true, force: true });
      }
    }
    return true;
  }

  async #restoreRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('附件暂存记录无效');
    }
    const attachmentId = value.attachmentId;
    const scope = validateStoredScope(value.scope);
    if (!ATTACHMENT_ID_PATTERN.test(attachmentId || '')) throw new Error('附件暂存标识无效');
    const kind = value.kind;
    if (!['image', 'file', 'link'].includes(kind)) throw new Error('附件暂存类型无效');
    const name = sanitizeFilename(value.name);
    const mimeType = normalizeMimeType(value.mimeType);
    validateFileSize(value.sizeBytes);
    const reservation = value.reservation === null || value.reservation === undefined
      ? null
      : restoreReservation(value.reservation);
    if (kind === 'link') {
      const url = normalizeLink(value.url);
      if (value.sizeBytes !== Buffer.byteLength(url)) throw new Error('附件链接大小无效');
      return { attachmentId, scope, kind, name, mimeType, sizeBytes: value.sizeBytes, url, ...(reservation ? { reservation } : {}) };
    }
    const digest = typeof value.digest === 'string' && /^[0-9a-f]{64}$/.test(value.digest)
      ? value.digest
      : null;
    const encoding = ['utf8', 'base64'].includes(value.encoding) ? value.encoding : null;
    if (!digest || !encoding) throw new Error('附件暂存内容信息无效');
    const stagedPath = path.join(this.rootDir, `${attachmentId}.bin`);
    const bytes = await this.fs.readFile(stagedPath);
    validateFileSize(bytes.byteLength);
    if (bytes.byteLength !== value.sizeBytes) throw new Error('附件暂存大小无效');
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== digest) {
      throw new Error('附件暂存内容校验失败');
    }
    if (kind === 'image') validateImageSignature(bytes, mimeType);
    return {
      attachmentId,
      scope,
      kind,
      name,
      mimeType,
      sizeBytes: value.sizeBytes,
      stagedPath,
      digest,
      encoding,
      ...(reservation ? { reservation } : {}),
    };
  }

  async #persistManifest() {
    if (!this.initialized && this.records.size === 0) return;
    const records = [...this.records.values()].map(manifestRecord);
    const payload = `${JSON.stringify({ schemaVersion: MANIFEST_SCHEMA_VERSION, records })}\n`;
    const manifestPath = path.join(this.rootDir, MANIFEST_FILENAME);
    const tempPath = path.join(
      this.rootDir,
      `.manifest-${process.pid}-${crypto.randomUUID()}.tmp`,
    );
    const operation = async () => {
      await this.fs.writeFile(tempPath, payload, { mode: 0o600, flag: 'wx' });
      try {
        await this.fs.rename(tempPath, manifestPath);
        await this.fs.chmod?.(manifestPath, 0o600).catch(() => {});
      } finally {
        await this.fs.rm(tempPath, { force: true }).catch(() => {});
      }
    };
    this.persistPromise = this.persistPromise.catch(() => {}).then(operation);
    return this.persistPromise;
  }

  async #removeRecords(ids) {
    for (const id of ids) {
      const record = this.records.get(id);
      if (!record) continue;
      this.records.delete(id);
      if (record.stagedPath) await this.fs.rm(record.stagedPath, { force: true });
    }
  }

  #requireInitialized() {
    if (!this.initialized) throw new Error('附件服务尚未就绪');
  }
}

function attachmentScope(accountId, agentId) {
  const account = String(accountId ?? '');
  const agent = String(agentId ?? '');
  if (!account || account.length > 200 || CONTROL_CHAR_PATTERN.test(account)) {
    throw new Error('附件账号范围无效');
  }
  if (!/^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$/.test(agent)) {
    throw new Error('附件 Agent 范围无效');
  }
  return `${account}\u0000${agent}`;
}

function normalizeBytes(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new Error('附件内容无效');
}

function sanitizeFilename(value) {
  const name = typeof value === 'string' ? path.basename(value).trim() : '';
  if (!name || name.length > 180 || CONTROL_CHAR_PATTERN.test(name) || name === '.' || name === '..') {
    throw new Error('附件文件名无效');
  }
  return name;
}

function normalizeMimeType(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(normalized)
    ? normalized
    : '';
}

function mimeForName(value) {
  return EXTENSION_MIME_TYPES.get(path.extname(String(value)).toLowerCase())
    || 'application/octet-stream';
}

function validateFileSize(size) {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('不能添加空文件');
  if (size > MAX_ATTACHMENT_BYTES) throw new Error('单个附件不能超过 20 MB');
}

function validateSupportedFile(name, mimeType, bytes, kind) {
  if (kind === 'image') return;
  const extension = path.extname(name).toLowerCase();
  if (EXTENSION_MIME_TYPES.has(extension)) return;
  if (mimeType.startsWith('text/') || isSafeUtf8(bytes, mimeType)) return;
  throw new Error(`暂不支持 ${extension || '此类型'} 文件`);
}

function validateImageSignature(bytes, mimeType) {
  const isPng = bytes.length >= 8 && bytes.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isWebp = bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  const header = bytes.subarray(0, 6).toString('ascii');
  const isGif = header === 'GIF87a' || header === 'GIF89a';
  const matches = {
    'image/png': isPng,
    'image/jpeg': isJpeg,
    'image/webp': isWebp,
    'image/gif': isGif,
  }[mimeType];
  if (!matches) throw new Error('图片内容与文件类型不一致');
}

function isSafeUtf8(bytes, mimeType) {
  if (mimeType === 'application/pdf' || mimeType.startsWith('application/vnd.')) return false;
  if (bytes.includes(0)) return false;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) return false;
    return true;
  } catch {
    return false;
  }
}

function normalizeLink(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > MAX_LINK_CHARS || CONTROL_CHAR_PATTERN.test(raw)) {
    throw new Error('链接无效');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('请输入完整的 http 或 https 链接');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('只支持不含账号密码的 http 或 https 链接');
  }
  parsed.hash = '';
  return parsed.toString();
}

function promptTextWithAttachmentSummary(text, records) {
  const trimmed = String(text || '').trim();
  const base = trimmed || '请查看我附加的内容。';
  if (!records.length) return base;
  const lines = records.map((record) => {
    if (record.kind === 'link') return `- 链接：${record.name}`;
    return `- ${record.kind === 'image' ? '图片' : '文件'}：${record.name}`;
  });
  return `${base}\n\n[本条消息附带内容]\n${lines.join('\n')}`;
}

function publicAttachment(record) {
  return {
    attachmentId: record.attachmentId,
    kind: record.kind,
    name: record.name,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
  };
}

function validatePrivateValue(value, label) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 200
    || CONTROL_CHAR_PATTERN.test(value)
  ) {
    throw new Error(`${label}无效`);
  }
  return value;
}

function validateStoredScope(value) {
  if (typeof value !== 'string' || value.length > 400) throw new Error('附件暂存范围无效');
  const separator = value.indexOf('\u0000');
  if (separator < 1 || separator !== value.lastIndexOf('\u0000')) {
    throw new Error('附件暂存范围无效');
  }
  const accountId = value.slice(0, separator);
  const agentId = value.slice(separator + 1);
  if (attachmentScope(accountId, agentId) !== value) throw new Error('附件暂存范围无效');
  return value;
}

function restoreReservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('附件预留记录无效');
  }
  const status = RESERVATION_STATUSES.has(value.status) ? value.status : null;
  if (!status) throw new Error('附件预留状态无效');
  return {
    sessionId: validatePrivateValue(value.sessionId, '会话标识'),
    promptId: validatePrivateValue(value.promptId, '消息标识'),
    status,
  };
}

function manifestRecord(record) {
  return {
    attachmentId: record.attachmentId,
    scope: record.scope,
    kind: record.kind,
    name: record.name,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    ...(record.url ? { url: record.url } : {}),
    ...(record.digest ? { digest: record.digest } : {}),
    ...(record.encoding ? { encoding: record.encoding } : {}),
    ...(record.reservation ? { reservation: { ...record.reservation } } : {}),
  };
}

module.exports = {
  ATTACHMENT_ID_PATTERN,
  ConversationAttachmentStore,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  normalizeLink,
  promptTextWithAttachmentSummary,
  publicAttachment,
};
