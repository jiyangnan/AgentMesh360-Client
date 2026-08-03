'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const {
  MAX_ATTACHMENT_BYTES,
} = require('./conversation-attachment-store');

const MANIFEST_FILENAME = 'workspace-authority-v1.json';
const MANIFEST_SCHEMA_VERSION = 1;
const MAX_AUTHORIZED_ROOTS_PER_SCOPE = 16;
const MAX_QUERY_CHARS = 200;
const MAX_RELATIVE_PATH_CHARS = 1_024;
const MAX_SEARCH_RESULTS = 50;
const DEFAULT_SEARCH_RESULTS = 20;
const MAX_SCAN_ENTRIES = 4_000;
const MAX_DIRECTORY_DEPTH = 16;
const WORKSPACE_ID_PATTERN = /^workspace-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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

/**
 * Main-process-only authority for user-approved workspace roots.
 *
 * Absolute roots and canonical file paths intentionally never appear in public
 * projections. Renderer-facing callers operate with an opaque workspaceId and
 * a validated relative path only.
 */
class WorkspaceAuthorityStore {
  constructor({ rootDir, attachmentStore = null, fsPromises = fsp } = {}) {
    if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) {
      throw new Error('工作区授权存储目录无效');
    }
    this.rootDir = rootDir;
    this.attachmentStore = attachmentStore;
    this.fs = fsPromises;
    this.records = new Map();
    this.initialized = false;
    this.persistPromise = Promise.resolve();
  }

  async initialize() {
    await this.fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await this.fs.chmod?.(this.rootDir, 0o700).catch(() => {});
    await this.#restoreManifest();
    this.initialized = true;
    await this.#persistManifest();
  }

  list({ accountId, agentId }) {
    this.#requireInitialized();
    const scope = authorityScope(accountId, agentId);
    return [...this.records.values()]
      .filter((record) => record.scope === scope)
      .sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN'))
      .map(publicWorkspace);
  }

  /**
   * Trusted Main-only entrypoint. rootPath must come from a native directory
   * picker or an equivalent privileged flow; it must never be bridged from a
   * Renderer text field.
   */
  async authorizeRoot({ accountId, agentId, rootPath }) {
    this.#requireInitialized();
    const scope = authorityScope(accountId, agentId);
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || CONTROL_CHAR_PATTERN.test(rootPath)) {
      throw new Error('请选择有效的工作区目录');
    }
    const canonicalRoot = await this.fs.realpath(rootPath).catch(() => {
      throw new Error('所选工作区目录不存在或无法访问');
    });
    const stat = await this.fs.lstat(canonicalRoot, { bigint: true }).catch(() => {
      throw new Error('所选工作区目录不存在或无法访问');
    });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('请选择有效的工作区目录');

    const duplicate = [...this.records.values()].find(
      (record) => record.scope === scope && record.rootPath === canonicalRoot,
    );
    if (duplicate) {
      await this.#verifyRoot(duplicate);
      return publicWorkspace(duplicate);
    }
    if ([...this.records.values()].filter((record) => record.scope === scope).length >= MAX_AUTHORIZED_ROOTS_PER_SCOPE) {
      throw new Error('当前 Agent 授权的工作区数量已达上限');
    }
    const record = {
      workspaceId: `workspace-${crypto.randomUUID()}`,
      scope,
      rootPath: canonicalRoot,
      rootDevice: String(stat.dev),
      rootInode: String(stat.ino),
      displayName: safeDisplayName(path.basename(canonicalRoot)),
      generation: crypto.randomUUID(),
    };
    this.records.set(record.workspaceId, record);
    await this.#persistManifest();
    return publicWorkspace(record);
  }

  async revoke({ accountId, agentId, workspaceId }) {
    this.#requireInitialized();
    const record = this.#ownedRecord(accountId, agentId, workspaceId);
    this.records.delete(record.workspaceId);
    await this.#persistManifest();
    return this.list({ accountId, agentId });
  }

  async searchFiles({
    accountId,
    agentId,
    workspaceId,
    query = '',
    limit = DEFAULT_SEARCH_RESULTS,
  }) {
    this.#requireInitialized();
    const record = this.#ownedRecord(accountId, agentId, workspaceId);
    const generation = record.generation;
    const root = await this.#verifyRoot(record);
    const normalizedQuery = normalizeSearchQuery(query);
    const resultLimit = boundedLimit(limit, DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
    const queue = [{ directory: root, depth: 0 }];
    const visitedDirectories = new Set();
    const results = [];
    let scanned = 0;

    while (queue.length && scanned < MAX_SCAN_ENTRIES) {
      const current = queue.shift();
      let directoryStat;
      try {
        directoryStat = await this.fs.lstat(current.directory, { bigint: true });
      } catch {
        continue;
      }
      const directoryIdentity = `${directoryStat.dev}:${directoryStat.ino}`;
      if (!directoryStat.isDirectory() || visitedDirectories.has(directoryIdentity)) continue;
      visitedDirectories.add(directoryIdentity);

      let entries;
      try {
        entries = await this.fs.readdir(current.directory, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
      for (const entry of entries) {
        if (scanned >= MAX_SCAN_ENTRIES) break;
        scanned += 1;
        if (!isSafeFilesystemName(entry.name)) continue;
        const lexicalPath = path.join(current.directory, entry.name);
        let canonicalPath;
        let stat;
        try {
          canonicalPath = await this.fs.realpath(lexicalPath);
          if (!isCanonicalChild(root, canonicalPath)) continue;
          stat = await this.fs.lstat(canonicalPath, { bigint: true });
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          if (current.depth < MAX_DIRECTORY_DEPTH) {
            queue.push({ directory: canonicalPath, depth: current.depth + 1 });
          }
          continue;
        }
        if (!stat.isFile() || stat.size < 1n || stat.size > BigInt(MAX_ATTACHMENT_BYTES)) continue;
        const mimeType = allowedMimeType(canonicalPath);
        if (!mimeType) continue;
        const relativePath = canonicalRelativePath(root, canonicalPath);
        const searchable = normalizeSearchText(relativePath);
        if (normalizedQuery && !searchable.includes(normalizedQuery)) continue;
        results.push({
          workspaceId: record.workspaceId,
          relativePath,
          displayPath: relativePath,
          name: path.basename(relativePath),
          mimeType,
          sizeBytes: Number(stat.size),
        });
      }
    }

    this.#assertStillActive(record, generation);
    results.sort((left, right) => compareSearchResults(left, right, normalizedQuery));
    return results.slice(0, resultLimit).map((result) => ({ ...result }));
  }

  async stageAttachment({ accountId, agentId, workspaceId, relativePath }) {
    this.#requireInitialized();
    if (!this.attachmentStore || typeof this.attachmentStore.stageBytes !== 'function') {
      throw new Error('附件服务尚未就绪');
    }
    const record = this.#ownedRecord(accountId, agentId, workspaceId);
    const generation = record.generation;
    const root = await this.#verifyRoot(record);
    const candidate = await this.#resolveCandidate(root, relativePath);
    const bytes = await this.#readStableFile(root, candidate);
    this.#assertStillActive(record, generation);
    const existingAttachmentIds = typeof this.attachmentStore.list === 'function'
      ? new Set(this.attachmentStore.list({ accountId, agentId }).map((item) => item.attachmentId))
      : new Set();
    const [attachment] = await this.attachmentStore.stageBytes({
      accountId,
      agentId,
      items: [{
        name: path.basename(candidate.relativePath),
        mimeType: candidate.mimeType,
        bytes,
      }],
    });
    try {
      this.#assertStillActive(record, generation);
    } catch (error) {
      if (
        attachment?.attachmentId
        && !existingAttachmentIds.has(attachment.attachmentId)
        && typeof this.attachmentStore.discard === 'function'
      ) {
        await this.attachmentStore.discard({
          accountId,
          agentId,
          attachmentId: attachment.attachmentId,
        }).catch(() => {});
      }
      throw error;
    }
    return {
      attachment,
      reference: {
        workspaceId: record.workspaceId,
        relativePath: candidate.relativePath,
        displayPath: candidate.relativePath,
      },
    };
  }

  /** Main-only Host adapter. Never expose this return value through preload. */
  async getPrivateHostContext({ accountId, agentId, workspaceId }) {
    this.#requireInitialized();
    const record = this.#ownedRecord(accountId, agentId, workspaceId);
    return { cwd: await this.#verifyRoot(record) };
  }

  async clearAccount(accountId) {
    this.#requireInitialized();
    const accountPrefix = `${validateAccountId(accountId)}\u0000`;
    for (const [workspaceId, record] of this.records) {
      if (record.scope.startsWith(accountPrefix)) this.records.delete(workspaceId);
    }
    await this.#persistManifest();
  }

  async clearAll() {
    this.#requireInitialized();
    this.records.clear();
    await this.#persistManifest();
  }

  async dispose() {
    if (this.initialized) await this.#persistManifest().catch(() => {});
    this.records.clear();
    this.initialized = false;
  }

  async #resolveCandidate(root, value) {
    const relativePath = validateRelativePath(value);
    const lexicalPath = path.join(root, ...relativePath.split('/'));
    const canonicalPath = await this.fs.realpath(lexicalPath).catch(() => {
      throw new Error('所选文件不存在或无法访问');
    });
    if (!isCanonicalChild(root, canonicalPath)) throw new Error('所选文件超出已授权工作区');
    const stat = await this.fs.lstat(canonicalPath, { bigint: true }).catch(() => {
      throw new Error('所选文件不存在或无法访问');
    });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('请选择工作区中的具体文件');
    if (stat.size < 1n) throw new Error('不能添加空文件');
    if (stat.size > BigInt(MAX_ATTACHMENT_BYTES)) throw new Error('单个附件不能超过 20 MB');
    const mimeType = allowedMimeType(canonicalPath);
    if (!mimeType) throw new Error('暂不支持此文件类型');
    return {
      canonicalPath,
      relativePath: canonicalRelativePath(root, canonicalPath),
      mimeType,
      identity: fileIdentity(stat),
    };
  }

  async #readStableFile(root, candidate) {
    const handle = await this.fs.open(
      candidate.canonicalPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    ).catch(() => {
      throw new Error('所选文件无法安全读取');
    });
    try {
      const opened = await handle.stat({ bigint: true }).catch(() => {
        throw new Error('所选文件无法安全读取');
      });
      if (!opened.isFile() || !sameFileIdentity(candidate.identity, fileIdentity(opened))) {
        throw new Error('文件在读取前已发生变化，请重新选择');
      }
      const bytes = await handle.readFile().catch(() => {
        throw new Error('所选文件无法安全读取');
      });
      const afterRead = await handle.stat({ bigint: true }).catch(() => {
        throw new Error('所选文件无法安全读取');
      });
      if (
        !sameFileIdentity(fileIdentity(opened), fileIdentity(afterRead))
        || afterRead.size !== BigInt(bytes.byteLength)
      ) {
        throw new Error('文件在读取过程中已发生变化，请重新选择');
      }
      const currentPath = await this.fs.realpath(path.join(root, ...candidate.relativePath.split('/'))).catch(() => null);
      if (currentPath !== candidate.canonicalPath || !isCanonicalChild(root, currentPath)) {
        throw new Error('文件路径在读取过程中已发生变化，请重新选择');
      }
      const current = await this.fs.lstat(currentPath, { bigint: true }).catch(() => {
        throw new Error('文件路径在读取过程中已发生变化，请重新选择');
      });
      if (!sameFileIdentity(fileIdentity(afterRead), fileIdentity(current))) {
        throw new Error('文件在读取过程中已被替换，请重新选择');
      }
      return bytes;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  #ownedRecord(accountId, agentId, workspaceId) {
    const scope = authorityScope(accountId, agentId);
    if (typeof workspaceId !== 'string' || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
      throw new Error('工作区授权无效');
    }
    const record = this.records.get(workspaceId);
    if (!record || record.scope !== scope) throw new Error('工作区未授权或已撤销');
    return record;
  }

  async #verifyRoot(record) {
    const canonical = await this.fs.realpath(record.rootPath).catch(() => null);
    if (canonical !== record.rootPath) throw new Error('工作区授权已失效，请重新授权');
    const stat = await this.fs.lstat(canonical, { bigint: true }).catch(() => null);
    if (
      !stat
      || !stat.isDirectory()
      || stat.isSymbolicLink()
      || String(stat.dev) !== record.rootDevice
      || String(stat.ino) !== record.rootInode
    ) {
      throw new Error('工作区授权已失效，请重新授权');
    }
    return canonical;
  }

  #assertStillActive(record, generation) {
    const current = this.records.get(record.workspaceId);
    if (current !== record || current.generation !== generation) {
      throw new Error('工作区未授权或已撤销');
    }
  }

  async #restoreManifest() {
    const manifestPath = path.join(this.rootDir, MANIFEST_FILENAME);
    let parsed;
    try {
      parsed = JSON.parse(await this.fs.readFile(manifestPath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw new Error('工作区授权清单无效');
    }
    if (
      parsed?.schemaVersion !== MANIFEST_SCHEMA_VERSION
      || !Array.isArray(parsed.records)
      || parsed.records.length > 1_000
    ) {
      throw new Error('工作区授权清单无效');
    }
    const restored = new Map();
    for (const value of parsed.records) {
      const record = restoreRecord(value);
      if (restored.has(record.workspaceId)) throw new Error('工作区授权清单重复');
      try {
        await this.#verifyRoot(record);
      } catch {
        continue;
      }
      restored.set(record.workspaceId, record);
    }
    const counts = new Map();
    for (const record of restored.values()) {
      counts.set(record.scope, (counts.get(record.scope) || 0) + 1);
    }
    if ([...counts.values()].some((count) => count > MAX_AUTHORIZED_ROOTS_PER_SCOPE)) {
      throw new Error('工作区授权清单超出范围');
    }
    this.records = restored;
  }

  async #persistManifest() {
    if (!this.initialized && this.records.size === 0) return;
    const payload = `${JSON.stringify({
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      records: [...this.records.values()].map(manifestRecord),
    })}\n`;
    const manifestPath = path.join(this.rootDir, MANIFEST_FILENAME);
    const tempPath = path.join(this.rootDir, `.workspace-${process.pid}-${crypto.randomUUID()}.tmp`);
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

  #requireInitialized() {
    if (!this.initialized) throw new Error('工作区授权服务尚未就绪');
  }
}

