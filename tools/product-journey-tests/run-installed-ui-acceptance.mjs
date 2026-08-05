#!/usr/bin/env node

import process from 'node:process';
import { pathToFileURL } from 'node:url';

const FAKE_PROVIDER_KEY = 'am360-local-ui-acceptance-never-submit';
const FAKE_PROVIDER_NAME = '本机验收草稿';
const FAKE_CONVERSATION_DRAFT = '本机验收草稿，不发送';

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function parsePort(argv) {
  if (
    argv.length !== 2
    || argv[0] !== '--port'
    || !/^[0-9]+$/u.test(argv[1] || '')
  ) {
    throw new Error(
      'usage: node run-installed-ui-acceptance.mjs --port <loopback-port>',
    );
  }
  const port = Number(argv[1]);
  assertCondition(
    Number.isInteger(port) && port > 0 && port <= 65535,
    'debug port is invalid',
  );
  return port;
}

function assertLoopbackUrl(value, protocol) {
  const parsed = new URL(value);
  assertCondition(
    parsed.protocol === protocol
      && parsed.hostname === '127.0.0.1',
    'installed UI acceptance only permits IPv4 loopback endpoints',
  );
}

async function fetchInstalledPage(port) {
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  assertLoopbackUrl(endpoint, 'http:');
  const response = await fetch(endpoint, {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  assertCondition(response.ok, 'installed app debug endpoint is unavailable');
  const pages = await response.json();
  assertCondition(Array.isArray(pages), 'installed app debug response is invalid');
  const matching = pages.filter(
    (page) =>
      page?.type === 'page'
      && typeof page.webSocketDebuggerUrl === 'string'
      && page.url
        === 'file:///Applications/AgentMesh360.app/Contents/Resources/app.asar/src/ui/index.html',
  );
  assertCondition(
    matching.length === 1,
    'expected exactly one installed AgentMesh360 renderer',
  );
  return matching[0];
}

async function evaluatePage(webSocketUrl, expression) {
  assertLoopbackUrl(webSocketUrl, 'ws:');
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      socket.close();
      reject(new Error('installed UI evaluation timed out'));
    }, 360_000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression,
          awaitPromise: true,
          returnByValue: true,
        },
      }));
    });
    socket.addEventListener('message', (event) => {
      if (settled) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id !== 1) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (message.result?.exceptionDetails) {
        const detail = String(
          message.result.exceptionDetails.exception?.description
            || message.result.exceptionDetails.text
            || 'installed UI evaluation failed',
        ).split('\n')[0].slice(0, 240);
        reject(new Error(`installed UI evaluation failed: ${detail}`));
        return;
      }
      resolve(message.result?.result?.value);
    });
    socket.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error('installed UI debug WebSocket failed'));
    });
  });
}

