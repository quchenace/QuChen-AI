/**
 * The free gateway's config is generated, not pasted: the built-in endpoints always, plus the
 * dsh-our-free-model catalogue for the keys that are actually in .env. What is pinned here is the
 * shape of that output and the rules that keep it from writing a deployment that can only fail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGatewayConfig, describeGatewayConfig, enabledProviders, freeModelCatalogue, parseEnv } from '../server/gateway-config.mjs';

const deployments = (text) => [...text.matchAll(/^ {2}- model_name: "([^"]+)"$/gm)].map((m) => m[1]);

test('the plugin catalogue is a pinned snapshot with the fields the generator needs', () => {
  const doc = freeModelCatalogue();
  assert.ok(doc.providers.length >= 60, 'the catalogue keeps every provider');
  assert.match(doc.source.package, /dsh-our-free-model/);
  assert.ok(doc.source.version, 'the snapshot records the version it came from');
  assert.match(doc.source.registrySha256, /^[0-9a-f]{64}$/);
  for (const p of doc.providers) {
    assert.ok(p.id && p.name, 'every provider has an id and a name');
    assert.ok(Array.isArray(p.models), p.id + ' lists models');
    for (const m of p.models) assert.ok(m.id, p.id + ' model has an id');
    if (p.auth?.kind === 'apiKey') assert.match(p.auth.env, /^[A-Z0-9_]+$/, p.id + ' names its key');
  }
});

test('a .env line is read the way the gateway reads it', () => {
  const env = parseEnv('# comment\nLITELLM_MASTER_KEY=Quchennb1\n\nOPENROUTER_KEY_1="sk-or-1"\nGEMINI_API_KEY = g-2 \nbroken\n');
  assert.deepEqual(env, { LITELLM_MASTER_KEY: 'Quchennb1', OPENROUTER_KEY_1: 'sk-or-1', GEMINI_API_KEY: 'g-2' });
});

test('no key at all still serves the keyless endpoint and every group name QuChen asks for', () => {
  const built = buildGatewayConfig({ LITELLM_MASTER_KEY: 'Quchennb1' });
  const names = deployments(built.text);
  assert.ok(names.includes('pollinations-fast'), 'Pollinations needs no key');
  for (const group of ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-think', 'fast', 'zero']) {
    assert.ok(names.includes(group), 'group survives without keys: ' + group);
  }
  assert.ok(!names.includes('nemotron-3-ultra'), 'an OpenRouter model without its key is left out, not written to 401');
  assert.ok(!names.some((n) => n.includes('/')), 'no plugin model without a key');
  assert.match(built.text, /没有 key 的 provider 不会写进这张表/);
});

test('the OpenRouter key turns the built-in set on, and each group fans out to its members', () => {
  const built = buildGatewayConfig({ OPENROUTER_KEY_1: 'sk-or-1' });
  const names = deployments(built.text);
  assert.equal(new Set(names).size, 13, 'six built-in upstreams, pollinations, four groups, the catalogue route and its group');
  assert.equal(names.filter((n) => n === 'deepseek-v4.1-flash').length, 3);
  assert.equal(names.filter((n) => n === 'deepseek-v4.1-flash-think').length, 3);
  assert.equal(names.filter((n) => n === 'fast').length, 2);
  assert.equal(names.filter((n) => n === 'zero').length, 1);
  assert.ok(names.includes('open_router/openrouter/free'), 'the catalogue route for the same account');
});

test('either name for the OpenRouter key turns on both sections, and the key is spelled as it is set', () => {
  const one = buildGatewayConfig({ OPENROUTER_KEY_1: 'k' });
  const two = buildGatewayConfig({ OPENROUTER_API_KEY: 'k' });
  assert.deepEqual(one.models, two.models, 'one key, one place: both sections appear either way');
  assert.match(one.text, /api_key: "os\.environ\/OPENROUTER_KEY_1"/);
  assert.match(two.text, /api_key: "os\.environ\/OPENROUTER_API_KEY"/);
  assert.ok(one.text.includes('nemotron-3-ultra') && two.text.includes('nemotron-3-ultra'));
  assert.ok(one.text.includes('open_router/') && two.text.includes('open_router/'));
});

test('a provider appears exactly when its key is in .env, under its own id', () => {
  const env = { OPENROUTER_KEY_1: 'x', GEMINI_API_KEY: 'g', NVIDIA_NIM_API_KEY: 'n' };
  const built = buildGatewayConfig(env);
  assert.deepEqual(built.providers.sort(), ['gemini', 'nvidia_nim', 'open_router']);
  assert.ok(built.models.includes('gemini/gemini-2.5-pro') || built.models.some((m) => m.startsWith('gemini/')));
  assert.ok(built.models.some((m) => m.startsWith('nvidia_nim/')));
  assert.ok(!built.models.some((m) => m.startsWith('groq/')), 'a provider with no key stays out');

  const withGroq = buildGatewayConfig({ ...env, GROQ_API_KEY: 'q' });
  assert.ok(withGroq.models.some((m) => m.startsWith('groq/')), 'adding the key is all it takes');
});

test('a provider a static key cannot work for is never written, with or without keys', () => {
  const built = buildGatewayConfig({}, { includeAll: true });
  for (const id of ['github_copilot', 'openai']) {
    assert.ok(!built.providers.includes(id), id + ' is an oauth provider');
  }
  for (const id of ['azure_openai', 'bedrock', 'vertex', 'cloudflare', 'anthropic']) {
    assert.ok(!built.providers.includes(id), id + ' needs more than a base URL and a key');
  }
  assert.ok(!/api_base: "[^"]*\{/.test(built.text), 'no base URL with an account id left to fill in');
});

test('includeAll writes the catalogue without keys, for a person who fills them in later', () => {
  const off = buildGatewayConfig({});
  const all = buildGatewayConfig({}, { includeAll: true });
  assert.ok(all.providers.length > off.providers.length);
  assert.ok(all.providers.length >= 50);
  assert.ok(all.models.length > 300);
  // Same shape either way: every deployment has a model, a base and a key.
  const blocks = all.text.split(/^ {2}- model_name:/m).slice(1);
  for (const block of blocks) {
    assert.match(block, /^ ".*"\n {4}litellm_params:\n {6}model: "openai\/.*"\n {6}api_base: "https?:\/\/.*"\n {6}api_key: ".*"\n/);
  }
});

test('YAML scalars are quoted, so an id with ":" or "@" cannot change the document', () => {
  const built = buildGatewayConfig({ OPENROUTER_KEY_1: 'x' });
  assert.match(built.text, /model: "openai\/nvidia\/nemotron-3-ultra-550b-a55b:free"/);
  const all = buildGatewayConfig({}, { includeAll: true });
  assert.ok(!/^\s*model_name: [^"]/m.test(all.text), 'every model_name is quoted');
  assert.ok(!/^\s*api_base: [^"]/m.test(all.text), 'every api_base is quoted');
});

test('the same .env produces the same file, and the file says where it came from', () => {
  const a = buildGatewayConfig({ OPENROUTER_KEY_1: 'x' });
  const b = buildGatewayConfig({ OPENROUTER_KEY_1: 'x' });
  assert.equal(a.text, b.text, 'generation is deterministic');
  assert.match(a.text, /由 apps\/host\/server\/gateway-config\.mjs 生成/);
  assert.match(a.text, /上游目录：@ebony-vinyl\/dsh-our-free-model 2\.\d+\.\d+/);
  assert.ok(a.text.endsWith('\n') && !a.text.endsWith('\n\n'));
});

test('the panel can say how much of the catalogue is live', () => {
  const info = describeGatewayConfig({});
  assert.equal(info.providers, 0);
  assert.equal(info.catalogueProviders, freeModelCatalogue().providers.length);
  assert.ok(info.keys > 30, 'the catalogue names the keys it understands');
  const more = describeGatewayConfig({ GEMINI_API_KEY: 'g' });
  assert.equal(more.providers, 1);
  assert.ok(more.skipped < info.skipped);
});

test('a local engine is never written: QuChen serves its own, and the catalogue cannot name its models', () => {
  const built = buildGatewayConfig({}, { includeAll: true });
  for (const id of ['ollama', 'lmstudio', 'llamacpp']) {
    assert.ok(!built.providers.includes(id), id + ' is a local engine');
  }
  assert.ok(!enabledProviders({ OLLAMA_API_KEY: 'x' }).some((p) => p.provider.id === 'ollama'));
});
