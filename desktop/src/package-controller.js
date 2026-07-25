'use strict';

const PACKAGE_ID = /^[a-z0-9._-]{1,128}$/;
const APPROVAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_IDENTIFIER = /^[A-Za-z0-9._-]{1,128}$/;
const PUBLIC_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;
const ISSUE_CODE = /^[a-z][a-z0-9_]{0,79}$/;
const PACKAGE_PERMISSIONS = new Set([
  'browser_control',
  'external_actions',
  'external_mutations',
  'local_files',
  'network_access',
  'process_execution',
]);
const STATUS_KINDS = new Set([
  'built_in',
  'installed_active',
  'installed_previous',
  'invalid',
  'orphan',
]);
const STATUS_SLOTS = new Set(['active', 'previous']);
const REGISTRY_OUTCOMES = new Set([
  'disabled',
  'ready',
  'updated',
  'not_modified',
  'last_known_good',
  'unavailable',
]);
const DISCOVERY_OUTCOMES = new Set(['disabled', 'ready', 'unavailable']);
const REGISTRY_REASONS = new Set([
  'not_configured',
  'access_required',
  'no_verified_cache',
  'transport_failed',
  'http_status_rejected',
  'response_too_large',
  'invalid_response',
  'untrusted_response',
  'cache_rejected',
  'validator_persistence_failed',
]);
const RUNTIME_VISIBILITY = new Set(['visible', 'superseded', 'refresh_pending']);
const UNCERTAIN_HOST_ERRORS = new Set([
  'host_exited',
  'host_request_failed',
  'host_stopped',
  'host_timeout',
  'host_unavailable',
  'invalid_host_response',
]);
const PUBLIC_OPERATION_ERRORS = Object.freeze({
  approved_permissions_mismatch: '已安装 Agent Package 的权限与批准记录不一致。',
  installed_content_missing: 'Agent Package 的本地内容缺失。',
  installed_path_invalid: 'Agent Package 的本地存储元数据无效。',
  package_approval_unavailable: 'Agent Package 批准已失效或不属于当前账号。',
  package_delivery_failed: 'Agent Package 无法下载或通过签名验证。',
  package_identity_conflict: 'Agent Package 的身份或版本与运行时目录冲突。',
  package_integrity_failed: 'Agent Package 未通过完整性验证。',
  package_reconciliation_unavailable: 'Agent Package 的运行时状态暂时无法恢复。',
  package_registry_invalid: '本地 Agent Package Registry 无法安全读取。',
  package_rollback_unavailable: 'Agent Package 当前无法回滚。',
  package_validation_failed: 'Agent Package 未通过安全校验。',
});

class PackageControllerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PackageControllerError';
    this.code = code;
  }
}

class PackageController {
  constructor({ identity, host }) {
    this.identity = identity;
    this.host = host;
  }

  async getSnapshot() {
    const accountKey = this.#requireReady();
    try {
      const [catalog, status, discovery] = await Promise.all([
        this.host.getAgentPackageCatalog(),
        this.host.getAgentPackageStatus(),
        this.host.getRemoteAgentPackageCatalog(),
      ]);
      this.#requireSameAccount(accountKey);
      return publicPackageSnapshot({ catalog, status, discovery });
    } catch (error) {
      throw publicControllerError(error, 'package_snapshot_unavailable');
    }
  }

  async refreshRegistry() {
    const accountKey = this.#requireReady();
    try {
      const registry = normalizeRegistryStatus(
        await this.host.refreshAgentPackageRegistry(),
      );
      this.#requireSameAccount(accountKey);
      const snapshot = await this.getSnapshot();
      return deepFreeze({ registry, snapshot });
    } catch (error) {
      if (error instanceof PackageControllerError) throw error;
      throw publicControllerError(error, 'package_refresh_unavailable');
    }
  }

