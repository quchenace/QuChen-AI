/**
 * Installing an app update from inside the app: read the published release, download the installer,
 * check its SHA-256, then run it silently. The installer replaces the program files and QuChen starts
 * again; the model folder and the engine components are left alone.
 *
 * The download reports where it is: `appUpdateProgress()` is what the update screen polls, so a click
 * that starts a 100 MB download shows bytes, percent and phase instead of looking like nothing happened.
 */
import { createWriteStream, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';

// github.com/releases/download is unreachable on many networks while api.github.com answers: the release
// list comes from the API and the bytes come from the asset endpoint, which redirects to the CDN that does
// serve the file. That difference is why the old "download" click appeared to do nothing at all.
const RELEASES = 'https://api.github.com/repos/quchenace/QuChen-AI/releases?per_page=30';
const ASSET = 'https://api.github.com/repos/quchenace/QuChen-AI/releases/assets/';
const UA = { 'user-agent': 'quchen' };

/** phase: idle | manifest | downloading | verifying | installing | done | error */
let progress = { phase: 'idle', done: 0, total: 0, message: '', version: '' };

export function appUpdateProgress() {
  return progress;
}

function say(phase, patch = {}) {
  progress = { ...progress, phase, ...patch };
}

/** Through the system proxy, for a machine where only that reaches github.com. No progress to report. */
function downloadWithProxy(url, destination) {
  return new Promise((resolve, reject) => {
    const script = "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '" + url.replace(/'/g, "''") + "' -OutFile '" + destination.replace(/'/g, "''") + "' -TimeoutSec 1800";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true }, (error, _out, err) => {
      if (error) reject(new Error(String(err || error.message).split(/\r?\n/).filter(Boolean).slice(-1)[0] || 'download failed'));
      else resolve(destination);
    });
  });
}

function mb(n) {
  return (n / 1048576).toFixed(1) + ' MB';
}

function clock(secs) {
  if (secs < 60) return Math.round(secs) + ' 秒';
  return Math.floor(secs / 60) + ' 分 ' + Math.round(secs % 60) + ' 秒';
}

/** Streamed, so the screen can show how far along it is — and how fast, so a slow line is visible. */
async function downloadStreamed(url, destination, headers = {}) {
  const res = await fetch(url, { redirect: 'follow', headers: { ...UA, ...headers }, signal: AbortSignal.timeout(1800000) });
  if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
  const total = Number(res.headers.get('content-length') || 0);
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    const out = createWriteStream(destination);
    out.on('error', reject);
    out.on('finish', resolve);
    (async () => {
      try {
        for await (const chunk of res.body) {
          const buf = Buffer.from(chunk);
          const done = progress.done + buf.length;
          const secs = (Date.now() - t0) / 1000;
          let message = '正在下载安装包';
          if (secs > 1.5) {
            // Speed and remaining time on the line the page already shows: a stalled download then looks
            // stalled instead of looking frozen.
            const perSec = done / secs;
            const left = total > 0 ? Math.max(0, (total - done) / perSec) : 0;
            message = '正在下载安装包 · ' + mb(perSec) + '/s' + (left ? ' · 还剩 ' + clock(left) : '');
          }
          progress = { ...progress, done, message };
          if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
        }
        out.end();
      } catch (e) {
        out.destroy();
        reject(e);
      }
    })();
  });
}

