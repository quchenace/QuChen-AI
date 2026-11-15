/**
 * QuChen account gate for the desktop host (apps/host).
 *
 * The Python server (serve/authgate.py) already gates the web page it serves.
 * The desktop window does not load that page: it loads this host's own React UI
 * from apps/host/dist, so before this module existed an installed QuChen showed
 * no sign-in window at all and reached the app without an account.
 *
 * One session file, shared with serve/authgate.py (same path, same fields):
 *   %APPDATA%\QuChen\auth\ai.json        (~/.config/QuChen/auth/ai.json elsewhere)
 * so a sign-in in the window also unlocks the Python page, and the other way
 * round. Only tokens and the e-mail are stored, never the password.
 *
 * The account service is reached from the host, not from the window: the window
 * talks to /api/auth/* on its own origin, which keeps the app inside one origin
 * and out of the browser's CORS rules.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

/** The account service. Overridable for a private deployment or a test rig; read per call so a test can point it elsewhere. */
export function accountBaseUrl() {
  return (process.env.QUCHEN_AUTH_BASE || 'https://frp-any.com:19549').replace(/\/+$/, '');
}

/** Our own hosts serve a self-signed certificate; the client must not reject it. */
const SELF_SIGNED = ['frp-any.com', 'natfrp.cloud', 'traesite.cn'];

const APP = 'ai';
const GRACE_DAYS = Number(process.env.QUCHEN_AUTH_GRACE_DAYS || 30);
const REFRESH_SKEW = 24 * 3600;

export function sessionFile() {
  const root = process.env.QUCHEN_AUTH_DIR
    || (process.platform === 'win32'
      ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'QuChen', 'auth')
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'QuChen', 'auth'));
  return join(root, `${APP}.json`);
}

function readSession() {
  try {
    const data = JSON.parse(readFileSync(sessionFile(), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeSession(state) {
  try {
    const file = sessionFile();
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch {
    /* A read-only disk is not fatal: the running process keeps its answer in memory. */
  }
}

function accountCall(path, payload, { method = 'POST', token } = {}) {
  const base = new URL(accountBaseUrl());
  const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload), 'utf8');
  const headers = { accept: 'application/json' };
  if (body) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(body.length);
  }
  if (token) headers.authorization = `Bearer ${token}`;
  const selfSigned = SELF_SIGNED.some(h => base.hostname === h || base.hostname.endsWith(`.${h}`));
  const send = base.protocol === 'http:' ? httpRequest : httpsRequest;
  return new Promise((resolve, reject) => {
    const req = send({
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port || undefined,
      path: `${base.pathname.replace(/\/+$/, '')}${path}`,
      method,
      headers,
      timeout: 15000,
      ...(base.protocol === 'http:' ? {} : { rejectUnauthorized: !selfSigned }),
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 300) }; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(data);
        const failure = new Error(data.message || data.error || `账号服务返回 ${res.statusCode}`);
        failure.status = res.statusCode;
        failure.code = data.code || data.error?.type || 'account_error';
        reject(failure);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('账号服务连接超时')); });
    req.on('error', err => {
      const failure = new Error(`账号服务不可达：${err.message}`);
      failure.status = 0;
      failure.code = 'unreachable';
      reject(failure);
    });
    if (body) req.write(body);
    req.end();
  });
}

export function gateEnabled() {
  const flag = process.env.QUCHEN_AUTH_GATE;
  if (flag === undefined) return true;
  return !['off', '0', 'false', 'no', 'none'].includes(String(flag).trim().toLowerCase());
}

/** What /api/auth/state answers: whether the window may open, and why not. */
export function gateState() {
  if (!gateEnabled()) return { unlocked: true, why: 'disabled', account_base: accountBaseUrl(), app: APP, grace_days: GRACE_DAYS };
  const state = readSession();
  const base = { account_base: accountBaseUrl(), app: APP, grace_days: GRACE_DAYS, email: state.email ?? null };
  if (!state.refresh_token) return { ...base, unlocked: false, why: 'no_session' };
  if (state.revoked) return { ...base, unlocked: false, why: 'revoked' };
  const now = Date.now() / 1000;
  const verified = Number(state.last_verified || 0);
  if (verified && now - verified <= GRACE_DAYS * 86400) {
    return { ...base, unlocked: true, why: 'session', offline_days: Math.floor((now - verified) / 86400) };
  }
  const issued = Number(state.issued_at || 0);
  if (issued && now - issued <= GRACE_DAYS * 86400) {
    return { ...base, unlocked: true, why: 'session', offline_days: Math.floor((now - issued) / 86400) };
  }
  return { ...base, unlocked: false, why: 'grace_expired' };
}

export function unlocked() {
  return gateState().unlocked === true;
}

/**
 * API routes that stay reachable while the window is locked.
 *
 * The health check is how the shell decides the host is up, and the control channel is what lets the shell stop it;
 * blocking either would turn a signed-out app into an app that cannot start or quit. Everything else — chats, models,
 * settings, the event stream — is the product, and belongs behind the account.
 */
const OPEN_API = ['/api/health', '/api/control', '/api/auth'];

/** True when an API route must be refused until someone signs in. */
export function apiLocked(path) {
  if (!path.startsWith('/api/')) return false;
  if (!gateEnabled()) return false;
  if (OPEN_API.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) return false;
  return !unlocked();
}

