/**
 * Integrations: the pieces around QuChen that used to need a hand-edited file.
 *
 *   - the DeepSeek Harness profile: one button writes the provider that points at QuChen's API
 *     (through the fixed 127.0.0.1:18080 proxy when it answers, so the engine's changing port does
 *     not matter), and the credential-ref the harness resolves the key from;
 *   - the free-model gateway (LiteLLM, 127.0.0.1:4000): start, stop, and register it as a second
 *     provider in the same profile;
 *   - pausing the model: no new request is accepted until it is resumed (the engine stays loaded).
 *
 * Every write is behind a passcode: the three phrases below are the only accepted answers.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createConnection } from 'node:net';

export const PASSCODES = ['王朝玉', '姜俊涛', 'quchen'];

export function passcodeOk(given) {
  return typeof given === 'string' && PASSCODES.includes(given.trim());
}

const dshProfile = () => join(homedir(), '.dsh', 'profiles', 'desktop');
const harnessConfig = () => join(dshProfile(), 'cordis.patch.yml');
const credentialsFile = () => join(homedir(), '.dsh', '.credentials.yaml');
const instancesDir = () => join(homedir(), '.quchen', 'data', 'native-instances');
const settingsFile = () => join(homedir(), '.quchen', 'data', 'integrations.json');
const PROXY_PORT = 18080;
const GATEWAY_PORT = 4000;

function readSettings() {
  try { return JSON.parse(readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  mkdirSync(join(homedir(), '.quchen', 'data'), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(next, null, 1) + '\n', 'utf8');
  return next;
}

/** The engine QuChen started last: its port, its key and the model id it serves. */
export function runningInstance() {
  try {
    const files = readdirSync(instancesDir()).filter(f => f.endsWith('.json'))
      .map(f => join(instancesDir(), f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const f of files) {
      try {
        const j = JSON.parse(readFileSync(f, 'utf8'));
        const port = Number(j.port);
        if (Number.isInteger(port) && port > 0) return { port, key: j.api_key || null, model: j.model_name || null };
      } catch { /* the next one */ }
    }
  } catch { /* no engine yet */ }
  return null;
}

function portOpen(port, timeout = 600) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (value) => { try { socket.destroy(); } catch { } resolve(value); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(timeout, () => done(false));
  });
}

/** The address the harness should use: the fixed proxy when it answers, else the engine's own port. */
async function ensureProxy() {
  if (await portOpen(PROXY_PORT)) return true;
  await new Promise((resolve) => execFile('schtasks.exe', ['/Run', '/TN', 'QuChen API proxy'], { windowsHide: true }, () => resolve(null)));
  for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 400)); if (await portOpen(PROXY_PORT)) return true; }
  return false;
}

export async function apiBase(running = runningInstance()) {
  if (await ensureProxy()) return { baseUrl: `http://127.0.0.1:${PROXY_PORT}/v1`, via: 'proxy' };
  if (running) return { baseUrl: `http://127.0.0.1:${running.port}/v1`, via: 'engine' };
  return { baseUrl: null, via: 'none' };
}

const HARNESS_BLOCK = (baseUrl, model, label, gateway) => {
  const models = [
    `          - id: ${model}`,
    `            name: ${label}`,
    '            contextWindow: 131072',
    '            maxTokens: 8192',
  ];
  if (gateway) models.push('      gateway:', '        displayName: 免费网关 (LiteLLM)', '        api: openai-completions',
    `        baseURL: http://127.0.0.1:${GATEWAY_PORT}/v1`, '        apiKeyEnv: QUCHEN_GATEWAY_KEY',
    '        models:', '          - id: deepseek-v4.1-flash', '            name: DeepSeek-V4.1-Flash (免费网关)',
    '            contextWindow: 131072', '            maxTokens: 8192');
  return [
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      quchen:',
    '        displayName: QuChen (本地大模型)',
    '        api: openai-completions',
    `        baseURL: ${baseUrl}`,
    '        apiKeyEnv: QUCHEN_API_KEY',
    '        models:',
    ...models,
  ].join('\n') + '\n';
};

/** Replace the llm-pi-ai entry in the harness patch, keeping every other entry as it is. */
export function writeHarnessProfile(text, block) {
  const start = text.indexOf('- id: llm-pi-ai');
  if (start < 0) return text.replace(/\n*$/, '\n') + block;
  const after = text.indexOf('\n- id: ', start + 1);
  const head = text.slice(0, start);
  const tail = after < 0 ? '' : text.slice(after + 1);
  return head + block + (tail ? tail : '');
}

