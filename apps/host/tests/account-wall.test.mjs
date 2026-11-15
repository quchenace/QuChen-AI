// The desktop window has to ask for a QuChen account before it shows the app. These tests run the host's account
// module against a stand-in account service, so the wire format and the session file are both exercised without
// the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'quchen-account-'));
process.env.QUCHEN_AUTH_DIR = dir;
process.env.QUCHEN_AUTH_GATE = 'on';

const seen = [];
const accountService = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    seen.push({ path: req.url, method: req.method, body });
    const answer = (status, payload) => {
      const buf = Buffer.from(JSON.stringify(payload), 'utf8');
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length });
      res.end(buf);
    };
    if (req.url === '/api/auth/login') {
      if (body.password !== 'good-password') return answer(401, { code: 'bad_credentials', message: '邮箱或密码不正确' });
      return answer(200, { ok: true, access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 1800, user: { email: body.email, role: 'user' } });
    }
    if (req.url === '/api/auth/send-code') return answer(200, { ok: true, ttl: 600, resend_after: 60, message: '验证码已发送' });
    if (req.url === '/api/auth/logout') return answer(200, { ok: true });
    return answer(404, { message: 'not found' });
  });
});
await new Promise(resolve => accountService.listen(0, '127.0.0.1', resolve));
process.env.QUCHEN_AUTH_BASE = `http://127.0.0.1:${accountService.address().port}`;

const account = await import('../server/auth-account.mjs');
const sessionPath = join(dir, 'ai.json');

function fakeReq(body) {
  return { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body ?? {}), 'utf8'); } };
}
function fakeRes() {
  return {
    status: 0, headers: {}, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(buffer) { this.body = Buffer.isBuffer(buffer) ? JSON.parse(buffer.toString('utf8')) : buffer; },
  };
}
async function call(path, method = 'GET', body) {
  const res = fakeRes();
  const handled = await account.handleAuthRoute(fakeReq(body), res, path, method);
  return { handled, res };
}

test('a computer that never signed in starts locked', async () => {
  assert.equal(account.sessionFile(), sessionPath);
  const state = account.gateState();
  assert.equal(state.unlocked, false);
  assert.equal(state.why, 'no_session');
});

test('routes outside /api/auth belong to the rest of the host', async () => {
  const { handled } = await call('/api/native');
  assert.equal(handled, false);
});

test('state is answered for the window', async () => {
  const { res } = await call('/api/auth/state');
  assert.equal(res.status, 200);
  assert.equal(res.body.unlocked, false);
  assert.equal(res.body.app, 'ai');
});

test('a wrong password is reported, not swallowed', async () => {
  const { res } = await call('/api/auth/login', 'POST', { email: 'owner@quchen.dev', password: 'nope' });
  assert.equal(res.status, 401);
  assert.match(res.body.error, /不正确/);
  assert.equal(existsSync(sessionPath), false, 'a failed sign-in must not leave a session behind');
});

test('a good password writes the shared session file and unlocks', async () => {
  const { res } = await call('/api/auth/login', 'POST', { email: 'owner@quchen.dev', password: 'good-password' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const saved = JSON.parse(readFileSync(sessionPath, 'utf8'));
  assert.equal(saved.app, 'ai');
  assert.equal(saved.refresh_token, 'refresh-1');
  assert.equal(saved.email, 'owner@quchen.dev');
  assert.equal(account.gateState().unlocked, true);
  assert.equal(account.gateState().why, 'session');
  // The account service is never asked for a password twice: only the tokens are kept.
  assert.equal(JSON.stringify(saved).includes('good-password'), false);
});

test('the verification code request is proxied and its refusal reaches the window', async () => {
  const ok = await call('/api/auth/send-code', 'POST', { email: 'new@quchen.dev', purpose: 'register' });
  assert.equal(ok.res.status, 200);
  assert.equal(ok.res.body.resend_after, 60);
  assert.deepEqual(seen.at(-1).body, { email: 'new@quchen.dev', purpose: 'register' });
});

test('a session past its offline grace is locked again', async () => {
  const saved = JSON.parse(readFileSync(sessionPath, 'utf8'));
  const longAgo = Date.now() / 1000 - 400 * 86400;
  writeFileSync(sessionPath, JSON.stringify({ ...saved, issued_at: longAgo, last_verified: longAgo }), 'utf8');
  const state = account.gateState();
  assert.equal(state.unlocked, false);
  assert.equal(state.why, 'grace_expired');
});

test('signing out clears the session', async () => {
  await call('/api/auth/login', 'POST', { email: 'owner@quchen.dev', password: 'good-password' });
  assert.equal(account.gateState().unlocked, true);
  const { res } = await call('/api/auth/logout', 'POST', {});
  assert.equal(res.status, 200);
  assert.equal(account.gateState().unlocked, false);
  assert.equal(account.gateState().why, 'no_session');
});

test('an unreachable account service still answers the window', async () => {
  const previous = process.env.QUCHEN_AUTH_BASE;
  process.env.QUCHEN_AUTH_BASE = 'http://127.0.0.1:1';
  try {
    const { res } = await call('/api/auth/login', 'POST', { email: 'owner@quchen.dev', password: 'good-password' });
    assert.equal(res.status, 503);
    assert.match(res.body.error, /不可达|超时/);
  } finally {
    process.env.QUCHEN_AUTH_BASE = previous;
  }
});

test('the gate can be turned off for a build without accounts', async () => {
  process.env.QUCHEN_AUTH_GATE = 'off';
  try {
    assert.equal(account.gateState().unlocked, true);
    const { res } = await call('/api/auth/login', 'POST', { email: 'owner@quchen.dev', password: 'good-password' });
    assert.equal(res.status, 409);
  } finally {
    process.env.QUCHEN_AUTH_GATE = 'on';
  }
});

test('the product API is shut until the account gate opens', async () => {
  assert.equal(account.apiLocked('/api/chats'), true);
  assert.equal(account.apiLocked('/api/events'), true);
  assert.equal(account.apiLocked('/api/models'), true);
  // The shell still has to be able to see the host and stop it.
  assert.equal(account.apiLocked('/api/health'), false);
  assert.equal(account.apiLocked('/api/control/shutdown'), false);
  assert.equal(account.apiLocked('/api/auth/state'), false);
  // Static files are what draws the wall itself.
  assert.equal(account.apiLocked('/'), false);
  assert.equal(account.apiLocked('/assets/index.js'), false);
  await call('/api/auth/login', 'POST', { email: 'owner@quchen.dev', password: 'good-password' });
  assert.equal(account.apiLocked('/api/chats'), false, 'a signed-in window reaches the product API');
});

test('cleanup', () => { accountService.close(); });
