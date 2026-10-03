'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';

export default function AccountPage() {
  const { session, coach } = useAuth();
  const router = useRouter();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const hasPassword = !!session?.user.user_metadata?.password_set;

  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setMsg('');
    if (pw.length < 8) { setErr('Use at least 8 characters.'); return; }
    if (pw !== pw2) { setErr('The two passwords don’t match.'); return; }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw, data: { password_set: true } });
    setBusy(false);
    if (error) setErr(errorText(error));
    else { setPw(''); setPw2(''); setMsg('Password saved. Next time, sign in with your email and this password.'); }
  }

  async function signOut() {
    await supabase.auth.signOut();
    router.replace('/login');
  }

  return (
    <>
      <h1>Account</h1>
      <p className="muted">{coach?.name}, signed in as {session?.user.email}</p>

      <h2>{hasPassword ? 'Change password' : 'Set your password'}</h2>
      {!hasPassword && <p>Set a password once, and you can sign in on any phone without waiting for an email.</p>}
      <form onSubmit={save}>
        <label className="field"><span>New password</span>
          <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></label>
        <label className="field"><span>Type it again</span>
          <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required /></label>
        {err && <div className="notice err" role="alert">{err}</div>}
        {msg && <div className="notice ok" role="status">{msg}</div>}
        <button className="btn block" disabled={busy}>{busy ? 'Saving' : 'Save password'}</button>
      </form>

      <h2>Sign out</h2>
      <p className="hint">You stay signed in on this phone until you sign out.</p>
      <button className="btn ghost" type="button" onClick={signOut}>Sign out</button>
    </>
  );
}
