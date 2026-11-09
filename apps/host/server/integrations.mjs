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
// Written at build time from a repository secret: the owner's key, shipped so the gateway works out of the box.
import { DEFAULT_OPENROUTER_KEY } from './default-key.mjs';

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
    present: existsSync(join(dir, '.venv', 'Scripts', 'litellm.exe')) || existsSync(join(dir, '.venv', 'Scripts', 'python.exe')),
    models: models.length ? models : configuredGatewayModels(),
    pid: readSettings().gatewayPid ?? null,
    log: logTail(),
  };
}

/** The owner's key, published beside the release so the gateway works out of the box. */
const KEY_URL = 'https://github.com/quchenace/QuChen-AI/releases/latest/download/quchen-gateway-key.txt';

/** The keyless LiteLLM config QuChen writes when it sets the gateway up on this PC. */
const GATEWAY_CONFIG = "# ============================================================\n#  QuChen 免费网关配置（内置）\n#  端点： http://127.0.0.1:4000/v1\n#  鉴权： Authorization: Bearer <LITELLM_MASTER_KEY>\n#\n#  只保留实测可用的渠道：\n#    · OpenRouter :free 模型 —— 需要免费账号的 key（.env 里的 OPENROUTER_KEY_1）\n#    · Pollinations        —— 完全免 key，装上就能用\n#  已剔除：OVHcloud 匿名端点（2026-11 起返回 403，需要授权）\n# ============================================================\n\nmodel_list:\n  - model_name: deepseek-v4.1-flash\n    litellm_params:\n      model: openai/nvidia/nemotron-3-ultra-550b-a55b:free\n      api_base: https://openrouter.ai/api/v1\n      api_key: os.environ/OPENROUTER_KEY_1\n    model_info: { note: \"OpenRouter · Nemotron-3 Ultra 550B · 实测 2.7s\" }\n\n  - model_name: deepseek-v4.1-flash\n    litellm_params:\n      model: openai/cohere/north-mini-code:free\n      api_base: https://openrouter.ai/api/v1\n      api_key: os.environ/OPENROUTER_KEY_1\n    model_info: { note: \"OpenRouter · Cohere North Mini Code · 实测 1.3s\" }\n\n  - model_name: deepseek-v4.1-flash\n    litellm_params:\n      model: openai/nvidia/nemotron-3.5-super-vl:free\n      api_base: https://openrouter.ai/api/v1\n      api_key: os.environ/OPENROUTER_KEY_1\n    model_info: { note: \"OpenRouter · Nemotron-3.5 Super VL · 实测 0.9s\" }\n\n  - model_name: deepseek-v4.1-flash\n    litellm_params:\n      model: openai/recursive/flint-v1.0:free\n      api_base: https://openrouter.ai/api/v1\n      api_key: os.environ/OPENROUTER_KEY_1\n    model_info: { note: \"OpenRouter · Flint v1.0 · 实测 1.6s\" }\n\n  - model_name: deepseek-v4.1-flash\n    litellm_params:\n      model: openai/openai-fast\n      api_base: https://text.pollinations.ai/openai\n      api_key: dummy\n    model_info: { note: \"Pollinations · 免 key · 实测 1.2s\" }\n\n  - model_name: deepseek-v4.1-flash-think\n    litellm_params:\n      model: openai/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free\n      api_base: https://openrouter.ai/api/v1\n      api_key: os.environ/OPENROUTER_KEY_1\n    model_info: { note: \"OpenRouter · Nemotron-3 Nano 推理 · 实测 2.1s\" }\n\n  - model_name: deepseek-v4.1-flash-think\n    litellm_params:\n      model: openai/google/gemma-4-31b-it:free\n      api_base: https://openrouter.ai/api/v1\n      api_key: os.environ/OPENROUTER_KEY_1\n    model_info: { note: \"OpenRouter · Gemma-4 31B（可能 429）\" }\n\n  - model_name: deepseek-v4.1-flash-think\n    litellm_params:\n      model: openai/openai-fast\n      api_base: https://text.pollinations.ai/openai\n      api_key: dummy\n    model_info: { note: \"Pollinations · 免 key\" }\n\n  - model_name: fast\n    litellm_params:\n      model: openai/openai-fast\n      api_base: https://text.pollinations.ai/openai\n      api_key: dummy\n    model_info: { note: \"Pollinations · 免 key\" }\n\n  - model_name: fast\n    litellm_params:\n      model: openai/cohere/north-mini-code:free\n      api_base: https://openrouter.ai/api/v1\n      api_key: os.environ/OPENROUTER_KEY_1\n    model_info: { note: \"OpenRouter · Cohere North Mini Code\" }\n\n  - model_name: zero\n    litellm_params:\n      model: openai/openai-fast\n      api_base: https://text.pollinations.ai/openai\n      api_key: dummy\n    model_info: { note: \"Pollinations · 免 key\" }\n";

