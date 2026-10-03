'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';

const DEV = process.env.NEXT_PUBLIC_DEV_LOGIN === '1';

export default function LoginPage() {
  const { session } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { if (session) router.replace('/log'); }, [session, router]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr('');
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: true, emailRedirectTo: window.location.origin + '/log' },
    });
    setBusy(false);
    if (error) setErr(error.message.includes('Signups not allowed')
      ? 'This email is not set up as an Eleade coach. Ask Jan to invite you.'
      : errorText(error));
    else setSent(true);
  }

  async function devLogin(who: string) {
    const r = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/dev/token?email=${encodeURIComponent(who)}`);
    const t = await r.json();
    const { error } = await supabase.auth.setSession({ access_token: t.access_token, refresh_token: t.refresh_token });
    if (error) setErr(errorText(error));
  }

  return (
    <main className="page narrow">
      <div className="brand" style={{ fontSize: '2.6rem' }}>eleade</div>
      <p className="muted">Session log for coaches</p>
      {sent ? (
        <div className="notice ok mt">
          Check your email. We sent a sign-in link to <strong>{email}</strong>. Open it on this phone to sign in.
        </div>
      ) : (
        <form onSubmit={send} className="mt">
          <label className="field">
            <span>Your email</span>
            <input type="email" required autoComplete="email" inputMode="email" value={email}
                   onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
          </label>
          <button className="btn block" disabled={busy}>{busy ? 'Sending' : 'Email me a sign-in link'}</button>
        </form>
      )}
      {err && <div className="notice err">{err}</div>}
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
