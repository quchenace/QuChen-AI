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
import { appendFileSync, closeSync, createReadStream, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createConnection } from 'node:net';
// Written at build time from a repository secret: the owner's key, shipped so the gateway works out of the box.
import { DEFAULT_OPENROUTER_KEY } from './default-key.mjs';
// The free-model catalogue of the dsh-our-free-model plugin, and the LiteLLM config built from it.
import { buildGatewayConfig, describeGatewayConfig, freeModelCatalogue, gatewayThinks, installedCatalogue, parseEnv, envText } from './gateway-config.mjs';
import { ofmModels, ofmStatus } from './ofm-gateway.mjs';
import { checkGatewayHealth, configureGatewayHealth, gatewayHealthStatus, startGatewayHealth, stopGatewayHealth } from './gateway-health.mjs';

export const PASSCODES = ['王朝玉', '姜俊涛', 'quchen'];

/** Kept as a seam, but open: QuChen is a local app and the owner asked for no gate. */
export function passcodeOk() {
  return true;
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

/** The app's own model-connection store, so the gateway shows up as a normal model source. */
let providerStore = null;
export function attachProviders(store) {
  providerStore = store;
  // The gateway is often started after QuChen (or was already running from an earlier launch), so one
  // early look is not enough: keep trying until the connection is in place, then stop.
  const retry = (attempt, delayMs) => setTimeout(async () => {
    const connection = await ensureGatewayConnection().catch(() => null);
    if (!connection && attempt < 20) retry(attempt + 1, attempt < 6 ? 5000 : 15000);
  }, delayMs);
  retry(0, 4000);
  // Sweep the logon task an older build left behind: otherwise the first API call pops a Script Host box.
  setTimeout(() => { void retireStaleProxyTask().catch(() => null); }, 1200);
}

/** Register or refresh the gateway connection in the model picker (idempotent). */
export async function ensureGatewayConnection() {
  if (!providerStore) return null;
  const gateway = await gatewayStatus();
  if (!gateway.models.length) return null;
  const list = providerStore.list();
  const existing = list.connections.find((c) => c.name === 'QuChen 免费网关');
  try {
    providerStore.save({
      id: existing?.id,
      kind: 'custom',
      name: 'QuChen 免费网关',
      baseUrl: 'http://127.0.0.1:' + GATEWAY_PORT + '/v1',
      protocol: 'openai-chat',
      apiKey: gatewayKey(),
      // `reasoning` is what shows the reasoning level menu for a gateway model: the gateway's /v1/models
      // does not advertise it, so the name decides.
      models: gateway.models.map((id) => ({ id, name: id, reasoning: gatewayThinks(id) })),
    });
    return providerStore.list().connections.find((c) => c.name === 'QuChen 免费网关') ?? null;
  } catch (e) {
    return null;
  }
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

/** The launcher script an older build wrote for the logon task, under the same data folder as the gateway log. */
const proxyLauncher = () => join(DATA, 'api-proxy', 'start-hidden.vbs');
const PROXY_TASK = 'QuChen API proxy';
/** Sticky: once the task is known to point at a script that is gone, never poke it again this session. */
let proxyTaskRetired = false;

function schtasks(args) {
  return new Promise((resolve) => execFile('schtasks.exe', args, { windowsHide: true }, () => resolve(null)));
}

/**
 * An older build registered a logon task that runs `wscript.exe <data>\api-proxy\start-hidden.vbs`. This build starts
 * the gateway as a child of the host instead, so nothing rewrites that script; on a machine that upgraded, the task
 * survives and every run of it is a Windows Script Host box saying "cannot find script file". End and delete it, once,
 * so opening QuChen stops popping that dialog.
 */
async function retireStaleProxyTask() {
  if (proxyTaskRetired) return true;
  if (existsSync(proxyLauncher())) return false;
  proxyTaskRetired = true;
  await schtasks(['/End', '/TN', PROXY_TASK]);
  await schtasks(['/Delete', '/TN', PROXY_TASK, '/F']);
  return true;
}

async function ensureProxy() {
  if (await portOpen(PROXY_PORT)) return true;
  // Only a machine that still has the old launcher script can start it: running a task whose script is missing is
  // what throws the Script Host error in the owner's face.
  if (await retireStaleProxyTask()) return false;
  await schtasks(['/Run', '/TN', PROXY_TASK]);
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


/** Download through the system proxy when there is one: Node's fetch ignores it, and the VPN sets it. */
export function downloadWithProxy(url, destination) {
  return new Promise((resolve, reject) => {
    const script = "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '" + url.replace(/'/g, "''") + "' -OutFile '" + destination.replace(/'/g, "''") + "' -TimeoutSec 1800";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, _out, err) => {
      if (error) reject(new Error(String(err || error.message).split(/\r?\n/).filter(Boolean).slice(-1)[0] || 'download failed'));
      else resolve(destination);
    });
  });
}

/* --------------------------------------------------------------- gateway --- */

export function gatewayHome() {
  return readSettings().gatewayDir || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'QuChen', 'gateway');
}

/** A folder QuChen can run: either its own copy or a checkout the person already had. */
export function gatewayDir() {
  const override = process.env.QUCHEN_GATEWAY_DIR;
  if (override && existsSync(join(override, '.venv', 'Scripts', 'litellm.exe'))) return override;
  return gatewayHome();
}

/** `.env` -> object. The parser lives with the generator so both read a key the same way. */
function envFile(dir) {
  try { return parseEnv(readFileSync(join(dir, '.env'), 'utf8')); } catch { return {}; }
}

function gatewayKey() { return readSettings().gatewayKey || envFile(gatewayDir()).LITELLM_MASTER_KEY || 'Quchennb1'; }