function acceptanceExpression() {
  return `(
    async () => {
      const waitFor = async (predicate, message, timeoutMs = 10000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(message);
      };
      const waitForValue = async (load, predicate, message, timeoutMs = 20000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const value = await load();
          if (predicate(value)) return value;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(message);
      };
      const identity = await waitForValue(
        () => window.agentmesh360.getState(),
        (value) => (
          value?.phase === 'ready'
          && Boolean(value.account?.id)
          && value.subscription?.status === 'active'
        ),
        'installed client did not recover the admitted account',
        60000,
      );
      if (
        identity?.phase !== 'ready'
        || !identity.account?.id
        || identity.subscription?.status !== 'active'
      ) {
        throw new Error('installed client did not recover the admitted account');
      }
      const background = await waitForValue(
        () => window.agentmesh360.getBackgroundSnapshot(),
        (value) => (
          value?.host?.mode === 'persistent_leader'
          && value.host.bridgeState === 'connected'
        ),
        'installed persistent Host did not reconnect',
        60000,
      );
      if (
        background?.host?.mode !== 'persistent_leader'
        || background.host.bridgeState !== 'connected'
      ) {
        throw new Error('installed persistent Host did not reconnect');
      }
      const publicAgents = Array.isArray(identity.agents) ? identity.agents : [];
      const residentRuntimeStates = new Set([
        'resident',
        'working',
        'needs_input',
        'dormant',
        'starting',
      ]);
      const establishedRuntimeStates = new Set([
        'resident',
        'working',
        'needs_input',
        'dormant',
      ]);
      const isResidentAgent = (agent) => (
        agent.desiredState === 'running'
        && residentRuntimeStates.has(agent.runtimeState)
      );
      const residentAgentCount = publicAgents.filter(isResidentAgent).length;
      if (residentAgentCount < 1) {
        throw new Error('installed client did not recover a resident Agent');
      }

      const onboardingOverview = await window.agentmesh360.getAgentModelOverview();
      if (
        !Number.isSafeInteger(onboardingOverview?.configuredProviderCount)
        || onboardingOverview.configuredProviderCount < 0
        || Object.hasOwn(onboardingOverview, 'profiles')
      ) {
        throw new Error('installed onboarding overview is not a safe configured-state projection');
      }
      const overviewByAgent = new Map(
        (onboardingOverview.agents || []).map((agent) => [agent.agentId, agent]),
      );
      const establishedResidentAgents = publicAgents.filter((agent) => (
        agent.desiredState === 'running'
        && establishedRuntimeStates.has(agent.runtimeState)
      ));
      const validResidentAgents = establishedResidentAgents.filter((agent) => {
        const model = overviewByAgent.get(agent.agentId);
        return Boolean(model && !model.bindingIssue);
      });
      const invalidResidentAgents = establishedResidentAgents.filter((agent) => (
        !validResidentAgents.some((validAgent) => validAgent.agentId === agent.agentId)
      ));
      const runtimeStartingAgents = publicAgents.filter((agent) => (
        agent.desiredState === 'running' && agent.runtimeState === 'starting'
      ));
      const activatingAgent = publicAgents.find(
        (agent) => agent.agentId === identity.activatingAgentId,
      );
      const startingAgents = activatingAgent
        && !runtimeStartingAgents.some((agent) => agent.agentId === activatingAgent.agentId)
        ? [...runtimeStartingAgents, activatingAgent]
        : runtimeStartingAgents;
      const activatableAgents = publicAgents.filter((agent) => (
        !isResidentAgent(agent) && agent.agentId !== identity.activatingAgentId
      ));
      const providerComplete = onboardingOverview.configuredProviderCount > 0;
      const agentComplete = establishedResidentAgents.length > 0;
      const hasReadyResident = providerComplete && validResidentAgents.length > 0;
      const namedAction = (id, label, agent = null) => ({
        id,
        label,
        agentId: agent?.agentId || null,
      });
      let expectedGuide;
      if (!providerComplete) {
        expectedGuide = {
          statuses: ['current', agentComplete ? 'complete' : 'locked', 'locked'],
          action: namedAction('onboarding-go-providers', '配置模型供应商'),
        };
      } else if (startingAgents.length > 0 && !agentComplete) {
        expectedGuide = {
          statuses: ['complete', 'current', 'locked'],
          action: namedAction(
            'onboarding-focus-agent',
            '查看 ' + startingAgents[0].displayName + ' 状态',
            startingAgents[0],
          ),
        };
      } else if (!agentComplete) {
        expectedGuide = {
          statuses: ['complete', 'current', 'locked'],
          action: activatableAgents.length > 0
            ? namedAction('onboarding-go-agents', '查看可激活 Agent')
            : namedAction('onboarding-refresh-agents', '重新确认 Agent'),
        };
      } else if (validResidentAgents.length === 0) {
        expectedGuide = {
          statuses: ['complete', 'complete', 'current'],
          action: namedAction(
            'onboarding-fix-agent',
            '设置 ' + invalidResidentAgents[0].displayName + ' 模型',
            invalidResidentAgents[0],
          ),
        };
      } else {
        expectedGuide = {
          statuses: ['complete', 'complete', 'current'],
          action: namedAction(
            'onboarding-open-agent',
            '打开或继续 ' + validResidentAgents[0].displayName,
            validResidentAgents[0],
          ),
        };
      }
      const guideMatches = (strip) => {
        if (!strip) return false;
        const steps = [...strip.querySelectorAll('.onboarding-steps > .onboarding-step')];
        const statuses = steps.map((step) => (
          ['complete', 'current', 'locked', 'unknown']
            .find((status) => step.classList.contains(status)) || null
        ));
        const buttons = [...strip.querySelectorAll('button')];
        const action = buttons[0];
        return strip.getAttribute('aria-label') === 'Agent 使用顺序'
          && strip.getAttribute('aria-live') === 'polite'
          && steps.length === 3
          && JSON.stringify(steps.map((step) => step.querySelector('strong')?.textContent.trim()))
            === JSON.stringify([
              '添加模型供应商',
              '激活 Agent',
              '在 Agent 对话中开始工作',
            ])
          && JSON.stringify(statuses) === JSON.stringify(expectedGuide.statuses)
          && strip.querySelectorAll('[aria-current="step"]').length === 1
          && buttons.length === 1
          && action.id === expectedGuide.action.id
          && action.textContent.trim() === expectedGuide.action.label
          && (action.dataset.agentId || null) === expectedGuide.action.agentId;
      };
      await waitFor(
        () => hasReadyResident
          ? !document.querySelector('.onboarding-strip')
          : document.querySelector('.onboarding-strip[data-onboarding-phase="ready"]'),
        'installed Agent home onboarding did not settle to the authoritative state',
      );
      const agentHomeOrderedGuide = hasReadyResident
        ? !document.querySelector('.onboarding-strip')
        : guideMatches(document.querySelector('.onboarding-strip'));
      if (!hasReadyResident) {
        const onboardingStrip = document.querySelector('.onboarding-strip');
        if (!agentHomeOrderedGuide || !guideMatches(onboardingStrip)) {
          throw new Error('installed Agent home does not expose the actionable three-step guide');
        }
      }
      document.getElementById('open-account-settings').click();
      document.querySelector('[data-settings-tab="account"]')?.click();
      await waitFor(
        () => document.getElementById('settings-logout'),
        'installed Account settings did not open from the remembered setting',
      );
      const accountSettingsStructure =
        document.querySelector('.account-center-header h1')?.textContent?.trim()
          === '账户与设置'
        && JSON.stringify(
          [...document.querySelectorAll('[data-settings-tab]')]
            .map((button) => button.querySelector('strong')?.textContent?.trim()),
        ) === JSON.stringify([
          '账号与订阅',
          '模型供应商',
          '后台运行',
          '使用指南',
          '高级诊断',
        ])
        && document.querySelectorAll('[data-settings-tab].active').length === 1
        && document.querySelectorAll('[data-settings-tab][aria-current="page"]').length === 1
        && document.getElementById('settings-logout');
      if (!accountSettingsStructure) {
        throw new Error('installed account settings center does not match the product structure');
      }
      document.querySelector('[data-settings-tab="guide"]')?.click();
      await waitFor(
        () => document.querySelector('.onboarding-strip.settings-guide[data-onboarding-phase="ready"]'),
        'installed Settings guide did not load authoritative onboarding state',
      );
      if (!guideMatches(document.querySelector('.onboarding-strip.settings-guide'))) {
        throw new Error('installed Settings guide does not match the authoritative next action');
      }
      document.getElementById('nav-agents').click();
      const agentAddEntryHidden = !document.getElementById('add-agent')
        && !document.body.textContent.includes('＋ 添加 Agent');
      if (!agentAddEntryHidden) {
        throw new Error('installed Agent home still exposes an unavailable add-Agent entry');
      }

      const providerProbeBaseline = JSON.stringify(
        (await window.agentmesh360.getProviderSnapshot())?.probes || [],
      );

      document.getElementById('open-account-settings').click();
      document.querySelector('[data-settings-tab="providers"]')?.click();
      await waitFor(
        () => document.querySelector('.provider-list-shell'),
        'Provider list did not load',
      );
      if (
        document.getElementById('provider-profile-form')
        || document.querySelector('[role="dialog"]')
      ) {
        throw new Error('installed Provider page did not open in list-first mode');
      }
      document.querySelector('[data-open-provider-editor]')?.click();
      await waitFor(
        () => document.querySelector('.provider-editor-dialog[role="dialog"]')
          && document.getElementById('provider-profile-form'),
        'Provider configuration dialog did not open',
      );
      const presetIds = [
        ...document.querySelectorAll(
          '#provider-preset optgroup[label^="官方"] option',
        ),
      ].map((option) => option.value);
      const expectedPresets = [
        'openai',
        'xai',
        'anthropic',
        'google-gemini',
        'deepseek',
        'glm',
        'glm-coding-plan',
        'kimi',
        'kimi-cn',
        'kimi-coding-plan',
      ];
      if (JSON.stringify(presetIds) !== JSON.stringify(expectedPresets)) {
        throw new Error('installed Provider catalog does not match the product contract');
      }
      const providerSelects = [
        ...document.querySelectorAll('#provider-profile-form select'),
      ];
      const appOwnedProviderSelects = providerSelects.length === 4
        && providerSelects.every((select) => (
          select.classList.contains('app-select-native')
          && select.tabIndex === -1
          && select.getAttribute('aria-hidden') === 'true'
        ))
        && document.querySelectorAll(
          '#provider-profile-form button.app-select-trigger[role="combobox"]',
        ).length === 4;
      if (!appOwnedProviderSelects) {
        throw new Error('installed Provider form still exposes native select interaction');
      }

      let form = document.getElementById('provider-profile-form');
      form.elements.presetId.value = 'glm-coding-plan';
      form.elements.presetId.dispatchEvent(new Event('change', { bubbles: true }));
      form.elements.displayName.value = ${JSON.stringify(FAKE_PROVIDER_NAME)};
      form.elements.apiKey.value = ${JSON.stringify(FAKE_PROVIDER_KEY)};
      document.getElementById('nav-agents').click();
      document.getElementById('open-account-settings').click();
      document.querySelector('[data-settings-tab="providers"]')?.click();
      await waitFor(
        () => document.querySelector('.provider-editor-dialog[role="dialog"]')
          && document.getElementById('provider-profile-form'),
        'Provider configuration dialog did not return after navigation',
      );
      form = document.getElementById('provider-profile-form');
      const providerDraftPreserved =
        form.elements.presetId.value === 'glm-coding-plan'
        && form.elements.displayName.value === ${JSON.stringify(FAKE_PROVIDER_NAME)}
        && form.elements.apiKey.value === ${JSON.stringify(FAKE_PROVIDER_KEY)}
        && !document.documentElement.innerHTML.includes(
          ${JSON.stringify(FAKE_PROVIDER_KEY)},
        );
      if (!providerDraftPreserved) {
        throw new Error('Provider draft was not preserved safely across navigation');
      }
      form.elements.presetId.value = '';
      form.elements.displayName.value = '';
      form.elements.apiKey.value = '';
      document.querySelector('[data-discard-provider-draft]')?.click();
      document.getElementById('nav-agents').click();

      const jobButton = document.querySelector(
        '[data-manage-agent="job-agent"]',
      );
      if (!jobButton) throw new Error('resident Job Agent is unavailable');
      jobButton.click();
      await waitFor(
        () => {
          const form = document.getElementById('conversation-form');
          return form
            && form.elements.message
            && !form.elements.message.disabled
            && !form.querySelector('button[type="submit"]')?.disabled
            && !document.querySelector('.conversation-error')
            && document.querySelector('.conversation-state')?.textContent?.trim() === '已连接';
        },
        'Job Agent conversation did not reach a usable connected state',
        60000,
      );
      const firstConversationSnapshot =
        await window.agentmesh360.getConversationSnapshot();
      if (
        firstConversationSnapshot?.phase !== 'ready'
        || firstConversationSnapshot?.agentId !== 'job-agent'
        || firstConversationSnapshot?.error
      ) {
        throw new Error('Host conversation snapshot is not the ready Job Agent');
      }

      const workspaceShell = document.querySelector(
        '.workspace.agent-workspace-layout',
      );
      const workspaceColumns = [...(workspaceShell?.children || [])];
      const threeColumnAgentWorkspace =
        workspaceColumns.length === 3
        && workspaceColumns[0]?.matches('aside.sidebar')
        && workspaceColumns[1]?.matches('aside.agent-workspace-rail')
        && workspaceColumns[2]?.matches('main.workspace-main.agent-workspace-main');
      if (!threeColumnAgentWorkspace) {
        throw new Error('installed Agent workspace is not the required three-column layout');
      }

      const globalNavigationReady =
        document.querySelector('#nav-agents.nav-item.active')
        && document.querySelectorAll('.nav-item').length === 1
        && !document.getElementById('nav-providers')
        && !document.getElementById('nav-settings')
        && document.getElementById('open-account-settings');
      if (!globalNavigationReady) {
        throw new Error('installed global navigation does not match the product structure');
      }

      const residentAgentSelection = document.querySelectorAll(
        '.resident-agent-list [data-switch-resident-agent][aria-current="true"]',
      );
      if (
        residentAgentSelection.length !== 1
        || residentAgentSelection[0].dataset.switchResidentAgent !== 'job-agent'
      ) {
        throw new Error('installed Agent rail does not identify the active Job Agent');
      }

      const sessionButtons = [
        ...document.querySelectorAll('.agent-session-list [data-agent-session]'),
      ];
      const singlePersistentMainSession =
        sessionButtons.length === 1
        && sessionButtons[0].dataset.agentSession === 'main'
        && sessionButtons[0].getAttribute('aria-current') === 'page'
        && sessionButtons[0].textContent?.includes('主会话')
        && document.querySelectorAll('#conversation-form').length === 1
        && document.getElementById('conversation-form')?.dataset.sessionKey === 'main'
        && document.querySelector('.agent-chat-identity p')?.textContent?.trim() === '主会话';
      if (!singlePersistentMainSession) {
        throw new Error('installed Agent does not expose exactly one persistent main session');
      }

      const settingsButton = document.querySelector(
        '#agent-settings-button.agent-settings-button',
      );
      const agentSettingsGearPresent =
        settingsButton instanceof HTMLButtonElement
        && !settingsButton.disabled
        && settingsButton.getAttribute('aria-label')?.includes('设置')
        && settingsButton.querySelector('svg');
      if (!agentSettingsGearPresent) {
        throw new Error('installed Agent conversation lacks the settings gear');
      }

      const legacyAgentTabsAbsent =
        !document.querySelector('.agent-tabs')
        && !document.querySelector('[data-agent-tab]')
        && !document.querySelector('.agent-conversation-workspace .agent-settings-nav');
      if (!legacyAgentTabsAbsent) {
        throw new Error('installed Agent conversation still exposes peer-level configuration tabs');
      }

      const transcript = document.querySelector('.conversation-transcript');
      const composerDock = document.querySelector('.conversation-composer-dock');
      const composerForm = document.getElementById('conversation-form');
      const composerTextarea = composerForm?.elements.message;
      const messageBody = document.querySelector('.conversation-message-body');
      const transcriptRect = transcript?.getBoundingClientRect();
      const composerDockRect = composerDock?.getBoundingClientRect();
      const composerFormRect = composerForm?.getBoundingClientRect();
      const composerTextareaRect = composerTextarea?.getBoundingClientRect();
      const messageFontReady = !messageBody || (
        parseFloat(getComputedStyle(messageBody).fontSize) >= 14
        && parseFloat(getComputedStyle(messageBody).fontSize) < 15
      );
      const compactConversationLayoutReady = Boolean(
        transcriptRect
        && composerDockRect
        && composerFormRect
        && composerTextareaRect
        && transcriptRect.bottom <= composerDockRect.top + 1
        && composerDockRect.bottom <= window.innerHeight + 1
        && composerFormRect.bottom <= window.innerHeight + 1
        && composerTextareaRect.bottom <= window.innerHeight + 1
        && messageFontReady
        && parseFloat(getComputedStyle(composerTextarea).fontSize) >= 15
      );
      if (!compactConversationLayoutReady) {
        throw new Error('installed Agent composer is not fully visible in the current viewport');
      }

      const conversationMessagesBefore = JSON.stringify(
        firstConversationSnapshot.messages || [],
      );
      const conversationDomMessagesBefore = document.querySelectorAll(
        '.conversation-message',
      ).length;
      let message = document.querySelector(
        '#conversation-form [name="message"]',
      );
      message.value = ${JSON.stringify(FAKE_CONVERSATION_DRAFT)};
      settingsButton.click();
      await waitFor(
        () => (
          document.querySelector('.agent-settings-workspace')
          && document.getElementById('back-to-agent-conversation')
          && document.querySelectorAll(
            '.agent-settings-nav [data-agent-setting]',
          ).length === 3
          && !document.getElementById('conversation-form')
        ),
        'Agent settings did not open from the conversation gear',
      );
      const agentModelSelects = [
        ...document.querySelectorAll('#agent-model-form select'),
      ];
      const appOwnedAgentModelSelects = agentModelSelects.length === 2
        && agentModelSelects.every((select) => (
          select.classList.contains('app-select-native')
          && select.tabIndex === -1
          && select.getAttribute('aria-hidden') === 'true'
        ))
        && document.querySelectorAll(
          '#agent-model-form button.app-select-trigger[role="combobox"]',
        ).length === 2;
      if (!appOwnedAgentModelSelects) {
        throw new Error('installed Agent model form still exposes native select interaction');
      }
      if (
        document.querySelector('.agent-tabs')
        || document.querySelector('[data-agent-tab]')
      ) {
        throw new Error('installed Agent settings still use legacy peer-level tabs');
      }
      document.getElementById('back-to-agent-conversation').click();
      await waitFor(
        () => {
          const form = document.getElementById('conversation-form');
          return form
            && form.elements.message
            && !form.elements.message.disabled
            && !form.querySelector('button[type="submit"]')?.disabled
            && !document.querySelector('.conversation-error')
            && document.querySelector('.conversation-state')?.textContent?.trim() === '已连接';
        },
        'usable conversation form did not return after navigation',
        60000,
      );
      const reopenedConversationSnapshot =
        await window.agentmesh360.getConversationSnapshot();
      if (
        reopenedConversationSnapshot?.phase !== 'ready'
        || reopenedConversationSnapshot?.agentId !== 'job-agent'
        || reopenedConversationSnapshot?.error
      ) {
        throw new Error('reopened Host snapshot is not the ready Job Agent');
      }
      if (
        JSON.stringify(reopenedConversationSnapshot.messages || [])
          !== conversationMessagesBefore
        || document.querySelectorAll('.conversation-message').length
          !== conversationDomMessagesBefore
      ) {
        throw new Error('installed acceptance unexpectedly sent a conversation message');
      }
      message = document.querySelector(
        '#conversation-form [name="message"]',
      );
      const conversationDraftPreserved =
        message.value === ${JSON.stringify(FAKE_CONVERSATION_DRAFT)}
        && !document.documentElement.innerHTML.includes(
          ${JSON.stringify(FAKE_CONVERSATION_DRAFT)},
        );
      if (!conversationDraftPreserved) {
        throw new Error('conversation draft was not preserved through Agent settings');
      }
      message.value = '';
      document.getElementById('nav-agents').click();

      const providerProbeFinal = JSON.stringify(
        (await window.agentmesh360.getProviderSnapshot())?.probes || [],
      );
      if (providerProbeFinal !== providerProbeBaseline) {
        throw new Error('installed acceptance unexpectedly triggered a Provider request');
      }

      return {
        status: 'passed',
        admittedAccountRecovered: true,
        subscriptionValid: true,
        persistentHostConnected: true,
        residentAgentCount,
        agentHomeOrderedGuide,
        accountSettingsStructure: true,
        agentAddEntryHidden,
        officialProviderCount: presetIds.length,
        appOwnedProviderSelects,
        appOwnedAgentModelSelects,
        providerDraftPreserved,
        conversationDraftPreserved,
        conversationDraftPreservedViaSettings: true,
        conversationHostReady: true,
        threeColumnAgentWorkspace: true,
        singlePersistentMainSession: true,
        agentSettingsGearPresent: true,
        legacyAgentTabsAbsent: true,
        compactConversationLayoutReady,
        conversationMessagesSent: 0,
        providerRequests: 0,
        agentMeshCreditsUsed: 0,
        fakeDraftsCleared: true,
      };
    }
  )()`;
}

export async function runInstalledUiAcceptance(port) {
  assertCondition(
    typeof fetch === 'function' && typeof WebSocket === 'function',
    'installed UI acceptance requires Node with fetch and WebSocket support',
  );
  const page = await fetchInstalledPage(port);
  const result = await evaluatePage(
    page.webSocketDebuggerUrl,
    acceptanceExpression(),
  );
  assertCondition(result?.status === 'passed', 'installed UI acceptance failed');
  return Object.freeze(result);
}

async function main() {
  const port = parsePort(process.argv.slice(2));
  const result = await runInstalledUiAcceptance(port);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'installed UI acceptance failed'}\n`,
    );
    process.exitCode = 1;
  });
}