/** The newest published release and its Windows installer, read from the API the version check uses. */
export async function pickRelease() {
  const res = await fetch(RELEASES, { headers: { accept: 'application/vnd.github+json', ...UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error('版本列表格式不对');
  const stable = list.find((r) => r && !r.draft && !r.prerelease && /^v?\d+\.\d+\.\d+/.test(String(r.tag_name ?? '')));
  if (!stable) throw new Error('发布列表里还没有正式版');
  const assets = Array.isArray(stable.assets) ? stable.assets : [];
  const asset = assets.find((a) => /setup\.exe$/i.test(String(a?.name ?? '')));
  if (!asset) throw new Error('这个版本的发布里没有 Windows 安装包（setup.exe）');
  return { asset, version: String(stable.tag_name).replace(/^v/, '') };
}

/** Where the install script writes what it did: readable after the app has restarted. */
export function updateLog() {
  const base = process.env.LOCALAPPDATA || tmpdir();
  const dir = join(base, 'QuChen', 'logs');
  try { mkdirSync(dir, { recursive: true }); } catch { /* the log then fails and the exit code still counts */ }
  return join(dir, 'app-update.log');
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/**
 * The script that finishes the update: close QuChen, run the silent installer against the folder it is
 * already installed in, then open it again. Written as a file and run detached, because the host cannot
 * replace the program files it is running from.
 */
export function runnerScript(setup, log, version) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'function W($m) { Add-Content -LiteralPath ' + psQuote(log) + ' -Value ((Get-Date).ToString("s") + " " + $m) }',
    'W "--- update to ' + version + ' ---"',
    "for ($i = 0; $i -lt 45; $i++) { if (-not (Get-Process -Name 'QuChen' -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Seconds 1 }",
    "Get-Process -Name 'QuChen' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
    'Start-Sleep -Seconds 2',
    "$roots = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
    "$item = Get-ItemProperty $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'QuChen' } | Select-Object -First 1",
    '$dir = $item.InstallLocation',
    "if ($dir) { $dir = $dir.Trim('\"') }",
    'W ("install dir: " + $dir)',
    "$setupArgs = @('/S', '/NS')",
    // /D wins over the installer's default folder and has to come last; Inno-style quoting breaks it.
    "if ($dir -and ($dir -notmatch ' ')) { $setupArgs += ('/D=' + $dir) }",
    '$proc = Start-Process -FilePath ' + psQuote(setup) + ' -ArgumentList $setupArgs -PassThru -Wait',
    'W ("installer exit " + $proc.ExitCode)',
    'if ($proc.ExitCode -eq 0) {',
    '  Start-Sleep -Seconds 2',
    "  $exe = if ($dir) { Join-Path $dir 'QuChen.exe' } else { '' }",
    "  if ($exe -and (Test-Path -LiteralPath $exe)) { Start-Process -FilePath $exe; W 'relaunched' } else { W 'app exe not found, relaunch skipped' }",
    '} else {',
    '  W ("install failed: exit " + $proc.ExitCode)',
    '}',
    'W "--- end ---"',
  ].join('\r\n') + '\r\n';
}

export async function installAppUpdate() {
  say('manifest', { done: 0, total: 0, message: '正在读取版本信息' });
  let release;
  try {
    release = await pickRelease();
  } catch (e) {
    say('error', { message: '读不到版本信息：' + (e?.message ?? 'network') });
    throw new Error('读不到版本信息：这台电脑连不上 GitHub（' + (e?.message ?? 'network') + '）。先打开 QuChen VPN 再试，或用离线安装包。');
  }
  const { asset, version } = release;
  const entry = {
    url: asset.browser_download_url || ASSET + asset.id,
    name: asset.name,
    size: Number(asset.size ?? 0),
    // GitHub records the hash of every asset it stores: the bytes have to match it exactly.
    sha256: String(asset.digest ?? '').replace(/^sha256:/i, '').toLowerCase(),
  };
  const dir = join(tmpdir(), 'quchen-update');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, String(entry.name || 'QuChen-setup.exe').replace(/[^\w.\-]/g, '_'));
  try { rmSync(file, { force: true }); } catch { /* none */ }

  // The bytes have to arrive over whichever door this network leaves open: the asset API (which redirects to
  // the CDN), the plain release link, then the system proxy. The first is what works where github.com itself
  // is blocked but api.github.com is not.
  const routes = [];
  if (asset.id) routes.push({ url: ASSET + asset.id, headers: { accept: 'application/octet-stream' }, label: 'GitHub API' });
  if (asset.browser_download_url) routes.push({ url: asset.browser_download_url, headers: {}, label: 'GitHub' });
  const failures = [];
  let fetched = false;
  for (const route of routes) {
    try { rmSync(file, { force: true }); } catch { /* none */ }
    say('downloading', { done: 0, total: entry.size, message: '正在下载 ' + version + '（' + route.label + '）', version });
    try {
      await downloadStreamed(route.url, file, route.headers);
      fetched = true;
      break;
    } catch (e) {
      failures.push(route.label + '：' + (e?.message ?? 'network'));
    }
  }
  if (!fetched) {
    try {
      say('downloading', { done: 0, total: entry.size, message: '直连失败，改用系统代理…', version });
      await downloadWithProxy(entry.url, file);
      fetched = true;
    } catch (e) {
      failures.push('系统代理：' + (e?.message ?? 'network'));
    }
  }
  if (!fetched) {
    say('error', { message: '安装包下载失败：' + failures.join('；') });
    throw new Error('安装包下载失败（' + failures.join('；') + '）。先打开 QuChen VPN 再试，或用离线安装包。');
  }
  const bytes = (() => { try { return readFileSync(file).length; } catch { return progress.done; } })();
  if (entry.size && bytes < entry.size * 0.98) {
    say('error', { message: '安装包不完整（' + Math.round(bytes / 1048576) + '/' + Math.round(entry.size / 1048576) + ' MB）' });
    throw new Error('安装包没有下完（' + Math.round(bytes / 1048576) + ' MB / ' + Math.round(entry.size / 1048576) + ' MB），已中止。请重试。');
  }

  if (entry.sha256) {
    say('verifying', { done: bytes, total: bytes, message: '正在核对安装包', version });
    const got = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (got !== entry.sha256) {
      say('error', { message: '安装包校验失败' });
      throw new Error('安装包和发布记录对不上（SHA-256 不符），已中止。请重试。');
    }
  }
  // A separate short-lived script owns the install: the installer cannot replace files QuChen still has open,
  // so the app is closed first, the setup runs silently into the same folder, and QuChen is opened again.
  say('installing', { done: bytes, total: bytes, message: '正在安装，QuChen 会先关闭再自动打开', version });
  const log = updateLog();
  const scriptFile = join(dir, 'run-update.ps1');
  writeFileSync(scriptFile, runnerScript(file, log, version), 'utf8');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptFile], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  say('done', { message: '安装程序已启动，装完会自动打开新版（过程写在 ' + log + '）', version });
  setTimeout(() => { try { process.exit(0); } catch { /* already gone */ } }, 1500);
  return { ok: true, version, file, log };
}
