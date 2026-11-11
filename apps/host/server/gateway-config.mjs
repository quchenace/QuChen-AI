/**
 * The free gateway's LiteLLM config, built from two sources:
 *
 *   1. the small built-in set QuChen always ships (OpenRouter free models plus Pollinations, which needs
 *      no key at all) - the group names QuChen's own model picker asks for;
 *   2. the provider catalogue of the `dsh-our-free-model` plugin (free-models.json, a snapshot taken from
 *      npm and pinned with a sha256), turned into LiteLLM deployments.
 *
 * Only providers whose key is actually in `.env` are written: a deployment with an unset key fails at
 * request time with a 401 that reads like a broken gateway, so the file follows the keys the person has
 * rather than the catalogue's full length. `includeAll` (QUCHEN_GATEWAY_ALL=1) writes everything, for a
 * person who will fill keys in later.
 *
 * Plain text out, on purpose: no YAML library in the host, and the result is pinned by a test.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Lanes that only the plugin can drive, so LiteLLM must not pretend to.
 *
 * `opencode_zen`'s free models moved to `https://opencode.ai/inference/...`; the old `/zen/v1` chat path
 * they are catalogued under answers `403 FreeTierError` for every one of them. The `/inference` routes are
 * not a plain OpenAI endpoint either: the free tier refuses a body that carries another client's tool
 * vocabulary, wants the official CLI prompt, a minted session id, a per-request project id, and a Bun
 * client fingerprint on POST. That shaping lives in the plugin (src/o2a). A `model:` line here would only
 * produce requests that are refused, so these models stay reachable through the plugin's own lane — which
 * QuChen now gives a Bun (bun-runtime.mjs) instead of copying the wire.
 */
const LANE_PROVIDERS = new Set(['opencode_zen']);

/** Shapes an OpenAI-compatible base URL + key cannot express: left out by design. */
const SKIP_PROVIDERS = new Set(['azure_openai', 'bedrock', 'vertex', 'vertex-partner', 'cloudflare', 'anthropic', 'glm', 'minimax-cn']);
/**
 * Local engines: QuChen serves its own engine already, and the catalogue cannot name their models (the
 * app lists them at runtime), so a static deployment for one would be empty.
 */
const LOCAL_PROVIDERS = new Set(['llamacpp', 'lmstudio', 'ollama']);

const HEADER = [
  '# ============================================================',
  '#  QuChen 免费网关配置（内置）',
  '#  端点： http://127.0.0.1:4000/v1',
  '#  鉴权： Authorization: Bearer <LITELLM_MASTER_KEY>',
  '#',
  '#  这张表由 apps/host/server/gateway-config.mjs 生成，手改会在下次安装/启动时被覆盖。',
  '#  两层模型名：',
  '#    · 每个上游一个名字（nemotron-3-ultra、cohere-north、flint …）—— 这样模型列表里能看到全部',
  '#    · 别名组（deepseek-v4.1-flash / -think / fast / zero / free）—— 组内自动挑可用的',
  '#  Pollinations 完全免 key；OpenRouter 与插件目录里的 provider 需要 .env 里对应的 key，',
  '#  没有 key 的 provider 不会写进这张表（写进去只会在用的时候报 401）。',
  '# ============================================================',
];

