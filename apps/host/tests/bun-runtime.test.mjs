/**
 * The Bun QuChen prepares for the OpenCode free lane.
 *
 * What is pinned here: the asset name per platform, the checksum parse, the version choice, the lookup
 * order the plugin also uses — and that a download lands where the plugin will find it, is checked against
 * SHASUMS256.txt, and refuses to install when that check fails. `ensureBun` is driven through its seams
 * (fake fetch, fake unzip, fake `--version`), so none of this reaches the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUN_FALLBACK_VERSION, bunAssetName, bunCandidates, bunEnv, bunHome, bunStatus, bunTarget, bunVersion,
  ensureBun, findBun, latestBunVersion, locateInTree, parseShasums, usableBun,
} from '../server/bun-runtime.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'quchen-bun-test-'));

/**
 * An env that sees only this test's folder: no real `~/.bun`, no real PATH. Without it, a machine that
 * already has Bun (this one does) would answer for the test.
 */
const isolated = (dir) => ({ LOCALAPPDATA: join(dir, 'Local'), USERPROFILE: join(dir, 'Home'), HOME: join(dir, 'Home'), PATH: '', Path: '' });

test('the asset name follows the machine, and Windows is the case that matters here', () => {
  assert.equal(bunAssetName({ platform: 'win32', arch: 'x64' }), 'bun-windows-x64.zip');
  assert.equal(bunAssetName({ platform: 'win32', arch: 'arm64' }), 'bun-windows-aarch64.zip');
  assert.equal(bunAssetName({ platform: 'darwin', arch: 'arm64' }), 'bun-darwin-aarch64.zip');
  assert.equal(bunAssetName({ platform: 'linux', arch: 'x64' }), 'bun-linux-x64.zip');
});

test('SHASUMS256.txt is read the way the mirror writes it', () => {
  const text = [
    'b7ffa8af18bba66fa0bb3e14384bc77bb71310ae6d90617bc653dcd105345a60  bun-windows-x64-baseline-profile.zip',
    'cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5 *bun-windows-x64.zip',
    '',
    'not a checksum line',
  ].join('\n');
  const map = parseShasums(text);
  assert.equal(map['bun-windows-x64.zip'], 'cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5');
  assert.equal(map['bun-windows-x64-baseline-profile.zip'].length, 64);
  assert.equal(Object.keys(map).length, 2, 'only real lines are kept');
  assert.deepEqual(parseShasums(''), {});
  assert.deepEqual(parseShasums(undefined), {});
});

test('the newest stable folder wins, canaries are skipped, and an unreadable listing still resolves', () => {
  const listing = [
    { type: 'dir', name: 'bun-v1.4.2/' }, { type: 'dir', name: 'bun-v1.4.10/' },
    { type: 'dir', name: 'bun-v1.9.0-canary.1/' }, { type: 'dir', name: 'bun-v1.3.9/' },
    { type: 'file', name: 'index.json' },
  ];
  assert.equal(latestBunVersion(listing), 'bun-v1.4.10', 'numeric compare, not string compare');
  assert.equal(latestBunVersion([]), BUN_FALLBACK_VERSION);
  assert.equal(latestBunVersion(null), BUN_FALLBACK_VERSION);
});

