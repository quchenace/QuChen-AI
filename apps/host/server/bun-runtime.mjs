/**
 * The Bun runtime the OpenCode free lane needs.
 *
 * `dsh-our-free-model` sends its free-lane inference through a real Bun process: the upstream checks the
 * client fingerprint on POST, so Node's fetch cannot stand in for it. Without Bun the lane answers only
 * this, and every model behind it is unusable:
 *
 *   OpenCode 免费车道推理需要本机 Bun：请安装 Bun（https://bun.sh 或 npm i -g bun）后重试，或把 Bun
 *   可执行文件路径写入 OUR_FREE_MODEL_BUN 环境变量。
 *
 * A person who installed QuChen should not have to read that. So QuChen finds a Bun if the machine has one,
 * otherwise fetches the official binary from the npm mirror (checksum from the same directory, 55 MB), and
 * hands the path to the Harness through `OUR_FREE_MODEL_BUN` + `BUN_INSTALL` — the two names the plugin
 * looks at. Nothing here runs Bun for its own sake: the lane is the only consumer.
 *
 * Overridable seams (`fetchImpl`, `expand`, `probe`) exist so the test can drive the whole flow with a
 * four-byte "zip" and no network.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, createReadStream, existsSync, linkSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/** Mirror first: npmjs-hosted binaries are the part of bun.sh a network in CN usually cannot reach. */
export const BUN_MIRROR = 'https://registry.npmmirror.com/-/binary/bun/';
/** Used when the directory listing cannot be read at all, so a first run still has a chance offline-ish. */
export const BUN_FALLBACK_VERSION = 'bun-v1.4.4';
export const BUN_HOME_DIRS = ['QuChen', 'tools', 'bun'];

const EXE = process.platform === 'win32' ? 'bun.exe' : 'bun';

/** The user's home as this process sees it (`env` first, so a test can point it somewhere private). */
function homeDir(env) {
  return env.USERPROFILE || env.HOME || homedir();
}

/**
 * Where QuChen keeps the Bun it downloaded: its own folder, next to the gateway and the VPN, in the
 * `bin/<exe>` layout the plugin's `BUN_INSTALL` lookup expects.
 */
export function bunHome(env = process.env) {
  return join(env.LOCALAPPDATA || join(homeDir(env), 'AppData', 'Local'), ...BUN_HOME_DIRS);
}

/** The executable path inside `bunHome`. */
export function bunTarget(env = process.env) {
  return join(bunHome(env), 'bin', EXE);
}

/**
 * The plugin's own lookup order, with QuChen's folder added in the middle. A native executable only:
 * a shell shim named bun.cmd is skipped, because the plugin refuses to run one.
 */
export function bunCandidates(env = process.env) {
  const list = [
    env.OUR_FREE_MODEL_BUN,
    env.BUN_INSTALL && join(env.BUN_INSTALL, 'bin', EXE),
    join(homeDir(env), '.bun', 'bin', EXE),
    bunTarget(env),
    ...(env.PATH || env.Path || '').split(delimiter).filter(Boolean).map((p) => join(p.replace(/^"|"$/g, ''), EXE)),
    env.APPDATA && join(env.APPDATA, 'npm', 'node_modules', 'bun', 'bin', EXE),
  ];
  return [...new Set(list.filter(Boolean))];
}

/** A file the OS will let us execute, never a directory and never a `.cmd` shim on Windows. */
export function usableBun(path) {
  if (!path) return false;
  try {
    const full = resolve(path);
    if (process.platform === 'win32' && !full.toLowerCase().endsWith('.exe')) return false;
    if (!statSync(full).isFile()) return false;
    return true;
  } catch { return false; }
}

/**
 * The Bun this machine already has (any source), or null.
 *
 * `verify` runs `bun --version` on the hit: a truncated or half-copied executable is a file too, and
 * handing its path to the Harness would keep the lane broken while looking fixed. Off by default so a
 * cheap existence check stays cheap.
 */
export function findBun(env = process.env, { verify = false, run = defaultRun } = {}) {
  for (const candidate of bunCandidates(env)) {
    if (!usableBun(candidate)) continue;
    const full = resolve(candidate);
    if (verify && !bunVersion(full, { run })) continue;
    return full;
  }
  return null;
}

/**
 * What the Harness needs to see. `OUR_FREE_MODEL_BUN` is the plugin's explicit override; `BUN_INSTALL`
 * covers the older lookup so a second copy of the plugin finds it too. Empty when there is no Bun: the
 * lane then says its own sentence, which is still better than a path that does not exist.
 */
export function bunEnv(env = process.env) {
  const bun = findBun(env, { verify: true });
  if (!bun) return {};
  return { OUR_FREE_MODEL_BUN: bun, BUN_INSTALL: dirname(dirname(bun)) };
}

