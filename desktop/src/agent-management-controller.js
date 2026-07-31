'use strict';

const AGENT_ID = /^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,199}$/;
const OVERLAY_KINDS = new Set(['agent_md', 'user_md']);
const PACKAGE_PERMISSIONS = new Set([
  'browser_control',
  'external_actions',
  'external_mutations',
  'local_files',
  'network_access',
  'process_execution',
]);

class AgentManagementController {
  constructor({ identity, host }) {
    this.identity = identity;
    this.host = host;
  }

  async getSnapshot(agentId) {
    this.#requireReady();
    const normalizedAgentId = normalizeAgentId(agentId);
    const [profiles, assignments, customization, packageCatalog] = await Promise.all([
      this.host.listProviderProfiles(),
      this.host.listModelAssignments(),
      this.host.getAgentCustomization(normalizedAgentId),
      this.host.getAgentPackageCatalog(),
    ]);
    const profileList = Array.isArray(profiles?.profiles) ? profiles.profiles : [];
    const assignmentList = Array.isArray(assignments?.assignments)
      ? assignments.assignments
      : [];
    const resolved = resolveModelBinding(normalizedAgentId, profileList, assignmentList);
    const packageRecord = (packageCatalog?.catalog?.packages || []).find(
      (item) => item?.agent?.agentId === normalizedAgentId,
    );
    const requestedPermissions = Array.isArray(packageRecord?.requestedPermissions)
      ? [...new Set(packageRecord.requestedPermissions)]
        .filter((permission) => PACKAGE_PERMISSIONS.has(permission))
      : [];
    return publicAgentManagementPayload({
      agentId: normalizedAgentId,
      profiles: profileList,
      modelBinding: resolved.modelBinding,
      bindingIssue: resolved.bindingIssue,
      inheritedFromLegacyGlobal: resolved.inheritedFromLegacyGlobal,
      customization: {
        ...customization,
        requestedPermissions,
      },
    });
  }

  async getOverview() {
    const state = this.#requireReady();
    const [profiles, assignments] = await Promise.all([
      this.host.listProviderProfiles(),
      this.host.listModelAssignments(),
    ]);
    const profileList = Array.isArray(profiles?.profiles) ? profiles.profiles : [];
    const assignmentList = Array.isArray(assignments?.assignments)
      ? assignments.assignments
      : [];
    const agents = Array.isArray(state.agents) ? state.agents : [];
    return publicAgentManagementPayload({
      agents: agents.map((agent) => {
        const agentId = normalizeAgentId(agent.agentId);
        const resolved = resolveModelBinding(agentId, profileList, assignmentList);
        return {
          agentId,
          providerProfileId: resolved.modelBinding?.providerProfileId || null,
          providerDisplayName: resolved.selectedProfile?.displayName || null,
          modelId: resolved.modelBinding?.modelId || null,
          bindingIssue: resolved.bindingIssue,
          inheritedFromLegacyGlobal: resolved.inheritedFromLegacyGlobal,
        };
      }),
    });
  }

  async saveModel(agentId, providerProfileId, modelId) {
    this.#requireReady();
    const normalizedAgentId = normalizeAgentId(agentId);
    const normalizedProviderProfileId = normalizeIdentifier(
      providerProfileId,
      'Provider Profile ID',
    );
    const normalizedModelId = normalizeModelId(modelId);
    const assignments = await this.host.listModelAssignments();
    const priorAssignment = (assignments?.assignments || []).find((item) => (
      item.scopeKind === 'agent'
      && item.scopeId === normalizedAgentId
      && item.role === 'main'
    )) || null;
    const written = await this.host.upsertModelAssignment({
      scopeKind: 'agent',
      scopeId: normalizedAgentId,
      role: 'main',
      providerProfileId: normalizedProviderProfileId,
      modelId: normalizedModelId,
    });
    try {
      await this.#switchResidentSession(normalizedAgentId);
    } catch (error) {
      try {
        if (priorAssignment) {
          await this.host.upsertModelAssignment({
            scopeKind: 'agent',
            scopeId: normalizedAgentId,
            role: 'main',
            providerProfileId: priorAssignment.providerProfileId,
            modelId: priorAssignment.modelId,
          });
        } else if (written?.assignment?.assignmentId) {
          await this.host.deleteModelAssignment(written.assignment.assignmentId);
        }
      } catch {
        throw new Error('模型切换未完成，设置状态需要重新加载后再试');
      }
      throw error;
    }
    return this.getSnapshot(normalizedAgentId);
  }

