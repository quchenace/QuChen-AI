import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createMockModelApi } from './mock-model-api.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('OpenAI clients can list and use configured provider models', { timeout: 45000 }, async t => {
  const mock = await createMockModelApi();
  const home = await mkdtemp(join(tmpdir(), 'quchen-provider-openai-'));
  await mkdir(join(home, 'data'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const host = spawn(process.execPath, ['server/index.mjs'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, QUCHEN_HOME: home, QUCHEN_MODELS_DIR: join(home, 'models'), QUCHEN_REAL_ENGINE: '0', QUCHEN_PORT: String(port), QUCHEN_BIND: '127.0.0.1' },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (host.exitCode === null) {
      const ended = new Promise(resolve => host.once('exit', resolve));
      host.kill('SIGTERM');
      await ended;
    }
    await mock.close();
    await rm(home, { recursive: true, force: true });
  });
  const call = async (path, body) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  let up = false;
  for (let i = 0; i < 300 && !up; i++) {
    try { up = (await call('/api/health')).status === 200; } catch { /* starting */ }
    if (!up) await delay(50);
  }
  assert.ok(up, 'test host started');
  const saved = await call('/api/model-providers', {
    kind: 'custom', name: 'Radio test provider', baseUrl: mock.baseUrl,
    protocol: 'openai-chat', apiKey: 'test-key',
    models: [{ id: 'mock-chat', name: 'Gateway test model', reasoning: true }],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const listed = await call('/v1/models');
  assert.equal(listed.status, 200);
  const external = listed.body.data.find(model => model.owned_by === 'quchen-api' && model.meta?.modelId === 'mock-chat');
  assert.ok(external, JSON.stringify(listed.body));
  assert.equal(external.meta.connection, 'Radio test provider');
  assert.equal(JSON.stringify(listed.body).includes('test-key'), false);

  const completed = await call('/v1/chat/completions', {
    model: external.id, messages: [{ role: 'user', content: 'Hello from Radio' }],
    reasoning_effort: 'high', stream: false,
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.match(completed.body.choices[0].message.content, /Hello ✓ from the test API/);
  assert.equal(completed.body.model, external.id);
  const upstream = mock.requests.find(request => request.path === '/v1/chat/completions');
  assert.equal(upstream.body.model, 'mock-chat');
  assert.equal(upstream.body.reasoning_effort, 'high');
  assert.equal(upstream.headers.authorization, 'Bearer test-key');

  const streamed = await fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: external.id, messages: [{ role: 'user', content: 'Stream for Radio' }], stream: true }),
  });
  assert.equal(streamed.status, 200);
  const text = await streamed.text();
  assert.match(text, /Hello ✓ from the test API/);
  assert.match(text, /data: \[DONE\]/);
  assert.equal((await call('/v1/responses', { model: external.id, input: 'hello' })).status, 501);
});
