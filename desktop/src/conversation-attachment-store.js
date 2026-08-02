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
  }

  async initialize() {
    await this.fs.rm(this.rootDir, { recursive: true, force: true });
    await this.fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    this.initialized = true;
  }

  list({ accountId, agentId }) {
    const scope = attachmentScope(accountId, agentId);
    return [...this.records.values()]
      .filter((record) => record.scope === scope)
      .map(publicAttachment);
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
      return staged.map(publicAttachment);
    } catch (error) {
      await this.#removeRecords(createdIds);
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
      return staged.map(publicAttachment);
    } catch (error) {
      await this.#removeRecords(createdIds);
      throw error;
    }
  }

  stageLink({ accountId, agentId, url }) {
    this.#requireInitialized();
    const scope = attachmentScope(accountId, agentId);
    const normalized = normalizeLink(url);
    const duplicate = [...this.records.values()].find(
      (record) => record.scope === scope && record.kind === 'link' && record.url === normalized,
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
    return publicAttachment(record);
  }

  async discard({ accountId, agentId, attachmentId }) {
    const scope = attachmentScope(accountId, agentId);
    const record = this.#ownedRecord(scope, attachmentId);
    await this.#removeRecords([record.attachmentId]);
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
    const records = uniqueIds.map((id) => this.#ownedRecord(scope, id));
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
    return { prompt, attachmentIds: uniqueIds };
  }

  async consume({ accountId, agentId, attachmentIds }) {
    const scope = attachmentScope(accountId, agentId);
    const ids = [...new Set(Array.isArray(attachmentIds) ? attachmentIds : [])];
    for (const id of ids) this.#ownedRecord(scope, id);
    await this.#removeRecords(ids);
  }

  async clearAccount(accountId) {
    const prefix = `${String(accountId)}\u0000`;
    const ids = [...this.records.values()]
      .filter((record) => record.scope.startsWith(prefix))
      .map((record) => record.attachmentId);
    await this.#removeRecords(ids);
  }

  async clearAll() {
    const ids = [...this.records.keys()];
    await this.#removeRecords(ids);
  }

  async dispose() {
    this.records.clear();
    if (!this.initialized) return;
    this.initialized = false;
    await this.fs.rm(this.rootDir, { recursive: true, force: true });
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
      (record) => record.scope === scope && record.digest === digest && record.name === safeName,
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
    if (records.length >= MAX_ATTACHMENTS) throw new Error('每条消息最多添加 10 个附件');
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
