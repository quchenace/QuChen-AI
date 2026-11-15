/**
 * The sign-in wall for the desktop window.
 *
 * Before this screen existed an installed QuChen went straight to the app: the
 * account gate lived only in the Python page the window does not load. The wall
 * asks the host whether a session exists, and refuses to draw the app until one
 * does. Copy is bilingual here rather than in locales/*.json: the language is
 * read before the store boots, and a wall must render without it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Brand } from '../components/Brand';
import { Btn } from '../components/ui';
import {
  accountBase, accountState, confirmReset, requestCode, signIn, signUp,
  type AccountState,
} from '../lib/auth';

type Mode = 'login' | 'register' | 'reset';

const COPY = {
  zh: {
    title: '登录 QuChen 账号',
    sub: 'QuChen 需要一个账号才能使用：会话、模型与设置都挂在这个账号下。',
    loginTab: '登录', registerTab: '注册', resetTab: '找回密码',
    email: '邮箱', password: '密码', password2: '确认密码', code: '邮箱验证码',
    send: '获取验证码', resend: '秒后重发', sending: '发送中…',
    signIn: '登录', signingIn: '登录中…', signUp: '注册账号', signingUp: '注册中…',
    resetSubmit: '重置密码', resetting: '提交中…',
    toRegister: '还没有账号？注册', toLogin: '已有账号？去登录',
    forgot: '忘记密码？',
    pending: '注册成功，等待管理员审批后即可登录。',
    resetDone: '密码已重置，请用新密码登录。',
    codeSent: '验证码已发送，10 分钟内有效。',
    why_no_session: '这台电脑还没有登录过 QuChen 账号。',
    why_grace_expired: '登录状态已超过离线宽限期，请重新登录。',
    why_revoked: '会话已被管理员结束，请重新登录。',
    why_host_unreachable: '无法连接本机 QuChen 服务，请确认应用已正常启动。',
    why_default: '请登录后继续。',
    needFields: '请填写邮箱和密码。',
    needCode: '请填写邮箱收到的 6 位验证码。',
    mismatch: '两次输入的密码不一致。',
    shortPassword: '密码至少 8 位，且包含字母和数字。',
    badEmail: '邮箱格式不正确。',
    accountService: '账号服务',
  },
  en: {
    title: 'Sign in to QuChen',
    sub: 'A QuChen account holds your conversations, models and settings.',
    loginTab: 'Sign in', registerTab: 'Create account', resetTab: 'Reset password',
    email: 'Email', password: 'Password', password2: 'Confirm password', code: 'Email code',
    send: 'Send code', resend: 's to resend', sending: 'Sending…',
    signIn: 'Sign in', signingIn: 'Signing in…', signUp: 'Create account', signingUp: 'Creating…',
    resetSubmit: 'Reset password', resetting: 'Sending…',
    toRegister: 'No account yet? Create one', toLogin: 'Already registered? Sign in',
    forgot: 'Forgot your password?',
    pending: 'Account created. An administrator must approve it before you can sign in.',
    resetDone: 'Password reset. Sign in with the new one.',
    codeSent: 'Code sent; it is valid for 10 minutes.',
    why_no_session: 'This computer has not signed in to a QuChen account yet.',
    why_grace_expired: 'The offline grace period ended. Sign in again.',
    why_revoked: 'An administrator ended this session. Sign in again.',
    why_host_unreachable: 'The local QuChen service is not answering. Check that the app is running.',
    why_default: 'Sign in to continue.',
    needFields: 'Enter your email and password.',
    needCode: 'Enter the 6-digit code from your email.',
    mismatch: 'The two passwords do not match.',
    shortPassword: 'Use at least 8 characters, with letters and digits.',
    badEmail: 'That does not look like an email address.',
    accountService: 'Account service',
  },
} as const;

type Copy = { [K in keyof (typeof COPY)['zh']]: string };

function copy(): Copy {
  const tag = (typeof navigator !== 'undefined' ? navigator.language : 'en') || 'en';
  return tag.toLowerCase().startsWith('zh') ? COPY.zh : COPY.en;
}

/** The wall itself. Renders the app only after the host says a session exists. */
export function AuthWall({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AccountState | null>(null);

  const check = useCallback(() => {
    void accountState().then(next => setState(next));
  }, []);

  useEffect(() => { check(); }, [check]);

  if (!state) {
    return (
      <div className="authwall" role="status" aria-live="polite">
        <div className="authwall__panel"><span className="authwall__spin" /></div>
      </div>
    );
  }
  if (state.unlocked) return <>{children}</>;
  return <AuthScreen state={state} onSignedIn={() => setState({ ...state, unlocked: true, why: 'session' })} />;
}

function AuthScreen({ state, onSignedIn }: { state: AccountState; onSignedIn: () => void }) {
  const t = copy();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState(state.email ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const tick = useRef<number | null>(null);

  useEffect(() => {
    if (wait <= 0) return undefined;
    tick.current = window.setTimeout(() => setWait(value => value - 1), 1000);
    return () => { if (tick.current) window.clearTimeout(tick.current); };
  }, [wait]);

  const reason = (t as unknown as Record<string, string>)[`why_${state.why}`] ?? t.why_default;

  const switchMode = (next: Mode) => {
    setMode(next);
    setError('');
    setNote('');
    setCode('');
    setPassword('');
    setConfirm('');
  };

  const sendCode = async () => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) { setError(t.badEmail); return; }
    setError('');
    setNote('');
    setBusy(true);
    try {
      const result = await requestCode(email.trim(), mode === 'reset' ? 'reset' : 'register');
      setNote(result?.dev_code ? `${t.codeSent}（dev: ${result.dev_code}）` : (result?.message || t.codeSent));
      setWait(result?.resend_after ?? 60);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setNote('');
    if (!email.trim() || (mode === 'login' && !password)) { setError(t.needFields); return; }
    if (mode !== 'login' && !/^\d{6}$/.test(code.trim())) { setError(t.needCode); return; }
    if (mode !== 'login' && password !== confirm) { setError(t.mismatch); return; }
    if (mode !== 'login' && password.length < 8) { setError(t.shortPassword); return; }
    setBusy(true);
    try {
      if (mode === 'login') {
        await signIn(email.trim(), password);
        onSignedIn();
        return;
      }
      if (mode === 'register') {
        const result = await signUp(email.trim(), code.trim(), password);
        setNote(result?.message || t.pending);
        setMode('login');
        setPassword('');
        setConfirm('');
        setCode('');
        return;
      }
      const result = await confirmReset(email.trim(), code.trim(), password);
      setNote(result?.message || t.resetDone);
      setMode('login');
      setPassword('');
      setConfirm('');
      setCode('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="authwall">
      <form className="authwall__panel" onSubmit={submit} noValidate>
        <div className="authwall__head">
          <Brand variant="lockup" height={30} />
          <h1 className="authwall__title">{t.title}</h1>
          <p className="authwall__sub">{state.why === 'session' ? t.sub : reason}</p>
        </div>

        <div className="authwall__tabs" role="tablist">
          {(['login', 'register', 'reset'] as Mode[]).map(item => (
            <button
              key={item}
              type="button"
              role="tab"
              className="authwall__tab"
              aria-selected={mode === item}
              onClick={() => switchMode(item)}
            >
              {item === 'login' ? t.loginTab : item === 'register' ? t.registerTab : t.resetTab}
            </button>
          ))}
        </div>

        <div className="authwall__form">
          <label className="authwall__field">
            <span className="authwall__label">{t.email}</span>
            <input
              className="authwall__input"
              type="email"
              autoComplete="username"
              inputMode="email"
              spellCheck={false}
              value={email}
              disabled={busy}
              onChange={event => setEmail(event.target.value)}
            />
          </label>

          {mode !== 'login' && (
            <label className="authwall__field">
              <span className="authwall__label">{t.code}</span>
              <span className="authwall__code">
                <input
                  className="authwall__input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  disabled={busy}
                  onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                />
                <Btn
                  variant="secondary"
                  size="sm"
                  className="authwall__send"
                  disabled={busy || wait > 0}
                  type="button"
                  onClick={() => { void sendCode(); }}
                >
                  {busy ? t.sending : wait > 0 ? `${wait}${t.resend}` : t.send}
                </Btn>
              </span>
            </label>
          )}

          <label className="authwall__field">
            <span className="authwall__label">{t.password}</span>
            <input
              className="authwall__input"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              disabled={busy}
              onChange={event => setPassword(event.target.value)}
            />
          </label>

          {mode !== 'login' && (
            <label className="authwall__field">
              <span className="authwall__label">{t.password2}</span>
              <input
                className="authwall__input"
                type="password"
                autoComplete="new-password"
                value={confirm}
                disabled={busy}
                onChange={event => setConfirm(event.target.value)}
              />
            </label>
          )}

          {error && <p className="authwall__error">{error}</p>}
          {note && !error && <p className="authwall__note">{note}</p>}

          <Btn variant="primary" size="md" block disabled={busy} type="submit">
            {mode === 'login' ? (busy ? t.signingIn : t.signIn)
              : mode === 'register' ? (busy ? t.signingUp : t.signUp)
                : (busy ? t.resetting : t.resetSubmit)}
          </Btn>
        </div>

        <div className="authwall__foot">
          <button type="button" className="authwall__link" onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? t.toRegister : t.toLogin}
          </button>
          <span className="authwall__base">{t.accountService} · {state.account_base ?? accountBase()}</span>
        </div>
      </form>
    </div>
  );
}