function authorityScope(accountId, agentId) {
  return `${validateAccountId(accountId)}\u0000${validateAgentId(agentId)}`;
}

function validateAccountId(value) {
  const accountId = String(value ?? '');
  if (!accountId || accountId.length > 200 || CONTROL_CHAR_PATTERN.test(accountId)) {
    throw new Error('工作区账号范围无效');
  }
  return accountId;
}

function validateAgentId(value) {
  const agentId = String(value ?? '');
  if (!/^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$/.test(agentId)) {
    throw new Error('工作区 Agent 范围无效');
  }
  return agentId;
}

function validateRelativePath(value) {
  if (typeof value !== 'string') throw new Error('文件路径无效');
  if (
    !value
    || value.length > MAX_RELATIVE_PATH_CHARS
    || CONTROL_CHAR_PATTERN.test(value)
    || path.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || value.includes('\\')
  ) {
    throw new Error('只能选择工作区内的相对路径');
  }
  // Preserve the filesystem's exact Unicode representation. Search uses NFKC,
  // but changing an NFD filename to NFC here would break lookup on Linux.
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || !isSafeFilesystemName(segment))) {
    throw new Error('文件路径不能包含跳出工作区的片段');
  }
  return segments.join('/');
}

function isSafeFilesystemName(value) {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= 255
    && value !== '.'
    && value !== '..'
    && !CONTROL_CHAR_PATTERN.test(value)
    && !value.includes('/')
  );
}

