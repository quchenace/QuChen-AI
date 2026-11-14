/**
 * The plugin gateway as a QuChen gateway upstream: its lanes are re-exposed as ofm/<id>, and the plugin's
 * own `gateway/*` rows (which point back at QuChen) are filtered out so the two gateways cannot loop.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ofmGatewayKey, ofmModels } from '../server/ofm-gateway.mjs';
import { buildGatewayConfig } from '../server/gateway-config.mjs';

function withHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'quchen-ofm-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the plugin key is read from its own credential file, never invented', () => {
  withHome((home) => {
    const env = { DSH_HOME: home };
    assert.equal(ofmGatewayKey(env), null, 'no file, no key');
    mkdirSync(join(home, 'openai-gateway'), { recursive: true });
    writeFileSync(join(home, 'openai-gateway', 'api-key'), '  sk-test  \n');
    assert.equal(ofmGatewayKey(env), 'sk-test');
    assert.equal(ofmGatewayKey({ ...env, DSH_OPENAI_GATEWAY_API_KEY: 'env-key' }), 'env-key', 'explicit env wins');
  });
});

test('models are listed, ofm/gateway rows are dropped and duplicates collapse', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, auth: opts.headers.authorization });
    return new Response(JSON.stringify({
      object: 'list',
      data: [
        { id: 'opencode/zen-free', name: 'OpenCode Zen' },
        { id: 'gateway/nemotron-3-ultra', name: 'loop back into QuChen' },
        { id: 'opencode/zen-free', name: 'duplicate' },
        { id: 'deepseek-account/deepseek-flash', name: 'DeepSeek' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  withHome(async (home) => {
    const env = { DSH_HOME: home, DSH_OPENAI_GATEWAY_API_KEY: 'k' };
    const got = await ofmModels({ env, fetchImpl, force: true, timeoutMs: 1000 });
    assert.equal(got.running, true);
    assert.deepEqual(got.models.map((m) => m.id), ['opencode/zen-free', 'deepseek-account/deepseek-flash']);
    assert.equal(seen[0].url, 'http://127.0.0.1:8326/v1/models');
    assert.equal(seen[0].auth, 'Bearer k');
  });
});

test('the generated config points ofm/<id> at the plugin gateway with the env key', () => {
  const built = buildGatewayConfig({ LITELLM_MASTER_KEY: 'x' }, {
    ofm: { port: 8326, models: [{ id: 'opencode/zen-free', name: 'OpenCode' }] },
  });
  assert.match(built.text, /model_name: "ofm\/opencode\/zen-free"/);
  assert.match(built.text, /api_base: "http:\/\/127\.0\.0\.1:8326\/v1"/);
  assert.match(built.text, /api_key: "os\.environ\/OFM_GATEWAY_KEY"/);
  assert.equal(built.ofmModels, 1);
  assert.ok(built.models.includes('ofm/opencode/zen-free'));
  // A plugin lane that just hit its quota has to fall back like any other row; without this line LiteLLM
  // answered "No fallback was attempted" for every ofm/… model.
  assert.match(built.text, /- "ofm\/opencode\/zen-free": \["pollinations-fast"\]/);
});