function configuredGatewayModels() {
  try {
    const yaml = readFileSync(join(gatewayDir(), 'litellm-config.yaml'), 'utf8');
    const names = [...yaml.matchAll(/^\s*-\s*model_name:\s*["']?([^\s"'#]+)/gm)].map((m) => m[1]);
    return [...new Set(names)];
  } catch { return []; }
}

/** What the config on disk was built from: the plugin catalogue and how much of it is live. */
function gatewayCatalogue(dir) {
  const opts = { includeAll: process.env.QUCHEN_GATEWAY_ALL === '1', catalog: installedCatalogue() };
  try { return describeGatewayConfig(envFile(dir), opts); } catch { return null; }
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
  if (running && models.length) {
    configureGatewayHealth({ baseUrl: 'http://127.0.0.1:' + GATEWAY_PORT + '/v1', key: gatewayKey(), models });
  }
  return {
    dir, port: GATEWAY_PORT, running, home: gatewayHome(),
    present: existsSync(join(dir, '.venv', 'Scripts', 'litellm.exe')) || existsSync(join(dir, '.venv', 'Scripts', 'python.exe')),
    models: models.length ? models : configuredGatewayModels(),
    catalogue: gatewayCatalogue(dir),
    // The plugin's own gateway is a second upstream, not a catalogue: its models appear as ofm/<id>.
    ofm: await ofmStatus({ cacheMs: 1500 }),
    // What answered a one-token probe recently, and the fastest of those: the panel recommends from here.
    health: gatewayHealthStatus(),
    pid: readSettings().gatewayPid ?? null,
    log: logTail(),
  };
}

/**
 * Probe the gateway now (or return the last result) and recommend the fastest working model. The panel
 * calls this with force=1; the background timer keeps it fresh otherwise.
 */
export async function gatewayHealth({ force = false } = {}) {
  if (!(await portOpen(GATEWAY_PORT))) return { ...gatewayHealthStatus(), running: false };
  const baseUrl = 'http://127.0.0.1:' + GATEWAY_PORT + '/v1';
  const models = await listModels(baseUrl, gatewayKey());
  return { running: true, ...(await checkGatewayHealth({ baseUrl, key: gatewayKey(), models, force })) };
}

/** The owner's key, published beside the release so the gateway works out of the box. */
const KEY_URL = 'https://github.com/quchenace/QuChen-AI/releases/latest/download/quchen-gateway-key.txt';


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
 * A litellm.exe left running from an earlier install holds its own image file, so pip cannot replace it
 * (WinError 32, surfaced as "Could not install packages due to an OSError") and the setup looks like a
 * network failure. Stopping our own child is not enough: a gateway started by hand is in the way too.
 */
async function gatewayKill() {
  stopGatewaySupervisor();
  stopGatewayHealth();
  const pid = readSettings().gatewayPid;
  if (pid) await new Promise((resolve) => execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve(null)));
  await new Promise((resolve) => execFile('taskkill.exe', ['/IM', 'litellm.exe', '/T', '/F'], { windowsHide: true }, () => resolve(null)));
  writeSettings({ gatewayPid: null });
  await sleep(500);
}

/**
 * Set the free gateway up on this PC: a virtualenv next to QuChen's own data, LiteLLM inside it, and the
 * config built from the built-in endpoints plus the dsh-our-free-model catalogue. Nothing is downloaded
 * from GitHub, and the folder can be moved like any other.
 */
export async function gatewayInstall() {
  const home = gatewayHome();
  mkdirSync(home, { recursive: true });
  const venv = join(home, '.venv');
  const py = bundledPython();
  const index = 'https://pypi.tuna.tsinghua.edu.cn/simple';
  // Carry any keys the person already configured in a checkout they had, so their setup keeps working.
  let shipped = DEFAULT_OPENROUTER_KEY;
  if (!shipped) {
    try {
      const r = await fetch(KEY_URL, { signal: AbortSignal.timeout(15000) });
      if (r.ok) shipped = (await r.text()).trim();
    } catch { /* the keyless channels still work */ }
  }
  let envText = 'LITELLM_MASTER_KEY=Quchennb1\nOPENROUTER_KEY_1=' + shipped + '\n';
  for (const old of ['D:/工作区/unlimited-token', join(homedir(), '工作区', 'unlimited-token')]) {
    const f = join(old, '.env');
    if (existsSync(f)) {
      const theirs = readFileSync(f, 'utf8');
      if (/OPENROUTER_KEY_1\s*=\s*\S/.test(theirs)) { envText = theirs; break; }
    }
  }
  writeFileSync(join(home, '.env'), envText, 'utf8');
  // The models follow the keys that are in that .env: a provider without a key is left out rather than
  // written as a deployment that can only answer 401. The plugin's running gateway is a second upstream.
  const ofm = await ofmModels({ force: true, timeoutMs: 2000 });
  if (ofm.running && ofm.key) rememberOfmKey(home, ofm.key);
  writeGatewayConfig(home, parseEnv(envText), { ofm });
  if (existsSync(join(venv, 'Scripts', 'litellm.exe'))) {
    writeSettings({ gatewayDir: home, gatewayInstalled: readSettings().gatewayInstalled ?? new Date().toISOString() });
    return gatewayStatus();
  }
  if (!existsSync(join(venv, 'Scripts', 'python.exe'))) {
    await runCapture(py, ['-m', 'venv', venv], {});
  }
  const vpy = join(venv, 'Scripts', 'python.exe');
  // Nothing may hold litellm.exe while it is (re)installed. The log line people hit was
  // "Could not install packages ... WinError 32 ... litellm.exe", which reads as a network problem.
  await gatewayKill();
  await runCapture(vpy, ['-m', 'pip', 'install', '--upgrade', 'pip', '--index-url', index, '--disable-pip-version-check'], {});
  const pipInstall = ['-m', 'pip', 'install', 'litellm[proxy]', '--index-url', index, '--disable-pip-version-check'];
  try {
    await runCapture(vpy, pipInstall, {});
  } catch (e) {
    if (!/WinError 32|being used by another process|或被另一进程使用/i.test(String(e?.message ?? ''))) throw e;
    await gatewayKill();
    await runCapture(vpy, pipInstall, {});
  }
  writeSettings({ gatewayDir: home, gatewayInstalled: new Date().toISOString() });
  return gatewayStatus();
}

/**
 * Write `litellm-config.yaml` for a gateway folder from the current .env. Called on install and on every
 * start, so adding a key to .env (then restarting the gateway) is all it takes to gain that provider.
 */
export function writeGatewayConfig(home, env = parseEnv(existsSync(join(home, '.env')) ? readFileSync(join(home, '.env'), 'utf8') : ''), { ofm = null } = {}) {
  const built = buildGatewayConfig(env, { includeAll: process.env.QUCHEN_GATEWAY_ALL === '1', ofm, catalog: installedCatalogue() });
  writeFileSync(join(home, 'litellm-config.yaml'), built.text, 'utf8');
  writeSettings({ gatewayModels: built.models.length, gatewayProviders: built.providers.length, gatewayCatalogue: (freeModelCatalogue().source ?? {}).version ?? null });
  return built;
}

/** Put (or refresh) the plugin gateway's key in the gateway .env, without touching the person's other keys. */
function rememberOfmKey(dir, key) {
  if (!key) return;
  const file = join(dir, '.env');
  const env = parseEnv(existsSync(file) ? readFileSync(file, 'utf8') : '');
  if (env.OFM_GATEWAY_KEY === key) return;
  env.OFM_GATEWAY_KEY = key;
  writeFileSync(file, envText(env), { encoding: 'utf8', mode: 0o600 });
}

/** Write the generated config, but never over a file a person edited by hand. */
const GENERATED_MARK = '由 apps/host/server/gateway-config.mjs 生成';
function maybeWriteGatewayConfig(dir, ofm = null) {
  const file = join(dir, 'litellm-config.yaml');
  if (existsSync(file)) {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { return null; }
    if (text && !text.includes(GENERATED_MARK)) return null;   // someone's own config: leave it alone
  }
  return writeGatewayConfig(dir, undefined, { ofm });
}

// The gateway is a separate process whose upstreams can take it down (a quota error inside LiteLLM, a
// killed child, a machine that slept). When it goes, every model DSH was synced to answers with
// "connection refused", which reads as a broken app. So the port is watched and the gateway is put back.
let supervisor = null;
let supervisorFails = 0;
let supervisorRestarts = 0;
let supervisorBusy = false;

function startGatewaySupervisor() {
  if (supervisor) return;
  supervisor = setInterval(async () => {
    if (supervisorBusy) return;
    supervisorBusy = true;
    try {
      if (await portOpen(GATEWAY_PORT, 900)) { supervisorFails = 0; return; }
      supervisorFails += 1;
      if (supervisorFails < 2 || supervisorRestarts >= 3) return;
      supervisorRestarts += 1;
      await gatewayStart();
      if (await portOpen(GATEWAY_PORT, 900)) { supervisorFails = 0; supervisorRestarts = 0; }
    } catch { /* the next tick tries again */ } finally {
      supervisorBusy = false;
    }
  }, 20000);
  if (supervisor.unref) supervisor.unref();
}

export function stopGatewaySupervisor() {
  if (supervisor) clearInterval(supervisor);
  supervisor = null;
  supervisorFails = 0;
  supervisorRestarts = 0;
}

export async function gatewayStart() {
  // Already running (started by an earlier launch, or by the person directly): still make sure the model
  // picker knows about it, otherwise chat keeps saying no model is loaded.
  if (await portOpen(GATEWAY_PORT)) {
    const status = await gatewayStatus();
    if (status.models.length) await ensureGatewayConnection().catch(() => null);
    startGatewaySupervisor();
    return status;
  }
  let dir = gatewayDir();
  let exe = join(dir, '.venv', 'Scripts', 'litellm.exe');
  if (!existsSync(exe)) {
    // Nothing usable here: set it up (or repair a half-finished one), then start it.
    await gatewayInstall();
    dir = gatewayHome();
    exe = join(dir, '.venv', 'Scripts', 'litellm.exe');
    if (!existsSync(exe)) throw new Error('网关安装没有完成（找不到 ' + exe + '）。检查网络后点「安装」再试一次。');
  }
  // A key added to .env since the last start turns into deployments here, and so does the plugin
  // gateway if DSH is running: its lanes are not expressible as plain provider entries.
  try {
    const ofm = await ofmModels({ force: true, timeoutMs: 2500 });
    if (ofm.running && ofm.key) rememberOfmKey(dir, ofm.key);
    maybeWriteGatewayConfig(dir, ofm);
  } catch { /* keep the file that is there */ }
  mkdirSync(DATA, { recursive: true });
  const fd = openSync(gatewayLog(), 'a');
  const env = { ...process.env, ...envFile(dir), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', LITELLM_LOCAL_MODEL_COST_MAP: 'True' };
  const child = spawn(exe, ['--config', join(dir, 'litellm-config.yaml'), '--port', String(GATEWAY_PORT), '--host', '127.0.0.1'],
    { cwd: dir, env, stdio: ['ignore', fd, fd], windowsHide: true });
  gatewayChild = child;
  writeSettings({ gatewayPid: child.pid });
  for (let i = 0; i < 30; i++) { await sleep(700); if (await portOpen(GATEWAY_PORT)) break; }
  const status = await gatewayStatus();
  if (status.running) {
    const baseUrl = 'http://127.0.0.1:' + GATEWAY_PORT + '/v1';
    configureGatewayHealth({ baseUrl, key: gatewayKey(), models: status.models });
    startGatewayHealth({ baseUrl, key: gatewayKey(), models: status.models });
    startGatewaySupervisor();
    await ensureGatewayConnection().catch(() => null);
  }
  return status;
}

export async function gatewayStop() {
  stopGatewaySupervisor();
  stopGatewayHealth();
  const pid = readSettings().gatewayPid;
  if (pid) await new Promise((resolve) => execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve(null)));
  await new Promise((resolve) => execFile('powershell.exe',
    ['-NoProfile', '-Command', 'Get-NetTCPConnection -LocalPort ' + GATEWAY_PORT + ' -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }'],
    { windowsHide: true }, () => resolve(null)));
  writeSettings({ gatewayPid: null });
  await sleep(600);
  return gatewayStatus();
}

/**
 * Rebuild the config and restart the gateway, so a plugin gateway that started after QuChen's (or a key
 * added to .env) is picked up without restarting QuChen.
 */
export async function gatewayRefresh() {
  if (await portOpen(GATEWAY_PORT)) await gatewayStop();
  return gatewayStart();
}

export async function gatewayAction(action, dir) {
  if (dir) writeSettings({ gatewayDir: dir });
  if (action === 'install') return gatewayInstall({ url: dir });
  if (action === 'start') return gatewayStart();
  if (action === 'stop') return gatewayStop();
  if (action === 'refresh') return gatewayRefresh();
  return gatewayStatus();
}


/* ------------------------------------------------------------------ vpn --- */
// The owner's own network tool (QuChen-VPN, mihomo based). Optional: QuChen only installs it,
// starts it and stops it; nothing here talks to a proxy itself.
//
// QuChen-VPN publishes two shapes: QuChenVPN-Setup.exe (Inno Setup, PrivilegesRequired=lowest, so no UAC
// prompt) and QuChenVPN-win64.zip (portable, the shape its own in-app updater mirrors in place). The
// installer is what we use: one silent run, it owns its uninstall entry, shortcuts and file list, and it
// is pointed at vpnHome() so the app still owns the folder. The zip stays as the fallback for an older
// release that has no Setup.exe.

const VPN_REPO = 'quchenace/QuChen-VPN';
const VPN_KEEP_DIRS = ['data', 'logs'];          // the app's own state: an install never wipes these
// settings.json is the app's own state; unins* is the installer's uninstall entry, which a mirror copy
// from a zip must not delete or "Apps & features" would keep pointing at a file that is gone.
const VPN_KEEP_FILES = ['settings.json', 'unins*'];

export function vpnHome() {
  return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'QuChen', 'tools', 'QuChenVPN');
}

/** Where the app can be: the folder we unpacked into, or the per-user / machine install a setup made. */
function vpnDirs() {
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  return [vpnHome(), join(local, 'Programs', 'QuChen VPN'), join(process.env.ProgramFiles || 'C:/Program Files', 'QuChen VPN')];
}

/**
 * Find QuChenVPN.exe, two levels deep: the release zip is built with includeBaseDirectory=true, so
 * an unzipped copy keeps its exe under QuChenVPN\QuChenVPN.exe unless the install flattens it.
 */
function findExe(dir, depth = 0) {
  try {
    const items = readdirSync(dir, { withFileTypes: true });
    const hit = items.find((x) => x.isFile() && /^QuChenVPN.*\.exe$/i.test(x.name));
    if (hit) return join(dir, hit.name);
    if (depth >= 2) return null;
    for (const x of items) {
      if (!x.isDirectory()) continue;
      const sub = findExe(join(dir, x.name), depth + 1);
      if (sub) return sub;
    }
  } catch { /* next */ }
  return null;
}

function vpnExe() {
  for (const dir of vpnDirs()) {
    const hit = findExe(dir);
    if (hit) return hit;
  }
  return null;
}

/** Live progress of the download/install, read by the panel. */
let vpnProgress = { phase: 'idle', done: 0, total: 0, message: '' };

function vpnRunning() {
  return new Promise((resolve) => execFile('tasklist.exe', ['/FI', 'IMAGENAME eq QuChenVPN.exe', '/NH'], { windowsHide: true },
    (e, out) => resolve(/QuChenVPN\.exe/i.test(out ?? ''))));
}

export async function vpnStatus() {
  const exe = vpnExe();
  return { dir: exe ? dirname(exe) : vpnHome(), installed: !!exe, exe, running: await vpnRunning(), progress: vpnProgress };
}

/** The release metadata: direct first, then through the system proxy (a plain fetch ignores it). */
async function vpnRelease() {
  const url = 'https://api.github.com/repos/' + VPN_REPO + '/releases/latest';
  try {
    const res = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'quchen' }, signal: AbortSignal.timeout(15000) });
    if (res.ok) return await res.json();
  } catch { /* blocked without a proxy: retried below */ }
  const file = join(tmpdir(), 'quchen-vpn-release.json');
  await downloadWithProxy(url, file);
  try { return JSON.parse(readFileSync(file, 'utf8')); } finally { try { rmSync(file, { force: true }); } catch { /* stays */ } }
}