function isCanonicalChild(root, candidate) {
  if (typeof candidate !== 'string') return false;
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function canonicalRelativePath(root, candidate) {
  if (!isCanonicalChild(root, candidate)) throw new Error('所选文件超出已授权工作区');
  const relative = path.relative(root, candidate).split(path.sep).join('/');
  return validateRelativePath(relative);
}

function allowedMimeType(filename) {
  return EXTENSION_MIME_TYPES.get(path.extname(filename).toLowerCase()) || null;
}

function normalizeSearchQuery(value) {
  if (typeof value !== 'string' || value.length > MAX_QUERY_CHARS || CONTROL_CHAR_PATTERN.test(value)) {
    throw new Error('文件搜索内容无效');
  }
  return normalizeSearchText(value.trim());
}

function normalizeSearchText(value) {
  return String(value).normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function boundedLimit(value, fallback, maximum) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('返回数量无效');
  return value;
}

function compareSearchResults(left, right, query) {
  if (query) {
    const leftName = normalizeSearchText(left.name);
    const rightName = normalizeSearchText(right.name);
    const leftScore = leftName === query ? 0 : leftName.startsWith(query) ? 1 : leftName.includes(query) ? 2 : 3;
    const rightScore = rightName === query ? 0 : rightName.startsWith(query) ? 1 : rightName.includes(query) ? 2 : 3;
    if (leftScore !== rightScore) return leftScore - rightScore;
  }
  return left.relativePath.localeCompare(right.relativePath, 'zh-CN');
}

function fileIdentity(stat) {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    size: String(stat.size),
    mtime: String(stat.mtimeNs ?? stat.mtimeMs),
    ctime: String(stat.ctimeNs ?? stat.ctimeMs),
  };
}

