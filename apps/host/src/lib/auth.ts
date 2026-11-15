/**
 * The QuChen account, as the window sees it.
 *
 * The host answers /api/auth/* on this origin (server/auth-account.mjs); nothing
 * here talks to the account service directly, so the window stays on one origin
 * and the tokens never travel through the page.
 */
import { api } from './client';

export interface AccountState {
  unlocked: boolean;
  why: string;
  email?: string | null;
  account_base?: string;
  app?: string;
  grace_days?: number;
  offline_days?: number;
}

export const accountBase = () => state?.account_base ?? 'https://frp-any.com:19549';

let state: AccountState | null = null;

/** Ask the host whether a signed-in session exists. A host that cannot answer keeps the window locked. */
export async function accountState(): Promise<AccountState> {
  try {
    state = await api.get<AccountState>('/api/auth/state');
  } catch {
    state = state ?? { unlocked: false, why: 'host_unreachable' };
  }
  return state;
}

export function lastAccountState(): AccountState | null {
  return state;
}

export async function signIn(email: string, password: string): Promise<{ ok: boolean; email?: string }> {
  const result = await api.post<{ ok: boolean; email?: string }>('/api/auth/login', { email, password });
  state = { ...(state ?? { why: 'session' }), unlocked: true, why: 'session', email: result.email ?? email };
  return result;
}

export async function signUp(email: string, code: string, password: string): Promise<{ ok: boolean; status?: string; message?: string }> {
  return api.post('/api/auth/register', { email, code, password });
}

export interface CodeSent { ok: boolean; message?: string; dev_code?: string; ttl?: number; resend_after?: number }

export async function requestCode(email: string, purpose: 'register' | 'reset' = 'register'): Promise<CodeSent> {
  return api.post<CodeSent>(`/api/auth/${purpose === 'reset' ? 'reset-send' : 'send-code'}`, { email, purpose });
}

export async function confirmReset(email: string, code: string, password: string): Promise<{ ok: boolean; message?: string }> {
  return api.post('/api/auth/reset-confirm', { email, code, password });
}

export async function signOut(): Promise<void> {
  await api.post('/api/auth/logout').catch(() => undefined);
  state = { ...(state ?? { why: 'no_session' }), unlocked: false, why: 'no_session', email: null };
}
