/**
 * The dsh-our-free-model plugin's local gateway, as an upstream for QuChen's free gateway.
 *
 * The plugin serves its lanes (OpenCode free, Kilo, EAC, combos, the account channels) on
 * 127.0.0.1:8326/v1 with its own key. Its models are not plain provider entries: the wire shape and the
 * per-request client fingerprint live in the plugin, so QuChen cannot re-declare them. It can, however,
 * point LiteLLM at that gateway and re-expose its models under `ofm/` names. The key stays in the
 * plugin's own 0600 file and is copied into the gateway's .env only while the gateway runs.
 *
 * Nothing here starts or downloads the plugin: when DSH is not running the probe answers nothing, the
 * gateway is written without these models, and the next start picks them up.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** DSH's home: the plugin and its gateway key live here unless DSH_HOME says otherwise. */
export function ofmHome(env = process.env) {
  return String(env.DSH_HOME || '').trim() || join(homedir(), '.dsh');
}

/** The key file the plugin's gateway reads (openai-gateway/api-key under the DSH home). */
export function ofmKeyFile(env = process.env) {
  return join(ofmHome(env), 'openai-gateway', 'api-key');
}

/** The key: the plugin's env override first, then its credential file. Null when neither is there. */
export function ofmGatewayKey(env = process.env) {
  const fromEnv = String(env.DSH_OPENAI_GATEWAY_API_KEY ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    const key = readFileSync(ofmKeyFile(env), 'utf8').trim();
    return key || null;
  } catch {
    return null;
  }
}

/** The plugin gateway's port, the same default and override the plugin uses. */
export function ofmGatewayPort(env = process.env) {
  const raw = String(env.DSH_OPENAI_GATEWAY_PORT ?? '').trim();
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 8326;
}

/** Lanes the plugin itself answers; `gateway/*` is the plugin's view of QuChen's own gateway and would loop. */
function usable(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && !id.startsWith('gateway/');
}

let cache = { at: 0, value: null };

/**
 * The models the running plugin gateway lists, or { running: false, models: [] }.
 * Cached briefly so the status endpoint (polled by the panel) never probes on every tick.
 */
export async function ofmModels({ env = process.env, fetchImpl = fetch, timeoutMs = 1500, cacheMs = 5000, force = false } = {}) {
  const now = Date.now();
  if (!force && cache.value && now - cache.at < cacheMs) return cache.value;
  const key = ofmGatewayKey(env);
  const port = ofmGatewayPort(env);
  if (!key) {
    cache = { at: now, value: { running: false, port, models: [], reason: 'no plugin gateway key' } };
    return cache.value;
  }
  try {
    const res = await fetchImpl('http://127.0.0.1:' + port + '/v1/models', {
      headers: { authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const doc = await res.json();
    const seen = new Set();
    const models = [];
    for (const m of Array.isArray(doc?.data) ? doc.data : []) {
      const id = m?.id;
      if (!usable(id) || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, name: m?.name ?? id, ownedBy: m?.owned_by ?? '' });
    }
    cache = { at: now, value: { running: true, port, key, models } };
    return cache.value;
  } catch (e) {
    cache = { at: now, value: { running: false, port, models: [], reason: e?.message ?? 'not running' } };
    return cache.value;
  }
}

/** One line for the panel. No key and no body of the key. */
export async function ofmStatus(opts = {}) {
  const got = await ofmModels(opts);
  return { running: !!got.running, port: got.port, models: got.models.length, reason: got.reason ?? null };
}
