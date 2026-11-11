/**
 * Live health of the free gateway models, and a short recommendation list.
 *
 * Probing every one of 300+ deployments with a real completion would cost tokens and minutes. The ones
 * that matter for "what should I use now" are a small set: built-in aliases and the plugin free lanes.
 * Each gets a short completion (max_tokens 8), bounded and concurrent; a failure is recorded, not hidden.
 */
const PROBE_TIMEOUT_MS = 15000;
const PROBE_CONCURRENCY = 3;
const MAX_FREE_LANES = 12;
const MAX_CATALOGUE = 16;
const ALIASES = ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-think', 'fast', 'zero', 'free', 'pollinations-fast'];

const state = { at: 0, checking: false, error: null, baseUrl: "", key: "", models: [], results: {}, timer: null, generation: 0 };

// The catalogue lanes are what the harness profile lists by name, so they have to be probed too: a list whose
// first entries are all out of daily quota is what made every synced model answer with a 429 of its own.
function pickTargets(models) {
  const list = Array.isArray(models) ? models : [];
  const catalogue = list.filter((id) => typeof id === 'string' && !id.startsWith('ofm/')).slice(0, MAX_CATALOGUE);
  const free = list.filter((id) => typeof id === 'string' && id.startsWith('ofm/our-free-model/')).slice(0, MAX_FREE_LANES);
  const aliases = ALIASES.filter((id) => list.includes(id));
  return [...new Set([...aliases, ...catalogue, ...free])];
}

async function probeOne(baseUrl, key, model, fetcher) {
  const started = Date.now();
  try {
    const res = await fetcher(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: false }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, ms, status: res.status, error: text.slice(0, 160) || ('HTTP ' + res.status) };
    }
    return { ok: true, ms, status: res.status };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, status: 0, error: e?.message ?? 'network error' };
  }
}

export function configureGatewayHealth({ baseUrl, key, models } = {}) {
  if (baseUrl) state.baseUrl = baseUrl;
  if (key) state.key = key;
  if (Array.isArray(models)) state.models = models;
}

export function gatewayHealthStatus() {
  const rows = Object.entries(state.results).map(([model, r]) => ({ model, ...r }))
    .sort((a, b) => (Number(b.ok) - Number(a.ok)) || (a.ms - b.ms));
  return {
    at: state.at, checking: state.checking, error: state.error,
    targets: pickTargets(state.models).length,
    ready: rows.filter((r) => r.ok).length, total: rows.length,
    best: rows.filter((r) => r.ok).slice(0, 5), results: rows,
  };
}

export async function checkGatewayHealth({ baseUrl, key, models, force = false, fetcher = fetch } = {}) {
  configureGatewayHealth({ baseUrl, key, models });
  if (!state.baseUrl || !state.key) return { ...gatewayHealthStatus(), error: 'gateway not configured' };
  if (state.checking) return gatewayHealthStatus();
  if (!force && state.at && Date.now() - state.at < 60000) return gatewayHealthStatus();
  const targets = pickTargets(state.models);
  if (!targets.length) return { ...gatewayHealthStatus(), error: 'no probe targets' };
  state.checking = true;
  state.error = null;
  try {
    const out = {};
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const model = targets[next++];
        out[model] = await probeOne(state.baseUrl, state.key, model, fetcher);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, targets.length) }, worker));
    state.results = out;
    state.at = Date.now();
  } catch (e) {
    state.error = e?.message ?? 'health check failed';
  } finally {
    state.checking = false;
  }
  return gatewayHealthStatus();
}

export function startGatewayHealth({ baseUrl, key, models, intervalMs = 300000, fetcher = fetch } = {}) {
  configureGatewayHealth({ baseUrl, key, models });
  if (state.timer) return;
  const generation = ++state.generation;
  const tick = () => { if (generation === state.generation) void checkGatewayHealth({ force: true, fetcher }); };
  setTimeout(tick, 4000);
  state.timer = setInterval(tick, Math.max(60000, intervalMs));
  if (state.timer.unref) state.timer.unref();
}

export function stopGatewayHealth() {
  state.generation = (state.generation || 0) + 1;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/** Clear the remembered gateway/address/results (tests, or a gateway that moved). */
export function resetGatewayHealth() {
  stopGatewayHealth();
  state.baseUrl = '';
  state.key = '';
  state.models = [];
  state.results = {};
  state.at = 0;
  state.error = null;
}
