'use strict';

const PROVIDER_PROTOCOLS = new Set([
  'openai_responses',
  'openai_chat',
  'anthropic_messages',
]);
const PROVIDER_AUTH_KINDS = new Set(['bearer_api_key', 'x_api_key']);
const ASSIGNMENT_SCOPES = new Set(['global', 'agent', 'session']);
const PROVIDER_PROBE_LEVELS = new Set([
  'local_validation',
  'metadata',
  'minimal_inference',
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,199}$/;
const SECRET_KEYS = new Set([
  'accesstoken',
  'access_token',
  'authorization',
  'apikey',
  'api_key',
  'credentialref',
  'credential_ref',
  'extraheaders',
  'extra_headers',
  'headerinjector',
  'header_injector',
  'password',
  'refreshtoken',
  'refresh_token',
  'token',
]);

class ProviderController {
  constructor({ identity, host }) {
    this.identity = identity;
    this.host = host;
  }

  async getSnapshot() {
    this.#requireReady();
    const [profiles, catalog, assignments, probes] = await Promise.all([
      this.host.listProviderProfiles(),
      this.host.getProviderCatalog(),
      this.host.listModelAssignments(),
      this.host.listProviderProbes(),
    ]);
    return publicProviderPayload({
      profiles: profiles?.profiles || [],
      catalog: catalog?.catalog || null,
      assignments: assignments?.assignments || [],
      probes: probes?.probes || [],
    });
  }

  async createProfile(profile, apiKey) {
    this.#requireReady();
    return publicProviderPayload(
      await this.host.createProviderProfile(
        normalizeProviderProfile(profile),
        normalizeSecret(apiKey),
      ),
    );
  }

  async updateProfile(profileId, profile) {
    this.#requireReady();
    return publicProviderPayload(
      await this.host.updateProviderProfile(
        normalizeIdentifier(profileId, 'Provider Profile ID'),
        normalizeProviderProfile(profile),
      ),
    );
  }

  async replaceSecret(profileId, apiKey) {
    this.#requireReady();
    return publicProviderPayload(
      await this.host.replaceProviderSecret(
        normalizeIdentifier(profileId, 'Provider Profile ID'),
        normalizeSecret(apiKey),
      ),
    );
  }

  async deleteProfile(profileId) {
    this.#requireReady();
    return publicProviderPayload(
      await this.host.deleteProviderProfile(
        normalizeIdentifier(profileId, 'Provider Profile ID'),
      ),
    );
  }

  async upsertAssignment(assignment) {
    this.#requireReady();
    return publicProviderPayload(
      await this.host.upsertModelAssignment(normalizeModelAssignment(assignment)),
    );
  }

  async deleteAssignment(assignmentId) {
    this.#requireReady();
    return publicProviderPayload(
      await this.host.deleteModelAssignment(
        normalizeIdentifier(assignmentId, 'Model Assignment ID'),
      ),
    );
  }

  async runProbe({ profileId, modelId, level, confirmPaidInference = false } = {}) {
    this.#requireReady();
    const normalizedLevel = String(level || '');
    if (!PROVIDER_PROBE_LEVELS.has(normalizedLevel)) {
      throw new Error('Provider Probe 级别无效');
    }
    const confirmed = confirmPaidInference === true;
    if (normalizedLevel !== 'minimal_inference' && confirmed) {
      throw new Error('只有最小推理 Probe 可以包含付费确认');
    }
    return publicProviderPayload(
      await this.host.runProviderProbe({
        profileId: normalizeIdentifier(profileId, 'Provider Profile ID'),
        modelId: normalizeModelId(modelId),
        level: normalizedLevel,
        confirmPaidInference: confirmed,
      }),
    );
  }

  async testConnection({
    profile,
    apiKey,
    modelId,
    confirmPaidInference = false,
  } = {}) {
    this.#requireReady();
    if (confirmPaidInference !== true) {
      throw new Error('测试连接可能产生 Provider 费用，必须先明确确认');
    }
    return publicProviderPayload(
      await this.host.testProviderConnection({
        profile: normalizeProviderProfile(profile),
        apiKey: normalizeSecret(apiKey),
        modelId: normalizeModelId(modelId),
        confirmPaidInference: true,
      }),
    );
  }

  #requireReady() {
    if (this.identity.getState()?.phase !== 'ready') {
      throw new Error('当前账号尚未通过订阅验证，无法管理 Provider');
    }
  }
}