/**
 * Whether a candidate can actually move bytes, measured instead of assumed: 256 KB of the real asset,
 * timed. A relay that is not reachable answers nothing in about a second, and a slow one is ranked
 * behind a fast one instead of being found out halfway through a 160 MB download.
 */
async function probeSpeed(url, budget = 7000) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'quchen', range: 'bytes=0-262143' },
      signal: AbortSignal.timeout(budget),
    });
    if (!res.ok && res.status !== 206) { try { await res.body?.cancel(); } catch { /* gone */ } return null; }
    let bytes = 0;
    try {
      for await (const chunk of res.body) {
        bytes += chunk.length;
        if (bytes >= 262144) break;
      }
    } catch { /* a short read still says something about latency */ }
    try { await res.body?.cancel(); } catch { /* gone */ }
    if (!bytes) return null;
    const ms = Math.max(1, Date.now() - started);
    return { bps: (bytes / ms) * 1000, ms, bytes };
  } catch { return null; }
}

/** GitHub release assets, then the relays people in CN actually get through. */
const GH_MIRRORS = [
  // Measured from this network on 2026-11-11: ghproxy.net 220 KB/s/stream and ~1 MB/s over four ranges;
  // gh.nxnow.top 288 KB/s; ghfast/gh-proxy timed out. The probe still decides per run — these are only candidates.
  { prefix: 'https://ghproxy.net/', label: '镜像 ghproxy.net' },
  { prefix: 'https://gh.nxnow.top/', label: '镜像 nxnow' },
  { prefix: 'https://ghfast.top/', label: '镜像 ghfast' },
  { prefix: 'https://gh-proxy.com/', label: '镜像 gh-proxy' },
];

