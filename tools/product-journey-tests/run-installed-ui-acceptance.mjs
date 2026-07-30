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
    }, 30_000);
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
      const waitFor = async (predicate, message) => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(message);
      };
      const waitForValue = async (load, predicate, message) => {
        const deadline = Date.now() + 20000;
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

      document.getElementById('nav-providers').click();
      await waitFor(
        () => document.getElementById('provider-profile-form'),
        'Provider form did not load',
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
        () => document.getElementById('provider-profile-form'),
        'Provider form did not return after navigation',
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
      document.getElementById('nav-agents').click();

      const jobButton = document.querySelector(
        '[data-open-conversation="job-agent"]',
      );
      if (!jobButton) throw new Error('resident Job Agent is unavailable');
      jobButton.click();
      await waitFor(
        () => document.querySelector(
          '#conversation-form [name="message"]',
        ),
        'Job Agent conversation did not open',
      );
      let message = document.querySelector(
        '#conversation-form [name="message"]',
      );
      message.value = ${JSON.stringify(FAKE_CONVERSATION_DRAFT)};
      document.getElementById('nav-agents').click();
      document.getElementById('nav-conversation').click();
      await waitFor(
        () => document.querySelector(
          '#conversation-form [name="message"]',
        ),
        'conversation form did not return after navigation',
      );
      message = document.querySelector(
        '#conversation-form [name="message"]',
      );
      const conversationDraftPreserved =
        message.value === ${JSON.stringify(FAKE_CONVERSATION_DRAFT)}
        && !document.documentElement.innerHTML.includes(
          ${JSON.stringify(FAKE_CONVERSATION_DRAFT)},
        );
      if (!conversationDraftPreserved) {
        throw new Error('conversation draft was not preserved safely');
      }
      message.value = '';
      document.getElementById('nav-agents').click();

      return {
        status: 'passed',
        admittedAccountRecovered: true,
        subscriptionValid: true,
        persistentHostConnected: true,
        residentAgentCount,
        officialProviderCount: presetIds.length,
        providerDraftPreserved,
        conversationDraftPreserved,
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
