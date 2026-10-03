'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { digits, validAbn } from '@/lib/bank';

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

      {coach && !coach.salaried && <InvoiceDetails coachId={coach.id} />}

      <h2>Sign out</h2>
      <p className="hint">You stay signed in on this phone until you sign out.</p>
      <button className="btn ghost" type="button" onClick={signOut}>Sign out</button>
    </>
  );
}

function InvoiceDetails({ coachId }: { coachId: string }) {
  const [legal, setLegal] = useState('');
  const [abn, setAbn] = useState('');
  const [bsb, setBsb] = useState('');
  const [acct, setAcct] = useState('');
  const [acctName, setAcctName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    supabase.from('coach_details').select('*').eq('coach_id', coachId).maybeSingle().then(({ data }) => {
      if (!data) return;
      setLegal(data.legal_name ?? ''); setAbn(data.abn ?? ''); setBsb(data.bsb ?? '');
      setAcct(data.account_number ?? ''); setAcctName(data.account_name ?? '');
    });
  }, [coachId]);

  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setMsg('');
    const a = digits(abn), b = digits(bsb), n = digits(acct);
    if (!legal.trim()) { setErr('Add your full name as it appears on your ABN.'); return; }
    if (!validAbn(a)) { setErr('That ABN is not valid. It has 11 digits; check it on abr.business.gov.au.'); return; }
    if (b.length !== 6) { setErr('A BSB has 6 digits.'); return; }
    if (n.length < 4 || n.length > 9) { setErr('An account number has 4 to 9 digits.'); return; }
    if (!acctName.trim()) { setErr('Add the account name.'); return; }
    setBusy(true);
    const { error } = await supabase.from('coach_details').upsert({
      coach_id: coachId, legal_name: legal.trim(), abn: a, bsb: b, account_number: n, account_name: acctName.trim(),
      updated_at: new Date().toISOString(),
    });
    setBusy(false);
    if (error) setErr(errorText(error));
    else { setAbn(a); setBsb(b); setAcct(n); setMsg('Saved. Your invoices use these details, and Jan pays into this account.'); }
  }

  return (
    <>
      <h2>Invoice details</h2>
      <p className="hint">Used on the invoices you submit under My week. Only you and Jan can see them.</p>
      <form onSubmit={save}>
        <label className="field"><span>Full name (as on your ABN)</span>
          <input type="text" autoComplete="name" value={legal} onChange={(e) => setLegal(e.target.value)} /></label>
        <label className="field"><span>ABN</span>
          <input type="text" inputMode="numeric" value={abn} onChange={(e) => setAbn(e.target.value)} placeholder="11 digits" /></label>
        <div className="row">
          <label className="field" style={{ flex: '0 0 130px' }}><span>BSB</span>
            <input type="text" inputMode="numeric" value={bsb} onChange={(e) => setBsb(e.target.value)} placeholder="000-000" /></label>
          <label className="field"><span>Account number</span>
            <input type="text" inputMode="numeric" value={acct} onChange={(e) => setAcct(e.target.value)} /></label>
        </div>
        <label className="field"><span>Account name</span>
          <input type="text" value={acctName} onChange={(e) => setAcctName(e.target.value)} /></label>
        {err && <div className="notice err" role="alert">{err}</div>}
        {msg && <div className="notice ok" role="status">{msg}</div>}
        <button className="btn block" disabled={busy}>{busy ? 'Saving' : 'Save invoice details'}</button>
      </form>
    </>
  );
}