/**
 * Every address worth trying, fastest measured first, then the ones that did not answer the probe, and
 * the system proxy last (it is what the VPN itself provides, so it is there when nothing else is).
 */
async function assetCandidates(url) {
  const list = [{ url, label: '直连' }, ...GH_MIRRORS.map((m) => ({ url: m.prefix + url, label: m.label }))];
  const probed = await Promise.all(list.map(async (c) => ({ ...c, speed: await probeSpeed(c.url) })));
  const fast = probed.filter((c) => c.speed).sort((a, b) => b.speed.bps - a.speed.bps);
  const slow = probed.filter((c) => !c.speed);
  const order = [...fast, ...slow];
  if (order.length) vpnProgress = { ...vpnProgress, message: vpnProgress.message + ' · 走 ' + order[0].label };
  order.push({ url: null, label: '系统代理' });
  return order;
}

/** Files below this use one stream: a few ranges would only add TCP slow starts. */
const DL_MIN_PARALLEL = 8 * 1024 * 1024;
/** Ranges in flight. One TCP stream gets ~220 KB/s from these mirrors; four already reach ~1 MB/s. */
const DL_CONNECTIONS = 8;

/**
 * A large asset over several byte ranges. The mirrors throttle one connection, not the line: 8 ranges turn
 * 31 MB from ~2.5 minutes into ~20 seconds here. Falls back to one stream when the server does not answer a
 * ranged request (no 206) or the size is unknown; throws when a range keeps failing, so the caller can use
 * the next mirror.
 */
