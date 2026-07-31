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
      const residentAgentCount = Array.isArray(identity.agents)
        ? identity.agents.filter((agent) => (
          agent.desiredState === 'running'
          && [
            'resident',
            'working',
            'needs_input',
            'dormant',
            'starting',
          ].includes(agent.runtimeState)
        )).length
        : 0;
      if (residentAgentCount < 1) {
        throw new Error('installed client did not recover a resident Agent');
      }

      const providerProbeBaseline = JSON.stringify(
        (await window.agentmesh360.getProviderSnapshot())?.probes || [],
      );

      document.getElementById('nav-providers').click();
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

      let form = document.getElementById('provider-profile-form');
      form.elements.presetId.value = 'glm-coding-plan';
      form.elements.presetId.dispatchEvent(new Event('change', { bubbles: true }));
      form.elements.displayName.value = ${JSON.stringify(FAKE_PROVIDER_NAME)};
      form.elements.apiKey.value = ${JSON.stringify(FAKE_PROVIDER_KEY)};
      document.getElementById('nav-agents').click();
      document.getElementById('nav-providers').click();
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
        && document.getElementById('nav-providers')
        && document.getElementById('nav-settings');
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
        officialProviderCount: presetIds.length,
        providerDraftPreserved,
        conversationDraftPreserved,
        conversationDraftPreservedViaSettings: true,
        conversationHostReady: true,
        threeColumnAgentWorkspace: true,
        singlePersistentMainSession: true,
        agentSettingsGearPresent: true,
        legacyAgentTabsAbsent: true,
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