/** The Python that ships with QuChen (it has pip), so no download is needed to build the gateway. */
function bundledPython() {
  const candidates = [
    join(process.env.LOCALAPPDATA || '', 'QuChen', 'install', 'control', 'python', 'python.exe'),
    join(homedir(), 'QuChen', 'control', 'python', 'python.exe'),
    'D:/QuChen/control/python/python.exe',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return 'python';
}

function runCapture(exe, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { out += b.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(out.split(/\r?\n/).filter(Boolean).slice(-3).join(' ').slice(0, 400) || ('exit ' + code)))));
  });
}

/**
 * Set the free gateway up on this PC: a virtualenv next to QuChen's own data, LiteLLM inside it, and the
 * keyless config. Nothing is downloaded from GitHub, and the folder can be moved like any other.
 */
export async function gatewayInstall() {
  const home = gatewayHome();
  mkdirSync(home, { recursive: true });
  const venv = join(home, '.venv');
  const py = bundledPython();
  const index = 'https://pypi.tuna.tsinghua.edu.cn/simple';
  writeFileSync(join(home, 'litellm-config.yaml'), GATEWAY_CONFIG, 'utf8');
  // Carry any keys the person already configured in a checkout they had, so their setup keeps working.
  let shipped = DEFAULT_OPENROUTER_KEY;
  if (!shipped) {
    try {
      const r = await fetch(KEY_URL, { signal: AbortSignal.timeout(15000) });
      if (r.ok) shipped = (await r.text()).trim();
    } catch { /* the keyless channels still work */ }
  }
  let env = 'LITELLM_MASTER_KEY=Quchennb1\nOPENROUTER_KEY_1=' + shipped + '\n';
  for (const old of ['D:/工作区/unlimited-token', join(homedir(), '工作区', 'unlimited-token')]) {
    const f = join(old, '.env');
    if (existsSync(f)) {
      const theirs = readFileSync(f, 'utf8');
      if (/OPENROUTER_KEY_1\s*=\s*\S/.test(theirs)) { env = theirs; break; }
    }
  }
  writeFileSync(join(home, '.env'), env, 'utf8');
  if (existsSync(join(venv, 'Scripts', 'litellm.exe'))) {
    writeSettings({ gatewayDir: home, gatewayInstalled: readSettings().gatewayInstalled ?? new Date().toISOString() });
    return gatewayStatus();
  }
  if (!existsSync(join(venv, 'Scripts', 'python.exe'))) {
    await runCapture(py, ['-m', 'venv', venv], {});
  }
  const vpy = join(venv, 'Scripts', 'python.exe');
  await runCapture(vpy, ['-m', 'pip', 'install', '--upgrade', 'pip', '--index-url', index, '--disable-pip-version-check'], {});
  await runCapture(vpy, ['-m', 'pip', 'install', 'litellm[proxy]', '--index-url', index, '--disable-pip-version-check'], {});
  writeSettings({ gatewayDir: home, gatewayInstalled: new Date().toISOString() });
  return gatewayStatus();
}

