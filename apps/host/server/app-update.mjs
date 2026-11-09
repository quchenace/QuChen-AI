/**
 * Installing an app update from inside the app: read the published manifest, download the installer,
 * check its SHA-256, then run it silently. The installer replaces the program files and QuChen starts
 * again; the model folder and the engine components are left alone.
 */
import { createWriteStream, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';

const MANIFEST = 'https://github.com/quchenace/QuChen-AI/releases/latest/download/latest.json';

function downloadWithProxy(url, destination) {
  return new Promise((resolve, reject) => {
    const script = "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '" + url.replace(/'/g, "''") + "' -OutFile '" + destination.replace(/'/g, "''") + "' -TimeoutSec 1800";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true }, (error, _out, err) => {
      if (error) reject(new Error(String(err || error.message).split(/\r?\n/).filter(Boolean).slice(-1)[0] || 'download failed'));
      else resolve(destination);
    });
  });
}

export async function installAppUpdate() {
  const doc = await (await fetch(MANIFEST, { signal: AbortSignal.timeout(20000) })).json();
  const entry = doc?.platforms?.['windows-x86_64'];
  if (!entry?.url) throw new Error('The release feed has no Windows installer.');
  const version = doc.version ?? 'new version';
  const dir = join(tmpdir(), 'quchen-update');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, entry.url.split('/').pop() || 'QuChen-setup.exe');
  try { rmSync(file, { force: true }); } catch { /* none */ }

  // Through the system proxy, so a running VPN makes the download work where a plain fetch cannot.
  try {
    await downloadWithProxy(entry.url, file);
  } catch (e) {
    throw new Error('安装包下载失败：这台电脑连不上 github.com（' + (e && e.message ? e.message : 'network') + '）。先打开 QuChen VPN 再试，或用离线安装包。');
  }
  const got = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (entry.sha256 && got !== String(entry.sha256).toLowerCase()) {
    throw new Error('The installer did not match the published checksum.');
  }
  // /S = silent, /NS = do not show the finish page; the installer restarts QuChen when it is done.
  const child = spawn(file, ['/S', '/NS'], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  setTimeout(() => { try { process.exit(0); } catch { } }, 1500);
  return { ok: true, version, file };
}