function sameFileIdentity(left, right) {
  return (
    left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mtime === right.mtime
    && left.ctime === right.ctime
  );
}

function safeDisplayName(value) {
  const displayName = String(value || '工作区').normalize('NFC').trim();
  if (!displayName || displayName.length > 120 || CONTROL_CHAR_PATTERN.test(displayName)) return '工作区';
  return displayName;
}

function publicWorkspace(record) {
  return {
    workspaceId: record.workspaceId,
    displayName: record.displayName,
  };
}

function manifestRecord(record) {
  return {
    workspaceId: record.workspaceId,
    scope: record.scope,
    rootPath: record.rootPath,
    rootDevice: record.rootDevice,
    rootInode: record.rootInode,
    displayName: record.displayName,
    generation: record.generation,
  };
}

function restoreRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('工作区授权记录无效');
  }
  if (!WORKSPACE_ID_PATTERN.test(value.workspaceId || '')) throw new Error('工作区授权标识无效');
  const separator = typeof value.scope === 'string' ? value.scope.indexOf('\u0000') : -1;
  if (separator < 1 || separator !== value.scope.lastIndexOf('\u0000')) {
    throw new Error('工作区授权范围无效');
  }
  const scope = authorityScope(value.scope.slice(0, separator), value.scope.slice(separator + 1));
  if (scope !== value.scope) throw new Error('工作区授权范围无效');
  if (typeof value.rootPath !== 'string' || !path.isAbsolute(value.rootPath) || CONTROL_CHAR_PATTERN.test(value.rootPath)) {
    throw new Error('工作区授权路径无效');
  }
  if (!/^\d+$/.test(value.rootDevice || '') || !/^\d+$/.test(value.rootInode || '')) {
    throw new Error('工作区授权目录身份无效');
  }
  if (typeof value.generation !== 'string' || !/^[0-9a-f-]{36}$/.test(value.generation)) {
    throw new Error('工作区授权版本无效');
  }
  return {
    workspaceId: value.workspaceId,
    scope,
    rootPath: value.rootPath,
    rootDevice: value.rootDevice,
    rootInode: value.rootInode,
    displayName: safeDisplayName(value.displayName),
    generation: value.generation,
  };
}

module.exports = {
  DEFAULT_SEARCH_RESULTS,
  MAX_SEARCH_RESULTS,
  WORKSPACE_ID_PATTERN,
  WorkspaceAuthorityStore,
  authorityScope,
  validateRelativePath,
};