  async download(packageId) {
    const accountKey = this.#requireReady();
    const normalized = normalizePackageId(packageId);
    return this.#runMutation('download', accountKey, async () => {
      const value = await this.host.downloadAgentPackage(normalized);
      return normalizeDeliveryResult(value, normalized);
    });
  }

  async approve(approvalId) {
    const accountKey = this.#requireReady();
    const normalized = normalizeApprovalId(approvalId);
    return this.#runMutation('approve', accountKey, async () => {
      return normalizeMutationReceipt(
        await this.host.approveAgentPackage(normalized),
      );
    });
  }

  async rollback(packageId) {
    const accountKey = this.#requireReady();
    const normalized = normalizePackageId(packageId);
    return this.#runMutation('rollback', accountKey, async () => {
      return normalizeMutationReceipt(
        await this.host.rollbackAgentPackage(normalized),
      );
    });
  }

  async reconcile(packageId) {
    const accountKey = this.#requireReady();
    const normalized = normalizePackageId(packageId);
    return this.#runMutation('reconcile', accountKey, async () => {
      return normalizeMutationReceipt(
        await this.host.reconcileAgentPackage(normalized),
      );
    });
  }

  async #runMutation(operation, accountKey, action) {
    this.#requireSameAccount(accountKey);
    try {
      const value = await action();
      if (!this.#isSameAccount(accountKey)) {
        return unknownAccountOutcome(operation);
      }
      return deepFreeze({
        outcome: 'completed',
        operation,
        value,
      });
    } catch (error) {
      if (!this.#isSameAccount(accountKey)) {
        return unknownAccountOutcome(operation);
      }
      if (UNCERTAIN_HOST_ERRORS.has(String(error?.code || ''))) {
        return deepFreeze({
          outcome: 'unknown',
          operation,
          message: 'Agent Host 连接中断，操作结果未知。请先重新读取状态，不要自动重试。',
        });
      }
      throw publicControllerError(error, 'package_operation_failed');
    }
  }

  #requireReady() {
    const state = this.identity.getState();
    const accountId = state?.account?.id ?? state?.account?.accountId;
    const validAccountId = (Number.isSafeInteger(accountId) && accountId >= 0)
      || (typeof accountId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(accountId));
    if (state?.phase !== 'ready' || !validAccountId) {
      throw new PackageControllerError(
        'subscription_required',
        '当前账号尚未通过订阅验证，无法管理 Agent Package。',
      );
    }
    return String(accountId);
  }

  #isSameAccount(accountKey) {
    try {
      return this.#requireReady() === accountKey;
    } catch {
      return false;
    }
  }

  #requireSameAccount(accountKey) {
    if (!this.#isSameAccount(accountKey)) {
      throw new PackageControllerError(
        'package_account_changed',
        '账号状态在 Agent Package 操作期间发生变化，请重新读取状态。',
      );
    }
  }
}

function unknownAccountOutcome(operation) {
  return deepFreeze({
    outcome: 'unknown',
    operation,
    message: '账号状态在操作期间发生变化，结果不会显示或自动重试。请重新读取当前账号状态。',
  });
}