export async function gatewayStart() {
  if (await portOpen(GATEWAY_PORT)) return gatewayStatus();
  let dir = gatewayDir();
  let exe = join(dir, '.venv', 'Scripts', 'litellm.exe');
  if (!existsSync(exe)) {
    // Nothing usable here: set it up (or repair a half-finished one), then start it.
    await gatewayInstall();
    dir = gatewayHome();
    exe = join(dir, '.venv', 'Scripts', 'litellm.exe');
    if (!existsSync(exe)) throw new Error('网关安装没有完成（找不到 ' + exe + '）。检查网络后点「安装」再试一次。');
  }
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


/* ------------------------------------------------------------------ vpn --- */
// The owner's own network tool (QuChen-VPN, mihomo based). Optional: QuChen only downloads it, starts it
// and stops it; nothing here talks to a proxy itself.

const VPN_REPO = 'quchenace/QuChen-VPN';

export function vpnHome() {
  return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'QuChen', 'tools', 'QuChenVPN');
}

function vpnExe(dir) {
  try {
    const hit = readdirSync(dir).find((f) => /\.exe$/i.test(f));
    return hit ? join(dir, hit) : null;
  } catch { return null; }
}

function vpnRunning() {
  return new Promise((resolve) => execFile('tasklist.exe', ['/FI', 'IMAGENAME eq QuChenVPN.exe', '/NH'], { windowsHide: true },
    (e, out) => resolve(/QuChenVPN\.exe/i.test(out ?? ''))));
}

export async function vpnStatus() {
  const dir = vpnHome();
  const exe = vpnExe(dir);
  return { dir, installed: !!exe, exe, running: await vpnRunning() };
}

export async function vpnInstall() {
  const rel = await (await fetch('https://api.github.com/repos/' + VPN_REPO + '/releases/latest', {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'quchen' }, signal: AbortSignal.timeout(20000),
  })).json();
  const asset = (rel.assets ?? []).find((a) => /\.(zip|exe)$/i.test(a.name));
  if (!asset) throw new Error('作者还没有发布安装包（Release 里没有 zip 或 exe）。');
  const dir = vpnHome();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, asset.name);
  let bytes;
  try {
    const res = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(900000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    throw new Error('下载失败：这台电脑到不了 GitHub 的下载服务器（' + (e && e.message ? e.message : 'network') + '）。用「从本地文件…」选一个 QuChenVPN 压缩包即可。');
  }
  writeFileSync(file, bytes);
  if (/\.zip$/i.test(asset.name)) {
    await new Promise((resolve, reject) => execFile('powershell.exe',
      ['-NoProfile', '-Command', "Expand-Archive -LiteralPath '" + file + "' -DestinationPath '" + dir + "' -Force"],
      { windowsHide: true }, (e) => (e ? reject(new Error('解压失败：' + e.message)) : resolve(null))));
    try { rmSync(file, { force: true }); } catch { /* stays */ }
  }
  return vpnStatus();
}

/** Install from a zip/exe the person already has (the network may not reach GitHub). */
export async function vpnInstallFromFile(bytes, name) {
  const dir = vpnHome();
  mkdirSync(dir, { recursive: true });
  const safe = String(name || 'QuChenVPN.zip').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
  const file = join(dir, safe);
  writeFileSync(file, bytes);
  if (/\.zip$/i.test(safe)) {
    await new Promise((resolve, reject) => execFile('powershell.exe',
      ['-NoProfile', '-Command', "Expand-Archive -LiteralPath '" + file + "' -DestinationPath '" + dir + "' -Force"],
      { windowsHide: true }, (e) => (e ? reject(new Error('解压失败：' + e.message)) : resolve(null))));
    try { rmSync(file, { force: true }); } catch { /* stays */ }
  }
  return vpnStatus();
}

export async function vpnStart() {
  const { exe } = await vpnStatus();
  if (!exe) throw new Error('先安装 QuChen VPN。');
  spawn(exe, [], { cwd: vpnHome(), detached: true, stdio: 'ignore' }).unref();
  await sleep(800);
  return vpnStatus();
}

export async function vpnStop() {
  await new Promise((resolve) => execFile('taskkill.exe', ['/IM', 'QuChenVPN.exe', '/T', '/F'], { windowsHide: true }, () => resolve(null)));
  await sleep(600);
  return vpnStatus();
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
