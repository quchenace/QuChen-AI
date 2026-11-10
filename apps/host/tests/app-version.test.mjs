import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appVersionFrom } from '../server/app-version.mjs';

const here = fileURLToPath(new URL('../server', import.meta.url));

test('the shell passes the version; a bad value is ignored', () => {
  assert.equal(appVersionFrom({ env: { QUCHEN_APP_VERSION: '0.2.0-beta' }, here: '/nowhere/a/b' }), '0.2.0-beta');
  assert.equal(appVersionFrom({ env: { QUCHEN_APP_VERSION: ' 1.2.3 ' }, here: '/nowhere/a/b' }), '1.2.3');
  assert.equal(appVersionFrom({ env: { QUCHEN_APP_VERSION: 'latest' }, here: '/nowhere/a/b' }), 'dev');
  assert.equal(appVersionFrom({ env: {}, here: '/nowhere/a/b' }), 'dev');
});

test('every place that carries the app version carries the same one', async () => {
  const desktop = join(here, '..', '..', 'desktop');
  const cargo = /^version\s*=\s*"([^"]+)"/m.exec(await readFile(join(desktop, 'src-tauri', 'Cargo.toml'), 'utf8'))[1];
  const desktopPkg = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8')).version;
  const hostPkg = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8')).version;
  const lock = await readFile(join(desktop, 'src-tauri', 'Cargo.lock'), 'utf8');
  // Cargo.lock pins the crate's own version too: it is the one file nobody remembers to bump, so it is
  // the one this test exists for (it read 0.2.11 through three releases).
  const locked = /\[\[package\]\]\nname = "quchen-desktop"\nversion = "([^"]+)"/.exec(lock)?.[1];
  assert.equal(cargo, desktopPkg, 'Cargo.toml and the desktop package');
  assert.equal(hostPkg, desktopPkg, 'the host reports the version the installer was built with');
  assert.equal(locked, desktopPkg, 'Cargo.lock agrees, so the release does not ship two versions');
});

test('in a checkout the same file the shell is built from is read, so there is one source', async () => {
  const toml = await readFile(join(here, '..', '..', 'desktop', 'src-tauri', 'Cargo.toml'), 'utf8');
  const declared = /^version\s*=\s*"([^"]+)"/m.exec(toml)[1];
  assert.equal(appVersionFrom({ env: {}, here }), declared);
  assert.notEqual(declared, '0.1.0', 'the app version is the product version, not the 0.1.0 placeholder');
  const dir = await mkdtemp(join(tmpdir(), 'quchen-appver-'));
  try {
    await mkdir(join(dir, 'host', 'server'), { recursive: true });
    await mkdir(join(dir, 'desktop', 'src-tauri'), { recursive: true });
    await writeFile(join(dir, 'desktop', 'src-tauri', 'Cargo.toml'), '[package]\nname = "x"\nversion = "9.8.7-rc.1"\n');
    assert.equal(appVersionFrom({ env: {}, here: join(dir, 'host', 'server') }), '9.8.7-rc.1');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