export async function streamAssetParallel(url, file, total, message) {
  const head = await fetch(url, { headers: { range: 'bytes=0-0', 'user-agent': 'quchen' }, signal: AbortSignal.timeout(15000) });
  if (head.status !== 206) {
    try { await head.body?.cancel(); } catch { /* none */ }
    return streamAsset(url, file, total, message);
  }
  const range = /\/(\d+)\s*$/.exec(head.headers.get('content-range') || '');
  const size = Number(range?.[1] || total || 0);
  try { await head.body?.cancel(); } catch { /* none */ }
  if (!size || size < DL_MIN_PARALLEL) return streamAsset(url, file, total || size, message);

  const fd = openSync(file, 'w');
  ftruncateSync(fd, size);
  const step = Math.ceil(size / DL_CONNECTIONS);
  let next = 0;
  let done = 0;
  let failed = null;
  const controller = new AbortController();
  const worker = async () => {
    while (!failed) {
      const i = next++;
      const start = i * step;
      const end = Math.min(size - 1, start + step - 1);
      if (start > end) return;
      let tries = 0;
      for (;;) {
        try {
          const res = await fetch(url, {
            headers: { range: 'bytes=' + start + '-' + end, 'user-agent': 'quchen' },
            signal: controller.signal,
          });
          if (res.status !== 206) throw new Error('HTTP ' + res.status);
          let pos = start;
          for await (const chunk of res.body) {
            writeSync(fd, chunk, 0, chunk.length, pos);
            pos += chunk.length;
            done += chunk.length;
            vpnProgress = { phase: 'downloading', done, total: size, message: message + ' · 多线程 ' + DL_CONNECTIONS };
          }
          if (pos !== end + 1) throw new Error('range ended early');
          break;
        } catch (e) {
          if (failed) return;
          if (++tries >= 3) { failed = e; controller.abort(); return; }
          await sleep(300 * tries);
        }
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: DL_CONNECTIONS }, worker));
  } catch (e) {
    failed = e;
  }
  try { closeSync(fd); } catch { /* already closed */ }
  if (failed || done !== size) throw failed || new Error('range download incomplete ' + done + '/' + size);
  return size;
}

/** One candidate, streamed to disk with live progress. Throws when it cannot be finished. */
async function streamAsset(url, file, total, message) {
  const res = await fetch(url, { headers: { 'user-agent': 'quchen' }, signal: AbortSignal.timeout(1800000) });
  if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
  const size = Number(res.headers.get('content-length') || total || 0);
  let done = 0;
  const reader = res.body.getReader();
  rmSync(file, { force: true });
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    appendFileSync(file, Buffer.from(value));
    done += value.length;
    vpnProgress = { phase: 'downloading', done, total: size, message };
  }
}

/**
 * Fetch one asset: the measured-fastest address first, every other one after it, and the system proxy
 * when the network only lets that through. Gives up on a short file rather than installing half of it.
 */
