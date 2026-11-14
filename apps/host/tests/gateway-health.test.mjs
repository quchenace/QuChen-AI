import test from 'node:test';
import assert from 'node:assert/strict';
import { checkGatewayHealth, resetGatewayHealth } from '../server/gateway-health.mjs';

test('the health check probes the aliases and free lanes, and recommends the working one', async () => {
  const seen = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.model);
    if (body.model === 'pollinations-fast') return new Response('nope', { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const models = ['deepseek-v4.1-flash', 'pollinations-fast', 'ofm/our-free-model/opencode/flint-free', 'openrouter/some-model'];
  const out = await checkGatewayHealth({ baseUrl: 'http://127.0.0.1:4000/v1', key: 'k', models, force: true, fetcher });
  assert.deepEqual(seen.sort(), ['deepseek-v4.1-flash', 'ofm/our-free-model/opencode/flint-free', 'openrouter/some-model', 'pollinations-fast'].sort());
  assert.equal(out.ready, 3);
  assert.equal(out.total, 4);
  assert.equal(out.best[0].ok, true);
  assert.ok(out.best.length >= 1);
});

test('a gateway without an address reports it instead of guessing', async () => {
  resetGatewayHealth();
  const out = await checkGatewayHealth({ force: true, fetcher: async () => { throw new Error('must not be called'); } });
  assert.equal(out.ready, 0);
  assert.match(out.error, /not configured/);
});
