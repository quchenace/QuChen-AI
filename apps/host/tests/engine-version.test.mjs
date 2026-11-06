import test from 'node:test';
import assert from 'node:assert/strict';
import { shownEngineVersion } from '../src/lib/engine-version.ts';

test('About never shows the host placeholder engine version while the real one is still being read', () => {
  assert.equal(shownEngineVersion({ available: false }, 'quchen-engine 0.1.0'), undefined);
  assert.equal(shownEngineVersion(null, 'quchen-engine 0.1.0'), undefined);
  assert.equal(shownEngineVersion({ available: true, installed: { engine: { version: '0.1.48' } } }, 'quchen-engine 0.1.0'), '0.1.48');
  assert.equal(shownEngineVersion({ available: true, installed: { engine: null } }, 'quchen-engine 0.1.0'), undefined);
  assert.equal(shownEngineVersion({ available: false }, 'quchen-engine 0.1.51'), 'quchen-engine 0.1.51');
});