/**
 * Make the Bun QuChen found visible to processes it does not start — above all a DSH the person opens
 * themselves. The plugin reads OUR_FREE_MODEL_BUN from its own process environment, so a value only in
 * QuChen's environment is invisible there. Written to HKCU\Environment (User scope): new processes see
 * it, nothing needs administrator, and a person can remove it like any other user variable.
 */
export function persistBunEnv(bun, env = process.env) {
  if (!usableBun(bun)) return false;
  const full = resolve(bun);
  const install = dirname(dirname(full));
  if (String(env.OUR_FREE_MODEL_BUN ?? '') === full && String(env.BUN_INSTALL ?? '') === install) return true;
  // reg.exe, not [Environment]::SetEnvironmentVariable: the latter broadcasts WM_SETTINGCHANGE and can
  // block for a long time when a window does not pump its messages. A process started later still reads
  // HKCU\Environment, and the plugin finds ~/.bun/bin/bun.exe by itself as well.
  const reg = (name, value) => spawnSync('reg.exe', ['add', 'HKCU\\Environment', '/v', name, '/t', 'REG_SZ', '/d', value, '/f'],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  try {
    reg('OUR_FREE_MODEL_BUN', full);
    reg('BUN_INSTALL', install);
    const check = spawnSync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'OUR_FREE_MODEL_BUN'],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (!String(check.stdout ?? '').toLowerCase().includes(full.toLowerCase())) return false;
    env.OUR_FREE_MODEL_BUN = full;
    env.BUN_INSTALL = install;
    return true;
  } catch {
    return false;
  }
}

/**
 * The plugin looks for `~/.bun/bin/bun.exe` on its own, before any environment variable. When QuChen's Bun
 * lives in its own folder (a fresh download), a hard link there makes the lane work for a DSH started from
 * Explorer, whose environment block predates our registry write. Same volume: instant; another volume: a copy.
 */
export function publishBunToHome(bun, env = process.env) {
  if (!usableBun(bun)) return false;
  const full = resolve(bun);
  const target = join(homeDir(env), '.bun', 'bin', EXE);
  if (resolve(target) === full) return true;
  try {
    if (existsSync(target)) return usableBun(target);          // never replace a Bun the person installed
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { force: true });
    try {
      linkSync(full, target);                                   // hard link: no second 115 MB on disk
    } catch {
      copyFileSync(full, target);                               // another volume
    }
    return usableBun(target);
  } catch {
    return false;
  }
}

/**
 * Ensure a Bun exists and publish its path to the user environment. The app calls this once in the
 * background when the dsh-our-free-model plugin is installed, and the Bun card calls it on demand.
 */
export async function ensureBunShared(opts = {}) {
  const got = await ensureBun(opts);
  const env = opts.env ?? process.env;
  const atHome = publishBunToHome(got.path, env);
  const shared = persistBunEnv(got.path, env);
  return { ...got, shared, atHome };
}

const versionCache = new Map();

/** `bun --version`, cached per path: the answer cannot change without the file changing. */
export function bunVersion(path, { run = defaultRun } = {}) {
  if (!path) return null;
  if (versionCache.has(path)) return versionCache.get(path);
  const out = run(path, ['--version']);
  const version = /\d+\.\d+\.\d+/.exec(String(out ?? ''))?.[0] ?? null;
  versionCache.set(path, version);
  return version;
}

function defaultRun(file, args) {
  try {
    const r = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return r.status === 0 ? String(r.stdout ?? '').trim() : null;
  } catch { return null; }
}

/** One line for the panel: where Bun is, which version, and whether QuChen put it there. */
export function bunStatus(env = process.env, { run = defaultRun } = {}) {
  const path = findBun(env, { verify: true, run });
  const mine = path ? resolve(path) === resolve(bunTarget(env)) : false;
  const shared = path ? String(env.OUR_FREE_MODEL_BUN ?? '') === resolve(path) : false;
  return { found: !!path, path, version: path ? bunVersion(path, { run }) : null, managed: mine, shared, home: bunHome(env) };
}

/** The release asset for this machine. Bun publishes one zip per os/arch; Windows x64 is the common case. */
export function bunAssetName({ platform = process.platform, arch = process.arch } = {}) {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux';
  const cpu = arch === 'arm64' ? 'aarch64' : 'x64';
  return `bun-${os}-${cpu}.zip`;
}

/** `SHASUMS256.txt` beside the asset -> { 'bun-windows-x64.zip': 'cd2c0f…' }. */
export function parseShasums(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m) out[m[2].trim()] = m[1].toLowerCase();
  }
  return out;
}

