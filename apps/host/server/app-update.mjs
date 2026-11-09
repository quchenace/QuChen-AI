/**
 * Installing an app update from inside the app: read the published manifest, download the installer,
 * check its SHA-256, then run it silently. The installer replaces the program files and QuChen starts
 * again; the model folder and the engine components are left alone.
 */
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MANIFEST = 'https://github.com/quchenace/QuChen-AI/releases/latest/download/latest.json';

export async function installAppUpdate() {
  const doc = await (await fetch(MANIFEST, { signal: AbortSignal.timeout(20000) })).json();
  const entry = doc?.platforms?.['windows-x86_64'];
  if (!entry?.url) throw new Error('The release feed has no Windows installer.');
  const version = doc.version ?? 'new version';
  const dir = join(tmpdir(), 'quchen-update');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, entry.url.split('/').pop() || 'QuChen-setup.exe');
  try { rmSync(file, { force: true }); } catch { /* none */ }

  let res;
  try {
    res = await fetch(entry.url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
  } catch (e) {
    throw new Error('安装包下载失败：这台电脑连不上 github.com。先打开 QuChen VPN（网关页 → 网络工具）再试，或用离线安装包。');
  }
  if (!res.ok || !res.body) throw new Error('The installer could not be downloaded (' + res.status + ').');
  const hash = createHash('sha256');
  const sink = createWriteStream(file);
  await pipeline(Readable.fromWeb(res.body), async function* (source) {
    for await (const chunk of source) { hash.update(chunk); yield chunk; }
  }, sink);

  const got = hash.digest('hex');
  if (entry.sha256 && got !== String(entry.sha256).toLowerCase()) {
    throw new Error('The installer did not match the published checksum.');
  }
  // /S = silent, /NS = do not show the finish page; the installer restarts QuChen when it is done.
  const child = spawn(file, ['/S', '/NS'], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  setTimeout(() => { try { process.exit(0); } catch { } }, 1500);
  return { ok: true, version, file };
}