/** yaml scalar: always quoted, so ids with ":", "@", "#" or "/" cannot change the shape. */
function q(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** .env -> a plain object. Same rules the gateway's own .env reader uses. */
export function parseEnv(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Same object, written back as .env lines (comments and order are not promised). */
export function envText(env) {
  return Object.entries(env).map(([k, v]) => k + '=' + v).join('\n') + '\n';
}

let cached = null;
/** The pinned plugin catalogue (free-models.json). A missing file is not fatal: the built-in set works. */
export function freeModelCatalogue() {
  if (cached) return cached;
  try {
    cached = JSON.parse(readFileSync(new URL('./free-models.json', import.meta.url), 'utf8'));
  } catch {
    cached = { source: { package: 'dsh-our-free-model', version: 'unknown' }, providers: [] };
  }
  return cached;
}

let installedCache;
/**
 * The catalogue of the plugin actually installed for DSH, when there is one. The snapshot in
 * free-models.json is pinned for review; this reads the live registry so a plugin update adds its new
 * providers and models without waiting for a QuChen release. Returns null when no plugin is installed.
 */
export function installedCatalogue(env = process.env) {
  if (installedCache !== undefined) return installedCache;
  const homes = [String(env.DSH_HOME || '').trim(), join(env.USERPROFILE || homedir(), '.dsh')].filter(Boolean);
  const names = ['@ebony-vinyl/dsh-our-free-model', 'dsh-our-free-model'];
  const profiles = ['desktop', 'default', 'main'];
  for (const home of homes) {
    for (const profile of profiles) {
      for (const name of names) {
        const file = join(home, 'profiles', profile, 'node_modules', name, 'src', 'providers', 'registry.json');
        if (!existsSync(file)) continue;
        try {
          const raw = readFileSync(file);
          const providers = JSON.parse(raw.toString('utf8'));
          if (!Array.isArray(providers) || !providers.length) continue;
          installedCache = {
            source: { package: '@ebony-vinyl/dsh-our-free-model', version: 'installed', registrySha256: createHash('sha256').update(raw).digest('hex') },
            providers,
          };
          return installedCache;
        } catch { /* next profile */ }
      }
    }
  }
  installedCache = null;
  return null;
}

/** What the gateway serves with no key at all, plus the OpenRouter free ids the app's groups name. */
const BUILT_IN = [
  { name: 'nemotron-3-ultra', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', base: 'https://openrouter.ai/api/v1', key: 'os.environ/OPENROUTER_KEY_1', needs: 'OPENROUTER_KEY_1', note: 'OpenRouter · Nemotron-3 Ultra 550B' },
  { name: 'cohere-north', model: 'cohere/north-mini-code:free', base: 'https://openrouter.ai/api/v1', key: 'os.environ/OPENROUTER_KEY_1', needs: 'OPENROUTER_KEY_1', note: 'OpenRouter · Cohere North Mini Code' },
  { name: 'nemotron-3-5-super-vl', model: 'nvidia/nemotron-3.5-super-vl:free', base: 'https://openrouter.ai/api/v1', key: 'os.environ/OPENROUTER_KEY_1', needs: 'OPENROUTER_KEY_1', note: 'OpenRouter · Nemotron-3.5 Super VL' },
  { name: 'flint', model: 'recursive/flint-v1.0:free', base: 'https://openrouter.ai/api/v1', key: 'os.environ/OPENROUTER_KEY_1', needs: 'OPENROUTER_KEY_1', note: 'OpenRouter · Flint v1.0' },
  { name: 'nemotron-nano-reasoning', model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', base: 'https://openrouter.ai/api/v1', key: 'os.environ/OPENROUTER_KEY_1', needs: 'OPENROUTER_KEY_1', note: 'OpenRouter · Nemotron-3 Nano 推理' },
  { name: 'gemma-4-31b', model: 'google/gemma-4-31b-it:free', base: 'https://openrouter.ai/api/v1', key: 'os.environ/OPENROUTER_KEY_1', needs: 'OPENROUTER_KEY_1', note: 'OpenRouter · Gemma-4 31B（可能 429）' },
  { name: 'pollinations-fast', model: 'openai-fast', base: 'https://text.pollinations.ai/openai', key: 'dummy', needs: null, note: 'Pollinations · 免 key' },
];

/** The groups QuChen's chat asks for: the same four names as before, so an old profile keeps working. */
const GROUPS = {
  // The plain lane is what chat asks for by default, so it holds only upstreams that answer instead of
  // thinking: nemotron-3-ultra spent the whole token budget reasoning and returned an empty `content`,
  // which the app shows as a broken model.
  'deepseek-v4.1-flash': ['pollinations-fast', 'cohere-north', 'flint'],
  'deepseek-v4.1-flash-think': ['nemotron-nano-reasoning', 'nemotron-3-ultra', 'gemma-4-31b'],
  fast: ['pollinations-fast', 'cohere-north'],
  zero: ['pollinations-fast'],
};

/** Upstreams that think before they answer: the app offers a reasoning level for these and not for the rest. */
const REASONING = /(think|reasoning|qwq|-r1\b|nemotron-3-ultra|nemotron-3\.5-super-vl|deepseek-v4\.1-pro|glm-[45])/i;

function thinks(record) {
  if (record.reasoning !== undefined) return !!record.reasoning;
  return REASONING.test(record.name ?? '') || REASONING.test(record.model ?? '');
}

/** Whether a gateway model id thinks before it answers; the picker uses this to offer a reasoning level. */
export function gatewayThinks(id) {
  return REASONING.test(String(id ?? ''));
}

/**
 * The same account can be named twice by the two sources: QuChen's built-in block calls the OpenRouter
 * key `OPENROUTER_KEY_1` (shipped by the release), the plugin's own catalogue calls it
 * `OPENROUTER_API_KEY`. One key, one place: either name turns both sections on.
 */
const KEY_ALIASES = {
  OPENROUTER_API_KEY: ['OPENROUTER_API_KEY', 'OPENROUTER_KEY_1'],
  OPENROUTER_KEY_1: ['OPENROUTER_KEY_1', 'OPENROUTER_API_KEY'],
};

/** The name that is actually set in `.env`, or the first candidate when none is. */
function settledKey(name, env) {
  for (const candidate of KEY_ALIASES[name] ?? [name]) {
    if (String(env?.[candidate] ?? '').trim()) return candidate;
  }
  return (KEY_ALIASES[name] ?? [name])[0];
}

/**
 * Can this provider become a LiteLLM deployment with only a base URL and a key?
 * An `oauth` / `adc` provider cannot: it needs a token exchange or a cloud identity, so a static
 * `api_key` in this file would only ever answer 401.
 */
function writable(provider) {
  if (!provider?.id || !provider.baseUrl) return false;
  if (SKIP_PROVIDERS.has(provider.id) || LOCAL_PROVIDERS.has(provider.id) || LANE_PROVIDERS.has(provider.id)) return false;
  const kind = provider.auth?.kind;
  if (kind !== 'apiKey' && kind !== 'none') return false;
  if (provider.format !== 'openai-chat') return false;
  if (/\{/.test(provider.baseUrl)) return false;              // an account id is spelled into the URL
  if (!Array.isArray(provider.models) || !provider.models.length) return false;
  return true;
}

/**
 * The providers the config gets: a keyed one only when its key is present, a keyless one always.
 * `includeAll` keeps the keyed ones without a key too.
 */
export function enabledProviders(env, { includeAll = false } = {}) {
  const out = [];
  for (const p of freeModelCatalogue().providers ?? []) {
    if (!writable(p)) continue;
    const keyed = p.auth?.kind === 'apiKey' && !!p.auth?.env;
    const keyName = keyed ? settledKey(p.auth.env, env) : null;
    if (keyed && !includeAll && !String(env?.[keyName] ?? '').trim()) continue;
    out.push({ provider: p, keyed, keyName });
  }
  return out;
}

function block(record) {
  // `supports_reasoning` is what makes LiteLLM advertise the model as a reasoner: without it the app has
  // no cue and hides the reasoning level menu for every gateway model.
  const info = 'note: ' + q(record.note) + (thinks(record) ? ', supports_reasoning: true' : '');
  return [
    '  - model_name: ' + q(record.name),
    '    litellm_params:',
    '      model: ' + q('openai/' + record.model),
    '      api_base: ' + q(record.base),
    '      api_key: ' + q(record.key),
    '    model_info: { ' + info + ' }',
  ].join('\n');
}

/**
 * Build the whole config. `env` is the `.env` object that will sit beside it.
 * Returns { text, models, providers, skipped } so the caller can report what it wrote.
 */
export function buildGatewayConfig(env = {}, { includeAll = false, ofm = null, catalog = null } = {}) {
  const catalogue = catalog ?? freeModelCatalogue();
  const src = catalogue.source ?? {};
  const builtIn = BUILT_IN.filter((e) => !e.needs || String(env[settledKey(e.needs, env)] ?? '').trim())
    .map((e) => (e.needs ? { ...e, key: 'os.environ/' + settledKey(e.needs, env) } : e));
  const providers = enabledProviders(env, { includeAll });
  const laneSkipped = (catalogue.providers ?? []).filter((p) => LANE_PROVIDERS.has(p.id));
  const ofmModels = Array.isArray(ofm?.models) ? ofm.models : [];
  const ofmPort = Number(ofm?.port) || 8326;

  /** name -> record, so a group can repeat an upstream without restating it. */
  const by = new Map(builtIn.map((e) => [e.name, { ...e, group: null }]));
  const written = [];
  for (const { provider, keyName } of providers) {
    for (const m of provider.models) {
      const record = {
        name: provider.id + '/' + m.id,
        model: m.id,
        base: provider.baseUrl,
        key: keyName ? 'os.environ/' + keyName : 'dummy',
        note: (provider.name ?? provider.id) + ' · ' + (m.name ?? m.id),
        group: provider.category,
      };
      by.set(record.name, record);
      written.push(record);
    }
  }

  const lines = [...HEADER];
  lines.push(
    '#',
    '# 上游目录：' + (src.package ?? 'dsh-our-free-model') + ' ' + (src.version ?? '?')
      + '（' + (catalogue.providers?.length ?? 0) + ' 个 provider / '
      + (catalogue.providers ?? []).reduce((n, p) => n + (p.models?.length ?? 0), 0) + ' 个模型）',
    '# 本次写入：内置 ' + builtIn.length + ' 条 + 插件 ' + providers.length + ' 个 provider / ' + written.length + ' 个模型'
      + (ofmModels.length ? ' + 插件网关 ' + ofmModels.length + ' 个模型（ofm/…）' : ''),
    ...(laneSkipped.length
      ? ['# 目录内 ' + laneSkipped.length + ' 条（' + laneSkipped.map((p) => p.id).join('、') + '）不按 provider 直写：'
        + '它的 /zen/v1 对免费层 403、/inference 要官方客户端指纹。DSH 运行时由插件网关以 ofm/… 提供'
        + '（QuChen 也给它备了 Bun，见 bun-runtime.mjs）']
      : []),
    '',
    'model_list:',
  );
  for (const e of builtIn) lines.push(block(e));

  for (const { provider } of providers) {
    lines.push('', '  # --- ' + (provider.name ?? provider.id) + ' (' + provider.id + ') ---');
    for (const m of provider.models) lines.push(block(by.get(provider.id + '/' + m.id)));
  }

  // The plugin's own gateway carries the lanes a plain base URL cannot: OpenCode's free tier, Kilo, the
  // EAC/account channels and combos. LiteLLM reaches them through 127.0.0.1:8326 with the plugin's key.
  if (ofmModels.length) {
    lines.push('',
      '  # --- dsh-our-free-model 本地网关 (127.0.0.1:' + ofmPort + ') ---',
      '  #   ' + ofmModels.length + ' 个插件模型：OpenCode / Kilo / EAC / 账号渠道 / 路由组合');
    for (const m of ofmModels) {
      lines.push(block({
        name: 'ofm/' + m.id,
        model: m.id,
        base: 'http://127.0.0.1:' + ofmPort + '/v1',
        key: 'os.environ/OFM_GATEWAY_KEY',
        note: '插件车道 · ' + (m.name ?? m.id),
      }));
    }
  }

  const freeGroup = written.filter((w) => w.group === 'free-tier').map((w) => w.name).slice(0, 6);
  const groups = { ...GROUPS };
  if (freeGroup.length) groups.free = freeGroup;
  lines.push('', '  # --- 别名组 ---');
  for (const [group, members] of Object.entries(groups)) {
    for (const member of members) {
      const record = by.get(member);
      if (!record) continue;                                  // an upstream whose key is not there yet
      lines.push(block({ ...record, name: group, note: '组：' + group }));
    }
  }

  // A group is round-robined, so a single exhausted free upstream used to answer the whole group with
  // "502 Free usage limit reached". Retries hand the call to a sibling member, the cooldown parks a failing
  // member for a minute, and every alias falls back to the one upstream that needs no key at all.
  //
  // Picking a single model by name bypassed all of that: the quota error came back as the model's own answer
  // ("No fallback was attempted"), which is what made every synced model look broken. So each written name
  // gets a fallback too, pointed at a DeepSeek lane from the plugin gateway when it runs, otherwise the
  // keyless one.
  const ofmFallback = ofmModels.map((m) => 'ofm/' + m.id).find((id) => /deepseek/i.test(id) && !/think/i.test(id)) || null;
  const fallbackTarget = ofmFallback || 'pollinations-fast';
  const fallbackLine = (name) => {
    const chain = [fallbackTarget, 'pollinations-fast'].filter((x, i, a) => x !== name && a.indexOf(x) === i);
    return chain.length ? '    - ' + q(name) + ': [' + chain.map(q).join(', ') + ']' : null;
  };
  const fallbackTargets = [...new Set([...written.map((w) => w.name), ...Object.keys(groups)])];
  lines.push('',
    'router_settings:',
    '  num_retries: 2',
    '  retry_after: 1',
    '  allowed_fails: 1',
    '  cooldown_time: 600',
    '  fallbacks:',
    ...fallbackTargets.map(fallbackLine).filter(Boolean),
    '',
    'litellm_settings:',
    '  drop_params: true',
  );

  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').replace(/\s*$/, '\n');
  const names = [...text.matchAll(/^\s*-\s*model_name:\s*"([^"]+)"/gm)].map((m) => m[1]);
  return {
    text,
    models: [...new Set(names)],
    providers: providers.map((p) => p.provider.id),
    skipped: Math.max(0, (catalogue.providers ?? []).length - providers.length),
    laneOnly: laneSkipped.map((p) => p.id),
    ofmModels: ofmModels.length,
  };
}

/** One line for the panel: what the file holds and where it came from. */
export function describeGatewayConfig(env = {}, opts = {}) {
  const catalogue = opts.catalog ?? freeModelCatalogue();
  const built = buildGatewayConfig(env, { ...opts, catalog: catalogue });
  const src = catalogue.source ?? {};
  return {
    models: built.models.length,
    providers: built.providers.length,
    catalogue: (src.package ?? 'dsh-our-free-model') + '@' + (src.version ?? '?'),
    catalogueProviders: (freeModelCatalogue().providers ?? []).length,
    skipped: built.skipped,
    laneOnly: built.laneOnly,
    ofmModels: built.ofmModels,
    keys: [...new Set((freeModelCatalogue().providers ?? []).map((p) => p.auth?.env).filter(Boolean))].length,
  };
}