function publicPackageSnapshot({ catalog, status, discovery }) {
  const sourceCatalog = requireObject(catalog?.catalog, 'Agent Package Catalog');
  const sourceStatus = requireObject(status, 'Agent Package Status');
  const packages = boundedArray(
    sourceCatalog.packages,
    'Agent Package Catalog packages',
    512,
  )
    .map(normalizeCatalogPackage);
  const installed = boundedArray(
    sourceStatus.packages,
    'Agent Package Status packages',
    1024,
  )
    .map(normalizeInstalledStatus);
  const remoteDiscovery = normalizeRemoteDiscovery(discovery, packages);
  return deepFreeze({
    catalog: {
      schemaVersion: boundedInteger(sourceCatalog.schemaVersion, 1, Number.MAX_SAFE_INTEGER),
      catalogRevision: boundedInteger(
        sourceCatalog.catalogRevision,
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      packages,
    },
    status: {
      catalogGeneration: boundedInteger(
        sourceStatus.catalogGeneration,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      catalogRevision: optionalInteger(sourceStatus.catalogRevision),
      remoteRegistry: normalizeRegistryStatus(sourceStatus.remoteRegistry),
      lastRefreshIssue: optionalIssue(sourceStatus.lastRefreshIssue),
      packages: installed,
    },
    discovery: remoteDiscovery,
  });
}

function normalizeRemoteDiscovery(value, runtimePackages) {
  const source = requireObject(value, 'remote Agent Package Catalog');
  const outcome = String(source.outcome || '');
  if (!DISCOVERY_OUTCOMES.has(outcome)) {
    throw invalidResponse('remote Agent Package Catalog outcome');
  }
  const reason = source.reason == null ? null : String(source.reason);
  if (reason != null && !REGISTRY_REASONS.has(reason)) {
    throw invalidResponse('remote Agent Package Catalog reason');
  }
  const packages = boundedArray(
    source.packages,
    'remote Agent Package Catalog packages',
    256,
  ).map(normalizeRemotePackageSummary);
  if (outcome !== 'ready') {
    if (packages.length || source.registryRevision != null || source.registryExpiresAt != null) {
      throw invalidResponse('closed remote Agent Package Catalog');
    }
    return compactObject({ outcome, reason, packages: [] });
  }
  const registryRevision = boundedInteger(
    source.registryRevision,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const registryExpiresAt = normalizeTimestamp(source.registryExpiresAt);
  const runtimeByPackage = new Map(
    runtimePackages.map((packageRecord) => [packageRecord.packageId, packageRecord]),
  );
  return compactObject({
    outcome,
    reason,
    registryRevision,
    registryExpiresAt,
    packages: packages.map((packageRecord) => {
      const current = runtimeByPackage.get(packageRecord.packageId);
      if (!current) return { ...packageRecord, availability: 'new_agent' };
      const comparison = compareSemver(packageRecord.version, current.version);
      return compactObject({
        ...packageRecord,
        availability: comparison > 0
          ? 'update_available'
          : comparison === 0
            ? 'current'
            : 'local_newer',
        currentVersion: current.version,
      });
    }),
  });
}

function normalizeRemotePackageSummary(value) {
  const source = requireObject(value, 'remote Agent Package summary');
  return {
    packageId: normalizePackageId(source.packageId),
    agentId: normalizePublicIdentifier(source.agentId, 'Agent ID'),
    version: normalizeVersion(source.version),
    publisher: normalizePublicIdentifier(source.publisher, 'Agent Package publisher'),
  };
}

function normalizeCatalogPackage(value) {
  const source = requireObject(value, 'Agent Package');
  const agent = requireObject(source.agent, 'Agent Package agent');
  return {
    packageId: normalizePackageId(source.packageId),
    version: normalizeVersion(source.version),
    publisher: normalizePublicIdentifier(source.publisher, 'Agent Package publisher'),
    requestedPermissions: normalizePermissions(source.requestedPermissions),
    agent: {
      agentId: normalizePublicIdentifier(agent.agentId, 'Agent ID'),
      displayName: normalizeText(agent.displayName, 'Agent display name', 120),
      description: normalizeText(agent.description, 'Agent description', 600),
    },
  };
}

function normalizeInstalledStatus(value) {
  const source = requireObject(value, 'installed Agent Package status');
  const kind = String(source.kind || '');
  if (!STATUS_KINDS.has(kind)) throw invalidResponse('Agent Package status kind');
  const slot = source.slot == null ? null : String(source.slot);
  if (slot != null && !STATUS_SLOTS.has(slot)) {
    throw invalidResponse('Agent Package status slot');
  }
  return compactObject({
    kind,
    packageId: normalizePackageId(source.packageId),
    agentId: optionalPublicIdentifier(source.agentId, 'Agent ID'),
    version: optionalVersion(source.version),
    slot,
    issue: optionalIssue(source.issue),
  });
}

function normalizeRegistryStatus(value) {
  const source = requireObject(value, 'Agent Package remote Registry status');
  const outcome = String(source.outcome || '');
  if (!REGISTRY_OUTCOMES.has(outcome)) {
    throw invalidResponse('Agent Package Registry outcome');
  }
  const reason = source.reason == null ? null : String(source.reason);
  if (reason != null && !REGISTRY_REASONS.has(reason)) {
    throw invalidResponse('Agent Package Registry reason');
  }
  const cache = source.cache == null ? null : normalizeRegistryAudit(source.cache);
  return compactObject({
    outcome,
    reason,
    cache,
    checkedAt: optionalTimestamp(source.checkedAt),
    conditionalRequest: source.conditionalRequest === true,
  });
}

function normalizeRegistryAudit(value) {
  const source = requireObject(value, 'Agent Package Registry audit');
  return {
    trustSequence: boundedInteger(source.trustSequence, 1, Number.MAX_SAFE_INTEGER),
    trustExpiresAt: normalizeTimestamp(source.trustExpiresAt),
    registryRevision: boundedInteger(source.registryRevision, 1, Number.MAX_SAFE_INTEGER),
    registryExpiresAt: normalizeTimestamp(source.registryExpiresAt),
    packageCount: boundedInteger(source.packageCount, 0, 256),
    verifiedAt: normalizeTimestamp(source.verifiedAt),
  };
}

function normalizeDeliveryResult(value, requestedPackageId) {
  const source = requireObject(value, 'Agent Package delivery result');
  if (source.status === 'approval_required') {
    const approval = normalizeApprovalChallenge(source.approval);
    if (approval.packageId !== requestedPackageId) {
      throw invalidResponse('Agent Package approval identity');
    }
    return { status: 'approval_required', approval };
  }
  if (source.status === 'installed') {
    const receipt = normalizeMutationReceipt(source.receipt);
    if (receipt.packageId !== requestedPackageId) {
      throw invalidResponse('Agent Package install identity');
    }
    return { status: 'installed', receipt };
  }
  throw invalidResponse('Agent Package delivery status');
}

function normalizeApprovalChallenge(value) {
  const source = requireObject(value, 'Agent Package approval');
  return {
    approvalId: normalizeApprovalId(source.approvalId),
    packageId: normalizePackageId(source.packageId),
    version: normalizeVersion(source.version),
    addedPermissions: normalizePermissions(source.addedPermissions),
    expiresInSeconds: boundedInteger(source.expiresInSeconds, 1, 3600),
  };
}

function normalizeMutationReceipt(value) {
  const source = requireObject(value, 'Agent Package mutation receipt');
  return {
    packageId: normalizePackageId(source.packageId),
    agentId: normalizePublicIdentifier(source.agentId, 'Agent ID'),
    version: normalizeVersion(source.version),
    runtimeVisibility: normalizeRuntimeVisibility(source.runtimeVisibility),
  };
}

function normalizeRuntimeVisibility(value) {
  const source = requireObject(value, 'Agent Package runtime visibility');
  const status = String(source.status || '');
  if (!RUNTIME_VISIBILITY.has(status)) {
    throw invalidResponse('Agent Package runtime visibility');
  }
  return compactObject({
    status,
    catalogGeneration: boundedInteger(
      source.catalogGeneration,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    catalogRevision: optionalInteger(source.catalogRevision),
    activeVersion: optionalVersion(source.activeVersion),
    issue: optionalIssue(source.issue),
  });
}

function normalizePermissions(value) {
  const permissions = requireArray(value, 'Agent Package permissions');
  if (permissions.length > PACKAGE_PERMISSIONS.size) {
    throw invalidResponse('Agent Package permissions');
  }
  const normalized = permissions.map((permission) => String(permission || ''));
  if (normalized.some((permission) => !PACKAGE_PERMISSIONS.has(permission))) {
    throw invalidResponse('Agent Package permission');
  }
  return [...new Set(normalized)];
}

function optionalIssue(value) {
  if (value == null) return null;
  const source = requireObject(value, 'Agent Package issue');
  const code = String(source.code || '');
  if (!ISSUE_CODE.test(code)) throw invalidResponse('Agent Package issue code');
  return {
    code,
    summary: normalizeText(source.summary, 'Agent Package issue summary', 300),
  };
}

function normalizePackageId(value) {
  const normalized = String(value || '').trim();
  if (!PACKAGE_ID.test(normalized)) {
    throw new PackageControllerError('invalid_package_id', 'Agent Package ID 无效。');
  }
  return normalized;
}

function normalizeApprovalId(value) {
  const normalized = String(value || '').trim();
  if (!APPROVAL_ID.test(normalized)) {
    throw new PackageControllerError('invalid_approval_id', 'Agent Package 批准 ID 无效。');
  }
  return normalized.toLowerCase();
}

function normalizePublicIdentifier(value, label) {
  const normalized = String(value || '');
  if (!PUBLIC_IDENTIFIER.test(normalized)) throw invalidResponse(label);
  return normalized;
}

function optionalPublicIdentifier(value, label) {
  return value == null ? null : normalizePublicIdentifier(value, label);
}

function normalizeVersion(value) {
  const normalized = String(value || '');
  if (!PUBLIC_VERSION.test(normalized) || !parseSemver(normalized)) {
    throw invalidResponse('Agent Package version');
  }
  return normalized;
}

function optionalVersion(value) {
  return value == null ? null : normalizeVersion(value);
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw invalidResponse('Agent Package version');
  for (const field of ['major', 'minor', 'patch']) {
    const comparison = compareNumericIdentifier(a[field], b[field]);
    if (comparison !== 0) return comparison;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart == null) return -1;
    if (rightPart == null) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifier(leftPart, rightPart);
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function compareNumericIdentifier(left, right) {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function parseSemver(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    return null;
  }
  return {
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease,
  };
}

function normalizeText(value, label, maxLength) {
  const normalized = String(value || '').trim();
  if (!normalized || [...normalized].length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw invalidResponse(label);
  }
  return normalized;
}

function boundedInteger(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidResponse('Agent Package numeric field');
  }
  return value;
}

function optionalInteger(value) {
  return value == null ? null : boundedInteger(value, 0, Number.MAX_SAFE_INTEGER);
}

function normalizeTimestamp(value) {
  const normalized = String(value || '');
  const timestamp = Date.parse(normalized);
  if (!normalized || !Number.isFinite(timestamp) || normalized.length > 80) {
    throw invalidResponse('Agent Package timestamp');
  }
  return normalized;
}

function optionalTimestamp(value) {
  return value == null ? null : normalizeTimestamp(value);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidResponse(label);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw invalidResponse(label);
  return value;
}

function boundedArray(value, label, maximum) {
  const array = requireArray(value, label);
  if (array.length > maximum) throw invalidResponse(label);
  return array;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined),
  );
}

function invalidResponse(label) {
  return new PackageControllerError(
    'invalid_package_response',
    `${label} 响应无效。`,
  );
}

function publicControllerError(error, fallbackCode) {
  if (error instanceof PackageControllerError) return error;
  const code = String(error?.code || '');
  if (Object.hasOwn(PUBLIC_OPERATION_ERRORS, code)) {
    return new PackageControllerError(code, PUBLIC_OPERATION_ERRORS[code]);
  }
  return new PackageControllerError(
    fallbackCode,
    fallbackCode === 'package_snapshot_unavailable'
      ? '无法读取 Agent Package 状态。'
      : fallbackCode === 'package_refresh_unavailable'
        ? '无法刷新 Agent Package Registry。'
        : 'Agent Package 操作失败。',
  );
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

module.exports = {
  PackageController,
  PackageControllerError,
  compareSemver,
  normalizeApprovalId,
  normalizePackageId,
  publicPackageSnapshot,
};
