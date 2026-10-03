'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';

const DEV = process.env.NEXT_PUBLIC_DEV_LOGIN === '1';

export default function LoginPage() {
  const { session } = useAuth();
  const router = useRouter();
  const [mode, setMode] = useState<'password' | 'link'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { if (session) router.replace('/log'); }, [session, router]);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr('');
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) {
      setErr(/invalid login/i.test(error.message)
        ? 'Email or password is wrong. First time here, or forgot your password? Use “Email me a sign-in link” below.'
        : errorText(error));
    }
  }

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr('');
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: true, emailRedirectTo: window.location.origin + '/account' },
    });
    setBusy(false);
    if (error) setErr(errorText(error)); else setSent(true);
  }

  async function devLogin(who: string) {
    const r = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/dev/token?email=${encodeURIComponent(who)}`);
    const t = await r.json();
    const { error } = await supabase.auth.setSession({ access_token: t.access_token, refresh_token: t.refresh_token });
    if (error) setErr(errorText(error));
  }

  return (
    <main className="page narrow">
      <img src="/eleade-logo.svg" alt="eleade" className="login-logo" />
      <p className="claim">Football knowledge made in Germany</p>
      <h1 style={{ fontSize: '1.5rem' }}>Coach sign in</h1>

      {mode === 'password' ? (
        <form onSubmit={signIn} className="mt">
          <label className="field">
            <span>Email</span>
            <input type="email" required autoComplete="email" inputMode="email" value={email}
                   onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
          </label>
          <label className="field">
            <span>Password</span>
            <input type="password" required autoComplete="current-password" value={password}
                   onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button className="btn block" disabled={busy}>{busy ? 'Signing in' : 'Sign in'}</button>
          <p className="hint mt">
            First time, or forgot your password?{' '}
            <button type="button" className="linkbtn" onClick={() => { setMode('link'); setErr(''); }}>Email me a sign-in link</button>
          </p>
        </form>
      ) : sent ? (
        <div className="notice ok mt">
          Check your email. We sent a sign-in link to <strong>{email}</strong>. Open it on this phone, then set your password.
        </div>
      ) : (
        <form onSubmit={sendLink} className="mt">
          <p>We&apos;ll email you a one-time link. After signing in, you set a password so you won&apos;t need the email again.</p>
          <label className="field">
            <span>Email</span>
            <input type="email" required autoComplete="email" inputMode="email" value={email}
                   onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
          </label>
          <button className="btn block" disabled={busy}>{busy ? 'Sending' : 'Email me a sign-in link'}</button>
          <p className="hint mt"><button type="button" className="linkbtn" onClick={() => { setMode('password'); setErr(''); }}>Back to password sign-in</button></p>
        </form>
      )}
      {err && <div className="notice err" role="alert">{err}</div>}

      {DEV && (
        <div className="mt">
          <p className="hint">Local test logins</p>
          <div className="seg">
            {['info@eleadefussball.com', 'tyler@test.local', 'paul@test.local', 'david@test.local'].map((w) => (
              <button key={w} type="button" onClick={() => devLogin(w)}>{w.split('@')[0]}</button>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
