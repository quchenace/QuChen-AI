/**
 * Integrations: the free-model gateway and the DeepSeek Harness profile, owned by the app.
 *
 *   - the gateway runs as a child of this process (no console window, no .vbs, no PowerShell):
 *     start, stop, its log, and the models it serves are all read from here;
 *   - one click writes the harness profile: every model the local engine lists, and every model the
 *     gateway lists, both at fixed addresses (127.0.0.1:18080 and 127.0.0.1:4000);
 *   - "keep in sync" rewrites that profile whenever the running model changes, so the harness never
 *     points at a stale port or a model that is gone;
 *   - pausing the model stops new API requests without unloading it.
 *
 * Every write is behind a passcode.
 */
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createConnection } from 'node:net';

export const PASSCODES = ['王朝玉', '姜俊涛', 'quchen'];

export function passcodeOk(given) {
  return typeof given === 'string' && PASSCODES.includes(given.trim());
}

const DATA = join(homedir(), '.quchen', 'data');
const dshProfile = () => join(homedir(), '.dsh', 'profiles', 'desktop');
const harnessConfig = () => join(dshProfile(), 'cordis.patch.yml');
const credentialsFile = () => join(homedir(), '.dsh', '.credentials.yaml');
const instancesDir = () => join(DATA, 'native-instances');
const settingsFile = () => join(DATA, 'integrations.json');
const gatewayLog = () => join(DATA, 'gateway.log');
const PROXY_PORT = 18080;
const GATEWAY_PORT = 4000;
const CONTEXT = 131072;
const MAX_TOKENS = 8192;
const MAX_MODELS = 40;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The gateway we started, so closing QuChen closes it too. */
let gatewayChild = null;
export function stopGatewayWithHost() {
  try { if (gatewayChild && !gatewayChild.killed) gatewayChild.kill(); } catch { /* already gone */ }
}