function normalizeProviderProfile(value) {
  if (!isPlainObject(value)) throw new Error('Provider 配置无效');
  rejectUnknownKeys(value, [
    'presetId',
    'displayName',
    'protocol',
    'baseUrl',
    'authKind',
    'enabledModels',
  ], 'Provider 配置');

  const displayName = normalizeText(value.displayName, 'Provider 名称', 80);
  const protocol = String(value.protocol || '');
  if (!PROVIDER_PROTOCOLS.has(protocol)) throw new Error('Provider 协议无效');
  const authKind = String(value.authKind || '');
  if (!PROVIDER_AUTH_KINDS.has(authKind)) throw new Error('Provider 认证方式无效');

  const parsed = new URL(String(value.baseUrl || '').trim());
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('Provider Base URL 无效或包含不允许的凭据/查询参数');
  }

  const enabledModels = Array.isArray(value.enabledModels) ? value.enabledModels : [];
  if (enabledModels.length > 64) throw new Error('单个 Provider 最多配置 64 个模型');
  const models = [...new Set(enabledModels.map((model) => {
    const normalized = String(model || '').trim();
    if (!MODEL_ID.test(normalized)) throw new Error('Provider 模型 ID 无效');
    return normalized;
  }))];

  const presetId = value.presetId == null || String(value.presetId).trim() === ''
    ? null
    : normalizeText(value.presetId, 'Provider 预设 ID', 128);
  return {
    presetId,
    displayName,
    protocol,
    baseUrl: parsed.toString().replace(/\/$/, ''),
    authKind,
    enabledModels: models,
  };
}

function normalizeModelAssignment(value) {
  if (!isPlainObject(value)) throw new Error('模型 Assignment 无效');
  rejectUnknownKeys(value, [
    'scopeKind',
    'scopeId',
    'role',
    'providerProfileId',
    'modelId',
  ], '模型 Assignment');
  const scopeKind = String(value.scopeKind || '');
  if (!ASSIGNMENT_SCOPES.has(scopeKind)) throw new Error('模型 Assignment scope 无效');
  const rawScopeId = value.scopeId == null ? '' : String(value.scopeId).trim();
  if (scopeKind === 'global' && rawScopeId) {
    throw new Error('global Assignment 不能包含 scopeId');
  }
  if (scopeKind !== 'global' && !rawScopeId) {
    throw new Error('agent/session Assignment 必须包含 scopeId');
  }
  if (rawScopeId && (rawScopeId.length > 200 || /[\u0000-\u001f\u007f]/.test(rawScopeId))) {
    throw new Error('模型 Assignment scopeId 无效');
  }
  return {
    scopeKind,
    scopeId: rawScopeId || null,
    role: normalizeIdentifier(value.role, '模型 role'),
    providerProfileId: normalizeIdentifier(value.providerProfileId, 'Provider Profile ID'),
    modelId: normalizeModelId(value.modelId),
  };
}

function normalizeIdentifier(value, label) {
  const normalized = String(value || '').trim();
  if (!IDENTIFIER.test(normalized)) throw new Error(`${label} 无效`);
  return normalized;
}

function normalizeModelId(value) {
  const normalized = String(value || '').trim();
  if (!MODEL_ID.test(normalized)) throw new Error('Provider 模型 ID 无效');
  return normalized;
}

function normalizeSecret(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 16_384) throw new Error('Provider API Key 无效');
  return normalized;
}

function normalizeText(value, label, maxLength) {
  const normalized = String(value || '').trim();
  if (!normalized || [...normalized].length > maxLength) throw new Error(`${label} 无效`);
  return normalized;
}

function publicProviderPayload(value) {
  const clone = JSON.parse(JSON.stringify(value ?? null));
  const visit = (current) => {
    if (!current || typeof current !== 'object') return;
    for (const key of Object.keys(current)) {
      if (SECRET_KEYS.has(key.toLowerCase())) {
        delete current[key];
      } else {
        visit(current[key]);
      }
    }
  };
  visit(clone);
  return deepFreeze(clone);
}

function rejectUnknownKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new Error(`${label}包含不支持的字段`);
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

module.exports = {
  ProviderController,
  normalizeModelAssignment,
  normalizeProviderProfile,
  publicProviderPayload,
};
