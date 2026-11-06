/** The start-up "inference" line: an installed engine with no model loaded is not "No QuChen engine" (rx9070 AppImage, second start). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { inferenceLine } from '../server/inference.mjs';

const none = { kind: 'unavailable', name: 'No QuChen engine' };

test('a restart with the engine installed and no model loaded says so', () => {
  const line = inferenceLine({ backend: none, engine: { usable: true, engine: { version: '0.1.45.3' } } });
  assert.equal(line, 'QuChen engine 0.1.45.3 is installed; no model is loaded yet');
});

test('no usable engine keeps the plain reason', () => {
  assert.equal(inferenceLine({ backend: none, engine: { usable: false, notice: 'This QuChen is for AMD cards.' } }), 'No QuChen engine for this PC. This QuChen is for AMD cards.');
  assert.equal(inferenceLine({ backend: none, engine: null }), 'No QuChen engine');
});

test('a running worker and the unpacking message are unchanged', () => {
  assert.equal(inferenceLine({ backend: { kind: 'quchen', name: 'QuChen engine' }, engine: null }), 'QuChen engine');
  assert.match(inferenceLine({ backend: none, settled: false }), /^unpacking/);
});