async function vpnFetchAsset(url, file, total, message) {
  const order = await assetCandidates(url);
  let last = null;
  for (const candidate of order) {
    rmSync(file, { force: true });
    try {
      if (!candidate.url) {
        vpnProgress = { phase: 'downloading', done: 0, total: total || 0, message: '改用系统代理…' };
        await downloadWithProxy(url, file);
      } else {
        await streamAssetParallel(candidate.url, file, total, message + (candidate.label && candidate.label !== '直连' ? '（' + candidate.label + '）' : ''));
      }
      const size = existsSync(file) ? statSync(file).size : 0;
      if (!size) throw new Error('没有拿到文件');
      if (total && size < total * 0.98) throw new Error('不完整 ' + Math.round(size / 1048576) + '/' + Math.round(total / 1048576) + ' MB');
      return size;
    } catch (e) {
      last = e;
    }
  }
  rmSync(file, { force: true });
  throw new Error('下载失败：' + (last?.message ?? '没有可用的线路') + '。先让 QuChen VPN 连上，再试一次。');
}

/** Unpack a release zip into dir, mirroring over an older copy but keeping the app's own state. */
async function vpnUnpack(zipFile, dir) {
  const tmp = join(tmpdir(), 'quchen-vpn-unpack-' + Date.now());
  mkdirSync(tmp, { recursive: true });
  vpnProgress = { ...vpnProgress, phase: 'unpacking', message: '正在解压…' };
  await new Promise((resolve, reject) => execFile('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
      "$ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath '" + zipFile + "' -DestinationPath '" + tmp + "' -Force"],
    { windowsHide: true }, (e) => (e ? reject(new Error('解压失败：' + e.message)) : resolve(null))));
  let from = tmp;
  const items = readdirSync(tmp, { withFileTypes: true });
  if (items.length === 1 && items[0].isDirectory()) {
    const inner = join(tmp, items[0].name);
    if (findExe(inner)) from = inner;
  }
  // robocopy /MIR: old files the new build no longer ships are removed, instead of lingering.
  await new Promise((resolve, reject) => execFile('robocopy.exe',
    [from, dir, '/MIR', '/XF', ...VPN_KEEP_FILES, '/XD', ...VPN_KEEP_DIRS, '/NFL', '/NDL', '/NJH', '/NJS', '/NP'],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e) => {
      const code = e && typeof e.code === 'number' ? e.code : (e ? 16 : 0);
      if (code < 8) resolve(null); else reject(new Error('写入 ' + dir + ' 失败（robocopy ' + code + '）'));
    }));
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* stays */ }
}

/** sha256 of a file, streamed: a 160 MB installer never sits in memory. */
function fileSha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * A setup runs silently into the folder we manage, never into Program Files behind a UAC prompt.
 *
 * The path is passed bare. spawn() does not go through a shell, and libuv already quotes an argument
 * that contains a space, so an extra pair of quotes ends up *inside* the value: Inno Setup then reads
 * a directory that still holds a `"`, refuses it during initialization and exits 1 (or 3) before it
 * even opens the /LOG file. That was the "安装程序返回 1" every install from inside the app hit.
 * When the package still refuses, one retry runs without /DIR so the built-in DefaultDirName applies,
 * and the setup log tail is quoted back so the next failure is diagnosable.
 */
function vpnRunSetup(file, dir) {
  const log = join(tmpdir(), 'quchen-vpn-setup.log');
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(null) : reject(new Error('exit ' + code))));
  });
  const base = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOCANCEL', '/NOICONS', '/CURRENTUSER'];
  try { rmSync(log, { force: true }); } catch { /* none */ }
  return run([...base, '/DIR=' + dir, '/LOG=' + log])
    .catch(() => run([...base, '/LOG=' + log]).catch((e) => {
      let why = '';
      try {
        why = readFileSync(log, 'utf8').split(/\r?\n/).filter((l) => /error|failed|invalid|refus/i.test(l)).slice(-2).join(' / ');
      } catch { /* no log: the exit code is all there is */ }
      throw new Error('安装程序返回 ' + (e.message || '').replace(/^exit\s*/i, '') + (why ? '（' + why.slice(0, 200) + '）' : '') + '。安装包在 ' + file + '，也可以手动双击安装。');
    }));
}

/**
 * Which release asset to install: the silent Inno Setup package when the release has one, the portable
 * zip only when it does not. Exported so the choice is testable without a network.
 */
export function vpnAssetFor(assets) {
  const list = (assets ?? []).filter((a) => a?.name && a?.browser_download_url);
  const setup = list.find((a) => /setup\.exe$/i.test(a.name));
  if (setup) return { asset: setup, kind: '安装包' };
  const zip = list.find((a) => /\.zip$/i.test(a.name));
  if (zip) return { asset: zip, kind: '便携包' };
  return null;
}

