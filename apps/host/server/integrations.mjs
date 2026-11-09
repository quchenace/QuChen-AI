/**
 * Integrations: the pieces around QuChen that used to need a hand-edited file.
 *
 *   - the DeepSeek Harness profile: one button writes the providers that point at QuChen's API
 *     (through the fixed 127.0.0.1:18080 proxy, so the engine's changing port never matters) and at
 *     the free-model gateway (127.0.0.1:4000). Every model the two expose is listed, not just one;
 *   - the free-model gateway itself: start, stop, and report what it serves;
 *   - pausing the model: no new request is accepted until it is resumed (the engine stays loaded).
 *
 * Every write is behind a passcode.
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

async function ensureProxy() {
  if (await portOpen(PROXY_PORT)) return true;
  await new Promise((resolve) => execFile('schtasks.exe', ['/Run', '/TN', 'QuChen API proxy'], { windowsHide: true }, () => resolve(null)));
  for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 400)); if (await portOpen(PROXY_PORT)) return true; }
  return false;
}

/** The address the harness should use: the fixed proxy when it answers, else the engine's own port. */
export async function apiBase(running = runningInstance()) {
  if (await ensureProxy()) return { baseUrl: 'http://127.0.0.1:' + PROXY_PORT + '/v1', via: 'proxy' };
  if (running) return { baseUrl: 'http://127.0.0.1:' + running.port + '/v1', via: 'engine' };
  return { baseUrl: null, via: 'none' };
}

/** The model ids an OpenAI-compatible server lists. */
async function listModels(baseUrl, key) {
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/models', {
      headers: key ? { authorization: 'Bearer ' + key } : {},
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return [];
    const doc = await res.json();
    const ids = (doc?.data ?? []).map((m) => m && m.id).filter((id) => typeof id === 'string' && id.length > 0);
    return [...new Set(ids)];
  } catch { return []; }
}

/* --------------------------------------------------------------- gateway --- */

export function gatewayDir() {
  const configured = readSettings().gatewayDir;
  const candidates = [
    configured,
    process.env.QUCHEN_GATEWAY_DIR,
    'D:/工作区/unlimited-token',
    join(homedir(), '工作区', 'unlimited-token'),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(join(c, 'start-gateway.vbs'))) return c;
  return configured || candidates[0];
}

