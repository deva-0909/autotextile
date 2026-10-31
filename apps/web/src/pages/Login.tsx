import { ArrowLeft, Eye, EyeOff, KeyRound, Lock, Mail, ShieldCheck } from 'lucide-react';
import { DemoLoginPanel, useDemoUsers } from '../components/DemoSwitcher';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Link } from '../components/AppLink';
import { api, ApiError, type SessionUser } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, Input, Notice } from '../components/ui';

type LoginResult = { mfaRequired: true; mfaToken: string } | { accessToken: string; user: SessionUser; mustChangePassword: boolean };

function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen bg-white lg:grid-cols-[1.05fr_1fr]">
      <div className="relative hidden overflow-hidden bg-nav-950 lg:block">
        <svg className="absolute inset-0 h-full w-full opacity-[0.16]" aria-hidden>
          <defs>
            <pattern id="knit" width="28" height="22" patternUnits="userSpaceOnUse">
              <path d="M0 11c3.5-7 10.5-7 14 0s10.5 7 14 0" fill="none" stroke="#9eacf9" strokeWidth="1.2" />
              <path d="M0 0c3.5-7 10.5-7 14 0s10.5 7 14 0M0 22c3.5-7 10.5-7 14 0s10.5 7 14 0" fill="none" stroke="#9eacf9" strokeWidth="1.2" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#knit)" />
        </svg>
        <div className="absolute inset-0 bg-gradient-to-br from-brand-700/40 via-nav-950/70 to-nav-950" />
        <div className="relative flex h-full flex-col justify-between p-12 text-white">
          <div className="flex items-center gap-3">
            <img src="/favicon.svg" alt="" className="size-9" />
            <span className="text-lg font-semibold">Textile ERP</span>
          </div>
          <div className="max-w-md">
            <h1 className="text-[32px] leading-tight font-semibold tracking-tight">From grey fabric to customer doorstep — one system of record.</h1>
            <p className="mt-4 text-[15px] leading-relaxed text-slate-300">
              Procurement, mill job work, roll-level inventory, B2B sales, dispatch and GST-ready accounting across every warehouse and registration.
            </p>
            <div className="mt-10 grid grid-cols-3 gap-4 border-t border-white/10 pt-6 text-[12.5px] text-slate-300">
              <div><p className="text-xl font-semibold text-white">5</p>warehouses</div>
              <div><p className="text-xl font-semibold text-white">3</p>GST registrations</div>
              <div><p className="text-xl font-semibold text-white">KG</p>roll-level tracking</div>
            </div>
          </div>
          <p className="flex items-center gap-2 text-[12px] text-slate-400"><ShieldCheck className="size-4" /> Protected by role-based access, MFA and an immutable audit trail.</p>
        </div>
      </div>
      <div className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-[380px]">{children}</div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { signIn, user } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const codeRef = useRef<HTMLInputElement>(null);
  const demo = useDemoUsers();

  useEffect(() => { if (user) nav(params.get('next') ?? '/', { replace: true }); }, [user, nav, params]);
  useEffect(() => { if (mfaToken) codeRef.current?.focus(); }, [mfaToken]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const r = await api.post<LoginResult>('/identity/auth/login', { email, password });
      if ('mfaRequired' in r) setMfaToken(r.mfaToken);
      else signIn(r);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Cannot reach the server. Is it running?');
    } finally {
      setLoading(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      signIn(await api.post('/identity/auth/mfa', { mfaToken, code }));
    } catch (err) {
      setError((err as Error).message);
      setCode('');
    } finally {
      setLoading(false);
    }
  }

  if (mfaToken) {
    return (
      <AuthShell>
        <button className="mb-8 inline-flex items-center gap-1.5 text-[13px] text-slate-500 hover:text-slate-900" onClick={() => { setMfaToken(null); setError(null); }}>
          <ArrowLeft className="size-4" /> Back
        </button>
        <div className="mb-6 flex size-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><ShieldCheck className="size-5" /></div>
        <h2 className="text-[22px] font-semibold tracking-tight">Two-step verification</h2>
        <p className="mt-1.5 text-[13.5px] text-slate-500">Enter the 6-digit code from your authenticator app.</p>
        <form onSubmit={verify} className="mt-7 space-y-5">
          {error && <Notice tone="danger">{error}</Notice>}
          <input
            ref={codeRef}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            className="input h-12 text-center font-mono text-[22px] tracking-[0.5em]"
            placeholder="••••••"
            aria-label="Verification code"
          />
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading} disabled={code.length !== 6}>Verify and sign in</Button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h2 className="text-[24px] font-semibold tracking-tight">Sign in</h2>
      <p className="mt-1.5 text-[13.5px] text-slate-500">Use your work email to access the ERP.</p>
      <form onSubmit={submit} className="mt-8 space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <Input label="Work email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} prefix={<Mail className="size-4" />} autoFocus />
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-[12.5px] font-medium text-slate-700" htmlFor="pw">Password</label>
            <Link to="/forgot-password" className="text-[12.5px] font-medium text-brand-600 hover:underline">Forgot password?</Link>
          </div>
          <div className="relative">
            <Lock className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <input id="pw" type={show ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="input pr-10 pl-9" />
            <button type="button" onClick={() => setShow((s) => !s)} className="absolute top-1/2 right-2.5 -translate-y-1/2 text-slate-400 hover:text-slate-700" aria-label={show ? 'Hide password' : 'Show password'}>
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </div>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>Sign in</Button>
      </form>
      {demo.data?.length ? <DemoLoginPanel /> : (
        <div className="mt-8 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-[12.5px] text-slate-600">
          <p className="font-medium text-slate-800">Demo environment</p>
          <p className="mt-1">admin@textile.local · owner@textile.local · purchase@textile.local · surat.stores@textile.local — password <span className="font-mono">Textile@2026</span></p>
        </div>
      )}
      <p className="mt-4 text-center text-[13px] text-slate-600">Buying fabric for your business? <Link to="/register" className="font-medium text-brand-600 hover:underline">Open a trade account</Link></p>
    </AuthShell>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState<{ devToken?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  return (
    <AuthShell>
      <Link to="/login" className="mb-8 inline-flex items-center gap-1.5 text-[13px] text-slate-500 hover:text-slate-900"><ArrowLeft className="size-4" /> Back to sign in</Link>
      <div className="mb-6 flex size-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><KeyRound className="size-5" /></div>
      <h2 className="text-[22px] font-semibold tracking-tight">Reset your password</h2>
      <p className="mt-1.5 text-[13.5px] text-slate-500">We’ll issue a reset link valid for 30 minutes.</p>
      {done ? (
        <div className="mt-7 space-y-4">
          <Notice tone="success" title="Check your email">If an account exists for {email}, a reset link has been issued.</Notice>
          {done.devToken && (
            <Notice tone="warning" title="Development mode">
              Email delivery arrives in a later phase. <Link className="link" to={`/reset-password?token=${encodeURIComponent(done.devToken)}`}>Open the reset link</Link>
            </Notice>
          )}
        </div>
      ) : (
        <form
          className="mt-7 space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setLoading(true);
            setDone(await api.post<{ devToken?: string }>('/identity/auth/password-reset/request', { email }).finally(() => setLoading(false)));
          }}
        >
          <Input label="Work email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} prefix={<Mail className="size-4" />} autoFocus />
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>Send reset link</Button>
        </form>
      )}
    </AuthShell>
  );
}