export async function login(email, password, deviceName) {
  const data = await accountCall('/api/auth/login', {
    email: String(email || '').trim(),
    password: String(password || ''),
    device: `${hostname()}-${APP}`.slice(0, 128),
    device_name: deviceName || 'QuChen AI',
  });
  const now = Date.now() / 1000;
  const state = {
    app: APP,
    email: data.user?.email || email,
    role: data.user?.role ?? null,
    access_token: data.access_token ?? null,
    refresh_token: data.refresh_token ?? null,
    expires_at: now + Number(data.expires_in || 1800),
    issued_at: now,
    last_verified: now,
    revoked: false,
  };
  writeSession(state);
  return { ok: true, email: state.email, role: state.role };
}

export async function register({ email, code, password }) {
  const data = await accountCall('/api/auth/register', {
    email: String(email || '').trim(),
    code: String(code || '').trim(),
    password: String(password || ''),
  });
  return { ok: true, status: data.status, message: data.message };
}

export async function sendCode(email, purpose = 'register') {
  return accountCall('/api/auth/send-code', { email: String(email || '').trim(), purpose });
}

export async function resetSend(email) {
  return accountCall('/api/auth/reset-send', { email: String(email || '').trim() });
}

export async function resetConfirm({ email, code, password }) {
  return accountCall('/api/auth/reset-confirm', {
    email: String(email || '').trim(),
    code: String(code || '').trim(),
    password: String(password || ''),
  });
}

export async function refresh() {
  const state = readSession();
  if (!state.refresh_token) {
    const failure = new Error('尚未登录');
    failure.status = 401;
    failure.code = 'no_session';
    throw failure;
  }
  const data = await accountCall('/api/auth/refresh', { refresh_token: state.refresh_token });
  const next = {
    ...state,
    access_token: data.access_token ?? state.access_token,
    refresh_token: data.refresh_token || state.refresh_token,
    expires_at: Date.now() / 1000 + Number(data.expires_in || 1800),
    last_verified: Date.now() / 1000,
    revoked: false,
  };
  writeSession(next);
  return { ok: true, email: next.email };
}

/** Keep the session fresh in the background; a network failure never signs the user out. */
export async function ensureFresh() {
  const state = readSession();
  if (!state.refresh_token) return false;
  if (Number(state.expires_at || 0) - Date.now() / 1000 > REFRESH_SKEW) return true;
  try {
    await refresh();
    return true;
  } catch (err) {
    if (err.status === 401 || err.status === 403) writeSession({ ...state, revoked: true });
    return false;
  }
}

export async function logout() {
  const state = readSession();
  if (state.refresh_token) {
    try {
      await accountCall('/api/auth/logout', { refresh_token: state.refresh_token }, { token: state.access_token });
    } catch { /* the local session goes either way */ }
  }
  writeSession({});
  return { ok: true };
}

export async function entitlement() {
  const state = readSession();
  if (!state.access_token) return {};
  try {
    return await accountCall('/api/auth/entitlement', undefined, { method: 'GET', token: state.access_token });
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ http --- */

function send(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('请求必须是 JSON'), { status: 400, code: 'bad_json' });
  }
}

/**
 * Routes /api/auth/* for the host. Returns true when it answered the request.
 * The window's own origin is the only caller: a foreign page cannot reach this,
 * and the account credentials never leave the process.
 */
export async function handleAuthRoute(req, res, path, method) {
  if (path !== '/api/auth' && !path.startsWith('/api/auth/')) return false;
  const route = path.replace(/^\/api\/auth/, '') || '/state';
  try {
    if (method === 'GET' && (route === '/state' || route === '/')) {
      send(res, 200, gateState());
      return true;
    }
    if (method === 'GET' && route === '/entitlement') {
      send(res, 200, await entitlement());
      return true;
    }
    if (method === 'GET' && route === '/session') {
      const state = readSession();
      send(res, 200, { email: state.email ?? null, role: state.role ?? null, ...gateState() });
      return true;
    }
    if (method !== 'POST') {
      send(res, 405, { error: 'Method not allowed.' });
      return true;
    }
    if (!gateEnabled()) {
      send(res, 409, { error: '账号门禁已关闭（QUCHEN_AUTH_GATE=off）。', code: 'gate_off' });
      return true;
    }
    const body = await readJson(req);
    if (route === '/login') {
      send(res, 200, await login(body.email, body.password, body.device_name));
      return true;
    }
    if (route === '/register') {
      send(res, 200, await register(body));
      return true;
    }
    if (route === '/send-code') {
      send(res, 200, await sendCode(body.email, body.purpose || 'register'));
      return true;
    }
    if (route === '/reset-send') {
      send(res, 200, await resetSend(body.email));
      return true;
    }
    if (route === '/reset-confirm') {
      send(res, 200, await resetConfirm(body));
      return true;
    }
    if (route === '/refresh') {
      send(res, 200, await refresh());
      return true;
    }
    if (route === '/logout') {
      send(res, 200, await logout());
      return true;
    }
    send(res, 404, { error: 'Unknown account action.' });
    return true;
  } catch (err) {
    const status = [400, 401, 403, 409, 423, 429].includes(err.status) ? err.status : err.status === 0 ? 503 : 502;
    send(res, status, { error: err.message || '账号服务处理失败', code: err.code || 'account_error' });
    return true;
  }
}

export const account = { handle: handleAuthRoute, state: gateState, unlocked, enabled: gateEnabled, sessionFile };
export default account;