export async function vpnInstall() {
  vpnProgress = { phase: 'resolving', done: 0, total: 0, message: '正在查询最新版本…' };
  try {
    const rel = await vpnRelease();
    const picked = vpnAssetFor(rel.assets);
    if (!picked) throw new Error('作者还没有发布安装包（Release 里没有 Setup.exe 或 zip）。');
    const { asset, kind } = picked;

    const dir = vpnHome();
    mkdirSync(dir, { recursive: true });
    // A running copy holds its own exe and DLLs: stop it first, gracefully, so it can drop the proxy.
    if (await vpnRunning()) {
      vpnProgress = { phase: 'installing', done: 0, total: 0, message: '先关掉正在运行的 QuChen VPN…' };
      await vpnStop();
    }
    vpnProgress = { phase: 'downloading', done: 0, total: asset.size ?? 0, message: '正在下载' + kind + ' ' + asset.name + (asset.size ? '（约 ' + Math.round(asset.size / 1048576) + ' MB）' : '') };
    const file = join(tmpdir(), String(asset.name).replace(/[^\w.\-]/g, '_'));
    const size = await vpnFetchAsset(asset.browser_download_url, file, asset.size ?? 0, vpnProgress.message);
    // A mirror relays the bytes, so the file is checked against the hash GitHub itself recorded for the
    // asset. Releases published before GitHub started sending `digest` have none: then the size check in
    // vpnFetchAsset is what there is.
    const want = String(asset.digest ?? '').toLowerCase();
    if (want.startsWith('sha256:')) {
      vpnProgress = { ...vpnProgress, phase: 'installing', message: '正在核对安装包…' };
      const got = await fileSha256(file);
      if (got !== want.slice(7)) throw new Error('安装包校验失败（SHA-256 不符），已中止。请重试或从本地文件安装。');
    }

    const isSetup = /setup\.exe$/i.test(asset.name);
    vpnProgress = { phase: 'installing', done: size, total: asset.size ?? size, message: isSetup ? '正在运行安装包…' : '正在解压…' };
    if (isSetup) await vpnRunSetup(file, dir);
    else await vpnUnpack(file, dir);
    try { rmSync(file, { force: true }); } catch { /* stays */ }
    await sleep(isSetup ? 2500 : 1200);

    const st = await vpnStatus();
    if (!st.installed) throw new Error('装完了，但在 ' + dir + ' 里没找到 QuChenVPN.exe（Release 里的包结构可能变了）。');
    vpnProgress = { phase: 'done', done: size, total: asset.size ?? size, message: '安装完成' };
    return { ...st, progress: vpnProgress };
  } catch (e) {
    vpnProgress = { ...vpnProgress, phase: 'error', message: e.message };
    throw e;
  }
}

/** Install from a zip/exe the person already has (the network may not reach GitHub). */
export async function vpnInstallFromFile(bytes, name) {
  const dir = vpnHome();
  mkdirSync(dir, { recursive: true });
  const safe = String(name || 'QuChenVPN.zip').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
  const file = join(tmpdir(), safe);
  writeFileSync(file, bytes);
  try {
    if (await vpnRunning()) await vpnStop();
    if (/\.zip$/i.test(safe)) {
      await vpnUnpack(file, dir);
    } else if (/\.exe$/i.test(safe)) {
      vpnProgress = { ...vpnProgress, phase: 'installing', message: '正在安装…' };
      await vpnRunSetup(file, dir);
      await sleep(1200);
    } else {
      throw new Error('只支持 .zip 或 .exe。');
    }
  } finally {
    try { rmSync(file, { force: true }); } catch { /* stays */ }
  }
  const st = await vpnStatus();
  if (!st.installed) throw new Error('装完了，但没找到 QuChenVPN.exe。');
  vpnProgress = { ...vpnProgress, phase: 'done', message: '安装完成' };
  return { ...st, progress: vpnProgress };
}

export async function vpnStart() {
  const st = await vpnStatus();
  if (!st.exe) throw new Error('先安装 QuChen VPN。');
  if (st.running) return st;
  // cwd is the exe's own folder: it loads web/, assets/ and runtime/ from there, wherever it lives.
  spawn(st.exe, [], { cwd: dirname(st.exe), detached: true, stdio: 'ignore' }).unref();
  await sleep(900);
  return vpnStatus();
}

export async function vpnStop() {
  if (!(await vpnRunning())) return vpnStatus();
  // Ask it to close first: its own shutdown puts the system proxy back. Killing it outright would
  // leave the proxy pointing at a kernel that is gone, and the whole machine would lose its network.
  await new Promise((resolve) => execFile('taskkill.exe', ['/IM', 'QuChenVPN.exe', '/T'], { windowsHide: true }, () => resolve(null)));
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    if (!(await vpnRunning())) return vpnStatus();
  }
  await new Promise((resolve) => execFile('taskkill.exe', ['/IM', 'QuChenVPN.exe', '/T', '/F'], { windowsHide: true }, () => resolve(null)));
  await sleep(600);
  const st = await vpnStatus();
  if (st.running) {
    // An elevated copy cannot be closed by this per-user process. Installing over it would fail halfway and take the
    // proxy down with it, so stop here and say what to do.
    throw new Error('QuChen VPN 还在运行（可能是以管理员身份启动的）。请先退出它（或在任务管理器结束 QuChenVPN.exe），再重试。');
  }
  return { ...st, progress: { phase: 'idle', done: 0, total: 0, message: '已结束。' } };
}

/* ---------------------------------------------------------------- writing --- */