  async saveCustomization({
    agentId,
    kind,
    content,
    expectedRevision,
  }) {
    this.#requireReady();
    return publicAgentManagementPayload(await this.host.upsertAgentCustomization({
      agentId: normalizeAgentId(agentId),
      kind: normalizeOverlayKind(kind),
      content: normalizeOverlayContent(content),
      expectedRevision: normalizeRevision(expectedRevision),
    }));
  }

  async clearCustomization({ agentId, kind, expectedRevision }) {
    this.#requireReady();
    return publicAgentManagementPayload(await this.host.clearAgentCustomization({
      agentId: normalizeAgentId(agentId),
      kind: normalizeOverlayKind(kind),
      expectedRevision: normalizeRevision(expectedRevision),
    }));
  }

  #requireReady() {
    const state = this.identity.getState();
    if (state?.phase !== 'ready') {
      throw new Error('当前账号尚未通过订阅验证，无法管理 Agent');
    }
    return state;
  }

  async #switchResidentSession(agentId) {
    const agents = await this.host.listAgents();
    const agent = Array.isArray(agents?.agents)
      ? agents.agents.find((item) => item.agentId === agentId)
      : null;
    if (!agent?.mainSessionId) return;
    const history = await this.host.getSessionBindingHistory({
      sessionId: agent.mainSessionId,
      role: 'main',
      agentId,
    });
    if (!Array.isArray(history?.bindings) || history.bindings.length === 0) return;
    await this.host.switchSessionBinding({
      sessionId: agent.mainSessionId,
      role: 'main',
      agentId,
      kind: 'explicit_switch',
    });
  }
}

function resolveModelBinding(agentId, profiles, assignments) {
  const assignment = assignments.find((item) => (
    item.scopeKind === 'agent'
    && item.scopeId === agentId
    && item.role === 'main'
  )) || null;
  const modelBinding = assignment || assignments.find((item) => (
    item.scopeKind === 'global'
    && item.role === 'main'
  )) || null;
  const selectedProfile = modelBinding
    ? profiles.find((profile) => profile.profileId === modelBinding.providerProfileId)
    : null;
  const enabledModels = Array.isArray(selectedProfile?.enabledModels)
    ? selectedProfile.enabledModels
    : [];
  const bindingIssue = !modelBinding
    ? {
      code: 'model_not_configured',
      message: '这个 Agent 尚未选择模型。',
    }
    : !selectedProfile
      ? {
        code: 'provider_unavailable',
        message: '原模型供应商已被删除或不可用，请重新选择。',
      }
      : !enabledModels.includes(modelBinding.modelId)
        ? {
          code: 'model_unavailable',
          message: '原模型已不在该供应商的可用列表中，请重新选择。',
        }
        : null;
  return {
    modelBinding,
    selectedProfile,
    bindingIssue,
    inheritedFromLegacyGlobal: !assignment && Boolean(modelBinding),
  };
}

function normalizeAgentId(value) {
  const normalized = String(value || '').trim();
  if (!AGENT_ID.test(normalized)) throw new Error('Agent ID 无效');
  return normalized;
}

function normalizeIdentifier(value, label) {
  const normalized = String(value || '').trim();
  if (!IDENTIFIER.test(normalized)) throw new Error(`${label} 无效`);
  return normalized;
}

function normalizeModelId(value) {
  const normalized = String(value || '').trim();
  if (!MODEL_ID.test(normalized)) throw new Error('模型 ID 无效');
  return normalized;
}

function normalizeOverlayKind(value) {
  const normalized = String(value || '');
  if (!OVERLAY_KINDS.has(normalized)) throw new Error('Agent 自定义类型无效');
  return normalized;
}

function normalizeOverlayContent(value) {
  const normalized = String(value ?? '');
  if ([...normalized].length > 8_000) throw new Error('Agent 自定义内容不能超过 8000 字符');
  return normalized;
}

function normalizeRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Agent 自定义版本无效');
  return value;
}

function publicAgentManagementPayload(value) {
  const clone = JSON.parse(JSON.stringify(value ?? null));
  const secretKeys = new Set([
    'apikey',
    'api_key',
    'authorization',
    'credentialref',
    'credential_ref',
    'password',
    'token',
  ]);
  const visit = (current) => {
    if (!current || typeof current !== 'object') return;
    for (const key of Object.keys(current)) {
      if (secretKeys.has(key.toLowerCase())) delete current[key];
      else visit(current[key]);
    }
  };
  visit(clone);
  return deepFreeze(clone);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

module.exports = {
  AgentManagementController,
  normalizeAgentId,
  normalizeOverlayContent,
  publicAgentManagementPayload,
};
