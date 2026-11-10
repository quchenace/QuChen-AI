/**
 * The network tool's install: which release asset QuChen picks. The installer package is the default
 * (one silent run, it owns its uninstall entry); the portable zip is only the fallback for a release
 * that predates the installer. Getting this backwards used to mean installing the zip and then
 * discovering no Setup.exe was ever used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { vpnAssetFor } from '../server/integrations.mjs';

const asset = (name) => ({ name, browser_download_url: 'https://example.invalid/' + name, size: 31_380_350 });

test('a release with both shapes installs the installer', () => {
  const picked = vpnAssetFor([asset('QuChenVPN-win64.zip'), asset('QuChenVPN-Setup.exe')]);
  assert.equal(picked.kind, '安装包');
  assert.equal(picked.asset.name, 'QuChenVPN-Setup.exe');
});

test('the order in the release does not matter', () => {
  const picked = vpnAssetFor([asset('QuChenVPN-Setup.exe'), asset('QuChenVPN-win64.zip')]);
  assert.equal(picked.asset.name, 'QuChenVPN-Setup.exe');
});

test('a release with only the zip still installs, as the fallback', () => {
  const picked = vpnAssetFor([asset('QuChenVPN-win64.zip')]);
  assert.equal(picked.kind, '便携包');
  assert.equal(picked.asset.name, 'QuChenVPN-win64.zip');
});

test('the name match ignores case, and a non-setup exe is not mistaken for one', () => {
  assert.equal(vpnAssetFor([asset('QUCHENVPN-SETUP.EXE')]).asset.name, 'QUCHENVPN-SETUP.EXE');
  assert.equal(vpnAssetFor([asset('QuChenVPN-portable.exe')]), null, 'only a Setup.exe is an installer');
});

test('nothing usable in the release is reported, not thrown at a half-downloaded file', () => {
  assert.equal(vpnAssetFor([]), null);
  assert.equal(vpnAssetFor(undefined), null);
  assert.equal(vpnAssetFor([{ name: 'QuChenVPN-Setup.exe' }]), null, 'an asset without a URL is not installable');
  assert.equal(vpnAssetFor([null, { name: '', browser_download_url: 'x' }]), null);
});