function ensureCredentialRef(name, value) {
  const file = credentialsFile();
  let text = existsSync(file) ? readFileSync(file, 'utf8') : 'version: 1\n';
  if (new RegExp(`^\\s+${name}:`, 'm').test(text)) return text;
  if (/^refs:\s*$/m.test(text)) {
    text = text.replace(/^refs:\s*$/m, `refs:\n  ${name}: ${value}`);
  } else {
    text = text.replace(/^version:\s*\d+\s*$/m, (m) => `${m}\nrefs:\n  ${name}: ${value}`);
  }
  writeFileSync(file, text, 'utf8');
  return text;
}

export async function harnessStatus() {
  const running = runningInstance();
  const base = await apiBase(running);
  let current = null;
  try {
    const text = readFileSync(harnessConfig(), 'utf8');
    const m = /baseURL:\s*(\S+)/.exec(text);
    current = m ? m[1] : null;
  } catch { /* no profile yet */ }
  return {
    profile: harnessConfig(), exists: existsSync(harnessConfig()), current,
    model: running?.model ?? null, port: running?.port ?? null,
    baseUrl: base.baseUrl, via: base.via,
  };
}

export async function syncHarness({ withGateway = false } = {}) {
  const running = runningInstance();
  if (!running) throw new Error('QuChen is not serving a model right now. Load one first.');
  const base = await apiBase(running);
  if (!base.baseUrl) throw new Error('QuChen has no API address yet. Load a model first.');
  const gateway = withGateway !== false && await portOpen(GATEWAY_PORT);
  const label = (running.model || 'local model').replace(/^qwen3\.8-flash-next-/, 'Qwen3.8-Flash-Next ') + ' (本地, QuChen)';
  mkdirSync(dshProfile(), { recursive: true });
  const before = existsSync(harnessConfig()) ? readFileSync(harnessConfig(), 'utf8') : '';
  const block = HARNESS_BLOCK(base.baseUrl, running.model, label, gateway);
  const after = writeHarnessProfile(before, block);
  writeFileSync(harnessConfig(), after, 'utf8');
  ensureCredentialRef('QUCHEN_API_KEY', 'local');
  if (gateway) ensureCredentialRef('QUCHEN_GATEWAY_KEY', readSettings().gatewayKey || 'Quchennb1');
  writeSettings({ lastSync: new Date().toISOString(), model: running.model, baseUrl: base.baseUrl });
  return { ok: true, profile: harnessConfig(), model: running.model, baseUrl: base.baseUrl, via: base.via, gateway };
}

/* --------------------------------------------------------------- gateway --- */

export function gatewayDir() {
  const configured = readSettings().gatewayDir;
  const candidates = [
    configured,
    process.env.QUCHEN_GATEWAY_DIR,
    'D:\\工作区\\unlimited-token',
    join(homedir(), '工作区', 'unlimited-token'),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(join(c, 'start-gateway.vbs'))) return c;
  return configured || candidates[0];
}

export async function gatewayStatus() {
  const dir = gatewayDir();
  const vbs = join(dir, 'start-gateway.vbs');
  return { dir, present: existsSync(vbs), running: await portOpen(GATEWAY_PORT, 900), port: GATEWAY_PORT };
}

export async function gatewayAction(action) {
  const dir = gatewayDir();
  const vbs = join(dir, 'start-gateway.vbs');
  if (action === 'start') {
    if (!existsSync(vbs)) throw new Error(`No start-gateway.vbs in ${dir}. Set the gateway folder first.`);
    spawn('wscript.exe', [vbs], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    await new Promise((r) => setTimeout(r, 1500));
    return gatewayStatus();
  }
  if (action === 'stop') {
    await new Promise((resolve) => execFile('powershell.exe',
      ['-NoProfile', '-Command', "Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"],
      { windowsHide: true }, () => resolve(null)));
    await new Promise((r) => setTimeout(r, 800));
    return gatewayStatus();
  }
  return gatewayStatus();
}

/** Where the LiteLLM gateway checkout lives (the folder that has start-gateway.vbs). */
export function setGatewayDir(dir) {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('Give the gateway folder.');
  writeSettings({ gatewayDir: dir.trim() });
  return dir.trim();
}