export function PasswordRules({ value }: { value: string }) {
  const rules = [
    ['At least 10 characters', value.length >= 10],
    ['Upper and lower case letters', /[a-z]/.test(value) && /[A-Z]/.test(value)],
    ['A number', /[0-9]/.test(value)],
    ['A symbol', /[^A-Za-z0-9]/.test(value)],
  ] as const;
  return (
    <ul className="grid grid-cols-2 gap-1.5 text-[12px]">
      {rules.map(([label, ok]) => (
        <li key={label} className={ok ? 'text-emerald-700' : 'text-slate-500'}>{ok ? '✓' : '○'} {label}</li>
      ))}
    </ul>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  return (
    <AuthShell>
      <h2 className="text-[22px] font-semibold tracking-tight">Choose a new password</h2>
      <form
        className="mt-7 space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (pw !== confirm) return setError('Passwords do not match');
          setLoading(true);
          setError(null);
          try {
            await api.post('/identity/auth/password-reset/confirm', { token: params.get('token'), password: pw });
            nav('/login?reset=1');
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setLoading(false);
          }
        }}
      >
        {error && <Notice tone="danger">{error}</Notice>}
        <Input label="New password" type="password" autoComplete="new-password" required value={pw} onChange={(e) => setPw(e.target.value)} />
        <PasswordRules value={pw} />
        <Input label="Confirm password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>Update password</Button>
      </form>
    </AuthShell>
  );
}

export function ChangePasswordRequired() {
  const { passwordChanged, signOut } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  return (
    <AuthShell>
      <div className="mb-6 flex size-11 items-center justify-center rounded-xl bg-amber-50 text-amber-600"><KeyRound className="size-5" /></div>
      <h2 className="text-[22px] font-semibold tracking-tight">Set your own password</h2>
      <p className="mt-1.5 text-[13.5px] text-slate-500">Your administrator issued a temporary password. Choose a new one to continue.</p>
      <form
        className="mt-7 space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setLoading(true);
          setError(null);
          try {
            await api.post('/identity/me/password', { current, next });
            passwordChanged();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setLoading(false);
          }
        }}
      >
        {error && <Notice tone="danger">{error}</Notice>}
        <Input label="Temporary password" type="password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        <Input label="New password" type="password" required value={next} onChange={(e) => setNext(e.target.value)} />
        <PasswordRules value={next} />
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>Continue</Button>
        <Button variant="ghost" className="w-full" onClick={() => void signOut()}>Sign out</Button>
      </form>
    </AuthShell>
  );
}