function localName(id) {
  return id.replace(/^qwen(\d[\d.]*)-/, 'Qwen$1 ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim() + ' (QuChen 本地)';
}

// pi-ai only shows a thinking-level picker for entries that declare `reasoningEfforts`, so the synced
// gateway models had none and the level could not be chosen. The empty `off:` is deliberate: it offers "off"
// without a spelling to send to the upstream. `'all'` declares it on every lane: behind the gateway the
// choice still reaches an upstream that takes it, and the gateway drops the field for the ones that do not.
const REASONING_LANE = /reasoning|think|deepseek|nemotron-nano|o3|o4|\br1\b|qwen|glm|kimi|llama|mistral|gpt|claude|gemini/i;

function modelLines(ids, indent, nameFor, { reasoning = false } = {}) {
  return ids.slice(0, MAX_MODELS).flatMap((id) => {
    const lines = [
      indent + '- id: ' + id,
      indent + '  name: ' + nameFor(id),
      indent + '  contextWindow: ' + CONTEXT,
      indent + '  maxTokens: ' + MAX_TOKENS,
    ];
    if (reasoning === 'all' || (reasoning && REASONING_LANE.test(id))) {
      lines.push(
        indent + '  reasoningEfforts:',
        indent + '    off:',
        indent + '    low: low',
        indent + '    medium: medium',
        indent + '    high: high',
      );
    }
    return lines;
  });
}

const HARNESS_BLOCK = (baseUrl, localIds, gatewayIds) => {
  const lines = ['- id: llm-pi-ai', '  name: "@deepseek-ai/dsh-llm-pi-ai"', '  config:', '    providers:'];
  if (localIds.length && baseUrl) {
    lines.push(
      '      quchen:',
      '        displayName: QuChen (本地大模型)',
      '        api: openai-completions',
      '        baseURL: ' + baseUrl,
      '        apiKeyEnv: QUCHEN_API_KEY',
      '        models:',
      ...modelLines(localIds, '          ', localName),
    );
  }
  if (gatewayIds.length) {
    lines.push(
      '      gateway:',
      '        displayName: 免费网关 (LiteLLM)',
      '        api: openai-completions',
      '        baseURL: http://127.0.0.1:' + GATEWAY_PORT + '/v1',
      '        apiKeyEnv: QUCHEN_GATEWAY_KEY',
      // Every lane behind this base URL is reached over the OpenAI protocol, and the reasoning dial is the
      // DeepSeek-style one: an upstream that does not take it drops the field (drop_params in the gateway).
      '        compat:',
      '          thinkingFormat: deepseek',
      '        models:',
      ...modelLines(gatewayIds, '          ', (id) => id + ' (免费网关)', { reasoning: 'all' }),
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
  // The key is stable in practice but not guaranteed: a reinstall writes a new master key, and this used to
  // keep the stale one, so every synced gateway model answered 401 and looked broken.
  const line = new RegExp('^(\\s+)' + name + ':\\s*(.*)$', 'm');
  const found = line.exec(text);
  if (found) {
    if (found[2].trim() === value) return text;
    text = text.replace(line, (_, ind) => ind + name + ': ' + value);
  } else if (/^refs:\s*$/m.test(text)) text = text.replace(/^refs:\s*$/m, 'refs:\n  ' + name + ': ' + value);
  else text = text.replace(/^version:\s*\d+\s*$/m, (m) => m + '\nrefs:\n  ' + name + ': ' + value);
  writeFileSync(file, text, 'utf8');
  return text;
}

export async function harnessStatus() {
  const running = runningInstance();
  const base = await apiBase(running);
  const gateway = await gatewayStatus();
  if (gateway.running) await ensureGatewayConnection().catch(() => null);
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

/**
 * The gateway models worth writing into the harness profile: the lanes that answer right now come first, a
 * lane that just answered 429/5xx is kept but pushed to the back. Listing seven out-of-quota lanes first is
 * exactly why every synced model looked broken — the person tries them in order and all of them fail.
 */
async function usableGatewayModels(gateway) {
  const models = Array.isArray(gateway.models) ? gateway.models : [];
  if (!models.length) return [];
  let health = null;
  const base = 'http://127.0.0.1:' + GATEWAY_PORT + '/v1';
  try {
    // The watcher rewrites the profile often: reuse the last probe unless there is none at all.
    health = await checkGatewayHealth({ baseUrl: base, key: gatewayKey(), models, force: false });
    if (!health?.results?.length) health = await checkGatewayHealth({ baseUrl: base, key: gatewayKey(), models, force: true });
  } catch { /* unprobed: keep the order the gateway reports */ }
  const results = Array.isArray(health?.results) ? health.results : [];
  if (!results.length) return models;
  const okOrder = new Map(results.filter((r) => r.ok).map((r) => r.model).map((id, i) => [id, i]));
  const failing = new Set(results.filter((r) => !r.ok && (r.status === 429 || r.status >= 500 || r.status === 0)).map((r) => r.model));
  const rank = (id) => (okOrder.has(id) ? 0 : failing.has(id) ? 2 : 1);
  return [...models].sort((a, b) => (rank(a) - rank(b)) || ((okOrder.get(a) ?? 0) - (okOrder.get(b) ?? 0)));
}

/** Write the profile from the live state. Used by the button and by the keep-in-sync watcher. */
async function writeProfile({ withGateway = true } = {}) {
  const running = runningInstance();
  const gateway = await gatewayStatus();
  const gatewayModels = withGateway ? await usableGatewayModels(gateway) : [];
  // No local model is fine: the gateway models alone are worth writing (the harness can use them).
  let base = { baseUrl: null, via: 'none' };
  let localModels = [];
  if (running) {
    base = await apiBase(running);
    if (base.baseUrl) localModels = await listModels(base.baseUrl, running.key);
    if (!localModels.length && running.model) localModels.push(running.model);
  }
  if (!localModels.length && !gatewayModels.length) {
    throw new Error('没有可写入的模型：先在「模型」里加载一个本地的，或者启动免费网关。');
  }
  mkdirSync(dshProfile(), { recursive: true });
  const before = existsSync(harnessConfig()) ? readFileSync(harnessConfig(), 'utf8') : '';
  writeFileSync(harnessConfig(), writeHarnessProfile(before, HARNESS_BLOCK(base.baseUrl, localModels, gatewayModels)), 'utf8');
  if (localModels.length) ensureCredentialRef('QUCHEN_API_KEY', 'local');
  if (gatewayModels.length) ensureCredentialRef('QUCHEN_GATEWAY_KEY', gatewayKey());
  if (gatewayModels.length) await ensureGatewayConnection().catch(() => null);
  writeSettings({ lastSync: new Date().toISOString(), lastModel: running ? running.model : null, lastBase: base.baseUrl });
  return { baseUrl: base.baseUrl, via: base.via, localModels, gatewayModels, running: running ?? null };
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