test('the lookup order is the plugin\'s, with QuChen\'s own folder among the candidates', () => {
  const env = { LOCALAPPDATA: 'C:\\L', USERPROFILE: 'C:\\U', APPDATA: 'C:\\A', PATH: 'C:\\p1;C:\\p2', OUR_FREE_MODEL_BUN: 'C:\\mine\\bun.exe', BUN_INSTALL: 'C:\\buninst' };
  const list = bunCandidates(env);
  assert.equal(list[0], 'C:\\mine\\bun.exe', 'an explicit path is answered first');
  assert.equal(list[1], join('C:\\buninst', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun'), 'BUN_INSTALL layering');
  assert.ok(list.includes(bunTarget(env)), 'QuChen\'s own folder, in the bin/ layout BUN_INSTALL implies');
  assert.ok(list.includes(join('C:\\U', '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun')), 'and the user install');
  assert.equal(new Set(list).size, list.length, 'no duplicate candidates');
});

test('only a real file counts, and on Windows it has to be an .exe', () => {
  const dir = scratch();
  try {
    const exe = join(dir, 'bun.exe');
    writeFileSync(exe, 'MZ');
    assert.equal(usableBun(exe), true);
    assert.equal(usableBun(dir), false, 'a directory is not an executable');
    assert.equal(usableBun(join(dir, 'missing.exe')), false);
    if (process.platform === 'win32') {
      const shim = join(dir, 'bun.cmd');
      writeFileSync(shim, '@echo off');
      assert.equal(usableBun(shim), false, 'the plugin refuses a shell shim');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a Bun found on this machine is what the Harness is told about', () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, 'bin'), { recursive: true });
    const standard = join(dir, 'bin', 'bun.exe');
    writeFileSync(standard, 'MZ');
    const env = { OUR_FREE_MODEL_BUN: standard, ...isolated(dir) };
    assert.equal(findBun(env), standard);
    // `bunEnv` verifies with a real `bun --version`, which this four-byte file cannot answer: the machine
    // gets no variables rather than a path that would keep the lane broken.
    assert.deepEqual(bunEnv(env), {}, 'a Bun that will not run is not handed to the Harness');
    assert.deepEqual(bunEnv(isolated(dir)), {}, 'no Bun, no variables');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bun --version is read once per path and a broken Bun reports nothing', () => {
  const dir = scratch();
  try {
    const exe = join(dir, 'bun.exe');
    writeFileSync(exe, 'MZ');
    let calls = 0;
    const run = () => { calls++; return '1.4.4\n'; };
    assert.equal(bunVersion(exe, { run }), '1.4.4');
    assert.equal(bunVersion(exe, { run }), '1.4.4');
    assert.equal(calls, 1, 'the answer is cached: it cannot change without the file changing');
    assert.equal(bunVersion(join(dir, 'other.exe'), { run: () => null }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the panel line says whether QuChen put the Bun there', () => {
  const dir = scratch();
  try {
    const env = isolated(dir);
    mkdirSync(bunHome(env), { recursive: true });
    mkdirSync(join(bunHome(env), 'bin'));
    writeFileSync(bunTarget(env), 'MZ');
    const mine = bunStatus(env, { run: () => '1.4.4' });
    assert.equal(mine.found, true);
    assert.equal(mine.managed, true, 'it lives in QuChen\'s own folder');
    assert.equal(mine.version, '1.4.4');
    assert.equal(bunStatus(isolated(join(dir, 'nope'))).found, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the executable is found inside the archive\'s own folder', () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, 'bun-windows-x64'));
    writeFileSync(join(dir, 'bun-windows-x64', 'bun.exe'), 'MZ');
    const found = locateInTree(dir);
    assert.equal(found, join(dir, 'bun-windows-x64', 'bun.exe'));
    assert.equal(locateInTree(join(dir, 'nothing')), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------------------------------------------------------- the whole flow --- */

/** A Response stand-in: JSON for the listing, text for the checksums, a byte stream for the zip. */
function fakeFetch({ shasums, bytes = Buffer.from('PK\u0003\u0004 fake zip'), status = 200 } = {}) {
  return async (url) => {
    if (url.endsWith('/')) {
      return { ok: status === 200, status, json: async () => [{ type: 'dir', name: 'bun-v1.4.4/' }], text: async () => '', headers: new Map() };
    }
    if (url.endsWith('SHASUMS256.txt')) {
      return { ok: status === 200, status, text: async () => shasums ?? '', json: async () => ({}), headers: new Map() };
    }
    const chunks = [bytes];
    return {
      ok: status === 200, status,
      headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(bytes.length) : null) },
      body: { async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } },
    };
  };
}

/** Stand-in for Expand-Archive: make the folder shape the real zip has. */
const fakeExpand = (zip, work) => {
  mkdirSync(join(work, 'bun-windows-x64'), { recursive: true });
  writeFileSync(join(work, 'bun-windows-x64', 'bun.exe'), 'MZ' + readFileSync(zip, 'utf8'));
};

test('with no Bun anywhere, one is downloaded, checked and put where the plugin looks', async () => {
  const dir = scratch();
  try {
    const env = isolated(dir);
    const bytes = Buffer.from('PK\u0003\u0004 payload');
    const { createHash } = await import('node:crypto');
    const sum = createHash('sha256').update(bytes).digest('hex');
    const result = await ensureBun({
      env,
      fetchImpl: fakeFetch({ shasums: `${sum}  ${bunAssetName()}\n`, bytes }),
      expand: fakeExpand,
      probe: () => '1.4.4',
    });
    assert.equal(result.found, true);
    assert.equal(result.installed, true);
    assert.equal(result.already, false);
    assert.equal(result.version, '1.4.4');
    assert.equal(result.path, bunTarget(env));
    assert.equal(readFileSync(result.path, 'utf8'), 'MZPK\u0003\u0004 payload', 'the extracted executable, not the zip');
    assert.equal(findBun(env), result.path, 'and the plugin\'s own lookup now finds it');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a checksum that does not match stops the install instead of running the file', async () => {
  const dir = scratch();
  try {
    await assert.rejects(
      () => ensureBun({
        env: isolated(dir),
        fetchImpl: fakeFetch({ shasums: `${'0'.repeat(64)}  ${bunAssetName()}\n` }),
        expand: fakeExpand,
        probe: () => '1.4.4',
      }),
      /SHA-256/,
    );
    assert.equal(findBun(isolated(dir)), null, 'nothing was installed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a Bun that will not run is thrown away rather than reported as ready', async () => {
  const dir = scratch();
  try {
    await assert.rejects(
      () => ensureBun({
        env: isolated(dir),
        fetchImpl: fakeFetch({ shasums: null }),
        expand: fakeExpand,
        probe: () => null,          // `bun --version` said nothing
      }),
      /无法运行/,
    );
    assert.equal(findBun(isolated(dir)), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an existing Bun is left alone: no download for a machine that already has one', async () => {
  const dir = scratch();
  try {
    const env = isolated(dir);
    mkdirSync(join(bunTarget(env), '..'), { recursive: true });
    mkdirSync(join(bunHome(env), 'bin'), { recursive: true });
    writeFileSync(bunTarget(env), 'MZ');
    let fetched = 0;
    const result = await ensureBun({
      env,
      fetchImpl: async () => { fetched++; throw new Error('no network needed'); },
      probe: () => '1.4.4',
    });
    assert.equal(result.already, true);
    assert.equal(result.installed, false);
    assert.equal(fetched, 0);
    // `force` is the "重新准备" button: it goes to the network even when one is there.
    await assert.rejects(() => ensureBun({ env, force: true, fetchImpl: async () => { fetched++; throw new Error('offline'); } }));
    assert.ok(fetched > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