function gatewayKey() {
  const configured = readSettings().gatewayKey;
  if (configured) return configured;
  try {
    const env = readFileSync(join(gatewayDir(), '.env'), 'utf8');
    const hit = /^\s*LITELLM_MASTER_KEY\s*=\s*(.+)$/m.exec(env);
    if (hit) return hit[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* no .env */ }
  return 'Quchennb1';
}

/** The model names the gateway is configured with, for when it is not running yet. */
function configuredGatewayModels() {
  try {
    const yaml = readFileSync(join(gatewayDir(), 'litellm-config.yaml'), 'utf8');
    const names = [...yaml.matchAll(/^\s*-\s*model_name:\s*[\"']?([^\s\"'#]+)/gm)].map((m) => m[1]);
    return [...new Set(names)];
  } catch { return []; }
}

export async function gatewayStatus() {
  const dir = gatewayDir();
  const running = await portOpen(GATEWAY_PORT, 900);
  const models = running ? await listModels('http://127.0.0.1:' + GATEWAY_PORT + '/v1', gatewayKey()) : [];
  return {
    dir, present: existsSync(join(dir, 'start-gateway.vbs')), port: GATEWAY_PORT, running,
    models: models.length ? models : configuredGatewayModels(),
  };
}

export async function gatewayAction(action) {
  const dir = gatewayDir();
  const vbs = join(dir, 'start-gateway.vbs');
  if (action === 'start') {
    if (!existsSync(vbs)) throw new Error('No start-gateway.vbs in ' + dir + '. Set the gateway folder first.');
    spawn('wscript.exe', [vbs], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    await new Promise((r) => setTimeout(r, 2500));
    return gatewayStatus();
  }
  if (action === 'stop') {
    await new Promise((resolve) => execFile('powershell.exe',
      ['-NoProfile', '-Command', 'Get-NetTCPConnection -LocalPort ' + GATEWAY_PORT + ' -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }'],
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

/* ---------------------------------------------------------------- writing --- */

const CONTEXT = 131072;
const MAX_TOKENS = 8192;
const MAX_MODELS = 40;

function modelLines(ids, indent, nameFor) {
  return ids.slice(0, MAX_MODELS).flatMap((id) => [
    indent + '- id: ' + id,
    indent + '  name: ' + nameFor(id),
    indent + '  contextWindow: ' + CONTEXT,
    indent + '  maxTokens: ' + MAX_TOKENS,
  ]);
}

function localName(id) {
  return id.replace(/^qwen(\d[\d.]*)-/, 'Qwen$1 ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim() + ' (QuChen 本地)';
}

const HARNESS_BLOCK = (baseUrl, localIds, gatewayIds) => {
  const lines = [
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      quchen:',
    '        displayName: QuChen (本地大模型)',
    '        api: openai-completions',
    '        baseURL: ' + baseUrl,
    '        apiKeyEnv: QUCHEN_API_KEY',
    '        models:',
    ...modelLines(localIds, '          ', localName),
  ];
  if (gatewayIds.length) {
    lines.push(
      '      gateway:',
      '        displayName: 免费网关 (LiteLLM)',
      '        api: openai-completions',
      '        baseURL: http://127.0.0.1:' + GATEWAY_PORT + '/v1',
      '        apiKeyEnv: QUCHEN_GATEWAY_KEY',
      '        models:',
      ...modelLines(gatewayIds, '          ', (id) => id + ' (免费网关)'),
    );
  }
  return lines.join('\n') + '\n';
};

/** Replace the llm-pi-ai entry in the harness patch, keeping every other entry as it is. */
export function writeHarnessProfile(text, block) {
  const start = text.indexOf('- id: llm-pi-ai');
  if (start < 0) return text.replace(/\n*$/, '\n') + block;
  const after = text.indexOf('\n- id: ', start + 1);
  const head = text.slice(0, start);
  const tail = after < 0 ? '' : text.slice(after + 1);
  return head + block + tail;
}

function ensureCredentialRef(name, value) {
  const file = credentialsFile();
  let text = existsSync(file) ? readFileSync(file, 'utf8') : 'version: 1\n';
  if (new RegExp('^\\s+' + name + ':', 'm').test(text)) return text;
  if (/^refs:\s*$/m.test(text)) text = text.replace(/^refs:\s*$/m, 'refs:\n  ' + name + ': ' + value);
  else text = text.replace(/^version:\s*\d+\s*$/m, (m) => m + '\nrefs:\n  ' + name + ': ' + value);
  writeFileSync(file, text, 'utf8');
  return text;
}

export async function harnessStatus() {
  const running = runningInstance();
  const base = await apiBase(running);
  const gateway = await gatewayStatus();
  let current = null;
  try {
    const text = readFileSync(harnessConfig(), 'utf8');
    const m = /baseURL:\s*(\S+)/.exec(text);
    current = m ? m[1] : null;
  } catch { /* no profile yet */ }
  const localModels = base.baseUrl ? await listModels(base.baseUrl, running?.key) : [];
  return {
    profile: harnessConfig(), exists: existsSync(harnessConfig()), current,
    model: running?.model ?? null, port: running?.port ?? null,
    baseUrl: base.baseUrl, via: base.via,
    localModels, gatewayModels: gateway.models,
  };
}

export async function syncHarness({ withGateway = true } = {}) {
  const running = runningInstance();
  if (!running) throw new Error('QuChen is not serving a model right now. Load one first.');
  const base = await apiBase(running);
  if (!base.baseUrl) throw new Error('QuChen has no API address yet. Load a model first.');
  const localModels = await listModels(base.baseUrl, running.key);
  if (!localModels.length && running.model) localModels.push(running.model);
  const gateway = await gatewayStatus();
  const gatewayModels = withGateway ? gateway.models : [];
  mkdirSync(dshProfile(), { recursive: true });
  const before = existsSync(harnessConfig()) ? readFileSync(harnessConfig(), 'utf8') : '';
  const after = writeHarnessProfile(before, HARNESS_BLOCK(base.baseUrl, localModels, gatewayModels));
  writeFileSync(harnessConfig(), after, 'utf8');
  ensureCredentialRef('QUCHEN_API_KEY', 'local');
  if (gatewayModels.length) ensureCredentialRef('QUCHEN_GATEWAY_KEY', gatewayKey());
  writeSettings({ lastSync: new Date().toISOString(), model: running.model, baseUrl: base.baseUrl });
  return {
    ok: true, profile: harnessConfig(), model: running.model, baseUrl: base.baseUrl, via: base.via,
    localModels, gatewayModels, gatewayRunning: gateway.running,
  };
}