/** Newest stable release folder in the mirror listing (`bun-v1.4.4`), or the pinned fallback. */
export function latestBunVersion(listing) {
  const names = (Array.isArray(listing) ? listing : [])
    .filter((x) => x && x.type === 'dir' && /^bun-v\d+\.\d+\.\d+$/.test(String(x.name).replace(/\/$/, '')))
    .map((x) => String(x.name).replace(/\/$/, ''));
  if (!names.length) return BUN_FALLBACK_VERSION;
  const parts = (v) => v.slice(5).split('.').map(Number);
  names.sort((a, b) => {
    const x = parts(b), y = parts(a);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
  return names[0];
}

/** sha256 of a file, streamed: the zip is 55 MB and the extracted exe 115 MB. */
function sha256(file) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', fail);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => done(hash.digest('hex')));
  });
}

async function download(url, file, { fetchImpl = fetch, onProgress = null, timeoutMs = 900000 } = {}) {
  const res = await fetchImpl(url, { headers: { 'user-agent': 'quchen' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new Error('下载失败：HTTP ' + res.status);
  const total = Number(res.headers.get('content-length') || 0);
  rmSync(file, { force: true });
  let done = 0;
  for await (const chunk of res.body) {
    appendFileSync(file, Buffer.from(chunk));
    done += chunk.length;
    onProgress?.(done, total);
  }
  const size = existsSync(file) ? statSync(file).size : 0;
  if (!size) throw new Error('下载失败：没有拿到文件。');
  if (total && size < total) throw new Error('下载不完整（' + size + '/' + total + ' 字节）。');
  return size;
}

function expandZip(zip, dest) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath '" + zip.replace(/'/g, "''") + "' -DestinationPath '" + dest.replace(/'/g, "''") + "' -Force"],
  { windowsHide: true, encoding: 'utf8', timeout: 300000 });
  if (r.status !== 0) throw new Error('解压失败：' + String(r.stderr || r.stdout || '').split(/\r?\n/).filter(Boolean).slice(-1)[0]);
}

/** Find the executable inside an extracted bun zip (the archive keeps a `bun-<os>-<arch>/` folder). */
export function locateInTree(dir, depth = 0) {
  try {
    const items = readdirSync(dir, { withFileTypes: true });
    const hit = items.find((x) => x.isFile() && x.name.toLowerCase() === EXE.toLowerCase());
    if (hit) return join(dir, hit.name);
    if (depth >= 2) return null;
    for (const x of items) {
      if (!x.isDirectory()) continue;
      const sub = locateInTree(join(dir, x.name), depth + 1);
      if (sub) return sub;
    }
  } catch { /* next */ }
  return null;
}

/**
 * Make sure this machine has a Bun, downloading one into QuChen's own folder when it has none.
 * Returns { found, path, version, installed, already } — `installed` says this call did the download.
 */
export async function ensureBun({ env = process.env, onProgress = null, fetchImpl = fetch, expand = expandZip, probe = defaultRun, force = false } = {}) {
  const existing = force ? null : findBun(env, { verify: true, run: probe });
  if (existing) return { found: true, path: existing, version: bunVersion(existing, { run: probe }), installed: false, already: true };

  const home = bunHome(env);
  mkdirSync(home, { recursive: true });
  const work = join(tmpdir(), 'quchen-bun-' + Date.now());
  mkdirSync(work, { recursive: true });
  try {
    let version = BUN_FALLBACK_VERSION;
    try {
      const res = await fetchImpl(BUN_MIRROR, { headers: { 'user-agent': 'quchen' }, signal: AbortSignal.timeout(20000) });
      if (res.ok) version = latestBunVersion(await res.json());
    } catch { /* the pinned fallback still resolves */ }

    const asset = bunAssetName();
    const dir = BUN_MIRROR + version + '/';
    const zip = join(work, asset);
    await download(dir + asset, zip, { fetchImpl, onProgress });

    // The mirror publishes SHASUMS256.txt in the same folder: a 55 MB executable from a third party is
    // checked before it is allowed to run.
    let want = null;
    try {
      const res = await fetchImpl(dir + 'SHASUMS256.txt', { headers: { 'user-agent': 'quchen' }, signal: AbortSignal.timeout(20000) });
      if (res.ok) want = parseShasums(await res.text())[asset] ?? null;
    } catch { /* a missing checksum file is not a missing download */ }
    if (want && (await sha256(zip)) !== want) throw new Error('Bun 安装包校验失败（SHA-256 不符），已中止。');

    expand(zip, work);
    const found = locateInTree(work);
    if (!found) throw new Error('Bun 安装包里没有找到 ' + EXE + '。');
    const target = bunTarget(env);
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { force: true });
    try {
      renameSync(found, target);                       // same volume: instant
    } catch {
      try { copyFileSync(found, target); }             // temp on another drive
      catch { rmSync(target, { force: true }); throw new Error('无法把 Bun 放到 ' + home + '。'); }
    }

    const got = bunVersion(target, { run: probe });
    if (!got) { rmSync(target, { force: true }); throw new Error('Bun 装好了但无法运行，已删除。'); }
    return { found: true, path: target, version: got, installed: true, already: false, home };
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* stays */ }
  }
}