function readSettings() {
  try { return JSON.parse(readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  mkdirSync(DATA, { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(next, null, 1) + '\n', 'utf8');
  return next;
}

/** The engine QuChen started last: its port, its key and the model it serves. */
export function runningInstance() {
  try {
    const files = readdirSync(instancesDir()).filter((f) => f.endsWith('.json'))
      .map((f) => join(instancesDir(), f))
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
  for (let i = 0; i < 10; i++) { await sleep(400); if (await portOpen(PROXY_PORT)) return true; }
  return false;
}

export async function apiBase(running = runningInstance()) {
  if (await ensureProxy()) return { baseUrl: 'http://127.0.0.1:' + PROXY_PORT + '/v1', via: 'proxy' };
  if (running) return { baseUrl: 'http://127.0.0.1:' + running.port + '/v1', via: 'engine' };
  return { baseUrl: null, via: 'none' };
}

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

export function gatewayHome() {
  return readSettings().gatewayDir || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'QuChen', 'gateway');
}

/** A folder QuChen can run: either its own copy or a checkout the person already had. */
export function gatewayDir() {
  const home = gatewayHome();
  const candidates = [home, process.env.QUCHEN_GATEWAY_DIR, 'D:/工作区/unlimited-token', join(homedir(), '工作区', 'unlimited-token')].filter(Boolean);
  for (const c of candidates) if (existsSync(join(c, '.venv', 'Scripts', 'litellm.exe'))) return c;
  return home;
}

function envFile(dir) {
  const out = {};
  try {
    for (const line of readFileSync(join(dir, '.env'), 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env */ }
  return out;
}

function gatewayKey() { return readSettings().gatewayKey || envFile(gatewayDir()).LITELLM_MASTER_KEY || 'Quchennb1'; }

function configuredGatewayModels() {
  try {
    const yaml = readFileSync(join(gatewayDir(), 'litellm-config.yaml'), 'utf8');
    const names = [...yaml.matchAll(/^\s*-\s*model_name:\s*["']?([^\s"'#]+)/gm)].map((m) => m[1]);
    return [...new Set(names)];
  } catch { return []; }
}

function logTail(lines = 12) {
  try {
    const text = readFileSync(gatewayLog(), 'utf8');
    const plain = text.replace(/\u001b\[[0-9;]*m/g, '');
    return plain.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch { return ''; }
}

export async function gatewayStatus() {
  const dir = gatewayDir();
  const running = await portOpen(GATEWAY_PORT, 700);
  const models = running ? await listModels('http://127.0.0.1:' + GATEWAY_PORT + '/v1', gatewayKey()) : [];
  return {
    dir, port: GATEWAY_PORT, running, home: gatewayHome(),
    present: existsSync(join(dir, '.venv', 'Scripts', 'litellm.exe')),
    models: models.length ? models : configuredGatewayModels(),
    pid: readSettings().gatewayPid ?? null,
    log: logTail(),
  };
}

/** The gateway QuChen ships as a release asset: one download, unpacked once, then reused. */
const GATEWAY_ZIP = 'https://github.com/quchenace/QuChen-AI/releases/latest/download/quchen-gateway.zip';

export async function gatewayInstall({ url } = {}) {
  const home = gatewayHome();
  mkdirSync(home, { recursive: true });
  const zip = join(home, 'gateway.zip');
  const source = url || readSettings().gatewayZip || GATEWAY_ZIP;
  const res = await fetch(source, { signal: AbortSignal.timeout(900000) });
  if (!res.ok) throw new Error('下载免费网关失败（HTTP ' + res.status + '）。');
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  await new Promise((resolve, reject) => execFile('powershell.exe',
    ['-NoProfile', '-Command', "Expand-Archive -LiteralPath '" + zip + "' -DestinationPath '" + home + "' -Force"],
    { windowsHide: true }, (e) => (e ? reject(new Error('解压失败：' + e.message)) : resolve(null))));
  try { rmSync(zip, { force: true }); } catch { /* left for the next try */ }
  writeSettings({ gatewayDir: home, gatewayInstalled: new Date().toISOString() });
  return gatewayStatus();
}

export async function gatewayStart() {
  if (await portOpen(GATEWAY_PORT)) return gatewayStatus();
  const dir = gatewayDir();
  const exe = join(dir, '.venv', 'Scripts', 'litellm.exe');
  if (!existsSync(exe)) throw new Error('这个文件夹里没有网关：' + dir);
  mkdirSync(DATA, { recursive: true });
  const fd = openSync(gatewayLog(), 'a');
  const env = { ...process.env, ...envFile(dir), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', LITELLM_LOCAL_MODEL_COST_MAP: 'True' };
  const child = spawn(exe, ['--config', join(dir, 'litellm-config.yaml'), '--port', String(GATEWAY_PORT), '--host', '127.0.0.1'],
    { cwd: dir, env, stdio: ['ignore', fd, fd], windowsHide: true });
  gatewayChild = child;
  writeSettings({ gatewayPid: child.pid });
  for (let i = 0; i < 30; i++) { await sleep(700); if (await portOpen(GATEWAY_PORT)) break; }
  return gatewayStatus();
}

export async function gatewayStop() {
  const pid = readSettings().gatewayPid;
  if (pid) await new Promise((resolve) => execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve(null)));
  await new Promise((resolve) => execFile('powershell.exe',
    ['-NoProfile', '-Command', 'Get-NetTCPConnection -LocalPort ' + GATEWAY_PORT + ' -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }'],
    { windowsHide: true }, () => resolve(null)));
  writeSettings({ gatewayPid: null });
  await sleep(600);
  return gatewayStatus();
}

export async function gatewayAction(action, dir) {
  if (dir) writeSettings({ gatewayDir: dir });
  if (action === 'install') return gatewayInstall({ url: dir });
  if (action === 'start') return gatewayStart();
  if (action === 'stop') return gatewayStop();
  return gatewayStatus();
}

/* ---------------------------------------------------------------- writing --- */

function localName(id) {
  return id.replace(/^qwen(\d[\d.]*)-/, 'Qwen$1 ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim() + ' (QuChen 本地)';
}

function modelLines(ids, indent, nameFor) {
  return ids.slice(0, MAX_MODELS).flatMap((id) => [
    indent + '- id: ' + id,
    indent + '  name: ' + nameFor(id),
    indent + '  contextWindow: ' + CONTEXT,
    indent + '  maxTokens: ' + MAX_TOKENS,
  ]);
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
  return text.slice(0, start) + block + (after < 0 ? '' : text.slice(after + 1));
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
    const m = /baseURL:\s*(\S+)/.exec(readFileSync(harnessConfig(), 'utf8'));
    current = m ? m[1] : null;
  } catch { /* no profile yet */ }
  const localModels = base.baseUrl ? await listModels(base.baseUrl, running?.key) : [];
  return {
    profile: harnessConfig(), exists: existsSync(harnessConfig()), current,
    model: running?.model ?? null, port: running?.port ?? null,
    baseUrl: base.baseUrl, via: base.via,
    localModels, gatewayModels: gateway.models,
    autoSync: !!readSettings().autoSync, lastSync: readSettings().lastSync ?? null,
  };
}

/** Write the profile from the live state. Used by the button and by the keep-in-sync watcher. */
async function writeProfile({ withGateway = true } = {}) {
  const running = runningInstance();
  if (!running) throw new Error('QuChen 现在没有在跑的模型，先在「模型」里加载一个。');
  const base = await apiBase(running);
  if (!base.baseUrl) throw new Error('QuChen 还没有可用的 API 地址。');
  const localModels = await listModels(base.baseUrl, running.key);
  if (!localModels.length && running.model) localModels.push(running.model);
  const gateway = await gatewayStatus();
  const gatewayModels = withGateway ? gateway.models : [];
  mkdirSync(dshProfile(), { recursive: true });
  const before = existsSync(harnessConfig()) ? readFileSync(harnessConfig(), 'utf8') : '';
  writeFileSync(harnessConfig(), writeHarnessProfile(before, HARNESS_BLOCK(base.baseUrl, localModels, gatewayModels)), 'utf8');
  ensureCredentialRef('QUCHEN_API_KEY', 'local');
  if (gatewayModels.length) ensureCredentialRef('QUCHEN_GATEWAY_KEY', gatewayKey());
  writeSettings({ lastSync: new Date().toISOString(), lastModel: running.model, lastBase: base.baseUrl });
  return { baseUrl: base.baseUrl, via: base.via, localModels, gatewayModels, running };
}

export async function syncHarness({ withGateway = true } = {}) {
  const done = await writeProfile({ withGateway });
  return { ok: true, profile: harnessConfig(), ...done, gatewayRunning: (await gatewayStatus()).running };
}

export function setAutoSync(on, withGateway = true) {
  writeSettings({ autoSync: !!on, autoGateway: !!withGateway });
  return { autoSync: !!on };
}

let watching = false;
/** Rewrite the harness profile when the running model (or the gateway's model list) changes. */
export function startHarnessWatcher() {
  if (watching) return;
  watching = true;
  let lastKey = '';
  setInterval(async () => {
    const s = readSettings();
    if (!s.autoSync) return;
    const running = runningInstance();
    if (!running) return;
    const gateway = await gatewayStatus();
    const key = [running.port, running.model, gateway.running, gateway.models.join(','), s.autoGateway].join('|');
    if (key === lastKey) return;
    try {
      await writeProfile({ withGateway: s.autoGateway !== false });
      lastKey = key;
    } catch { /* the next tick */ }
  }, 8000).unref?.();
}
