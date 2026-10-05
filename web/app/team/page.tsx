'use client';
import { useCallback, useEffect, useState } from 'react';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import type { Coach } from '@/lib/types';
import { digits, validAbn } from '@/lib/bank';
import { EnquiryWebhook } from '@/components/EnquiryWebhook';

type Rates = { coach_id: string; one_to_one: number | null; two_to_one: number; four_to_one: number; analysis: number; testing: number; assessment: number | null };
const RATE_FIELDS: [keyof Omit<Rates, 'coach_id'>, string][] = [
  ['one_to_one', '1:1'], ['two_to_one', '2:1'], ['four_to_one', '4:1'], ['analysis', 'Analysis'], ['assessment', 'Assessment'], ['testing', 'Testing'],
];

export default function TeamPage() {
  const { isAdmin, coaches, refreshCoaches } = useAuth();
  const [rates, setRates] = useState<Record<string, Rates>>({});
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');

  const load = useCallback(async () => {
    const { data } = await supabase.from('coach_rates').select('*');
    setRates(Object.fromEntries(((data as Rates[]) ?? []).map((r) => [r.coach_id, r])));
  }, []);
  useEffect(() => { if (isAdmin) load(); }, [isAdmin, load]);
  if (!isAdmin) return <p className="empty">This page is for Jan.</p>;

  async function addCoach(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setMsg('');
    const { data, error } = await supabase.from('coaches').insert({ name: newName.trim(), email: newEmail.trim().toLowerCase() || null }).select().single();
    if (error) { setErr(errorText(error)); return; }
    await supabase.from('coach_rates').insert({ coach_id: (data as Coach).id });
    setNewName(''); setNewEmail(''); setMsg(`${(data as Coach).name} added. Set their 1:1 rate below, then send them the app link to sign in.`);
    await refreshCoaches(); load();
  }

  return (
    <>
      <h1>Team</h1>
      <p className="muted">Coaches sign in with the email you enter here. Rates are per session, ex GST, and only you and that coach can see them. A blank assessment rate pays the coach&apos;s 1:1 rate.</p>
      {msg && <div className="notice ok">{msg}</div>}
      {err && <div className="notice err">{err}</div>}
      <ul className="list">
        {coaches.map((c) => <CoachRow key={c.id} c={c} r={rates[c.id]} onSaved={async (m) => { setMsg(m); setErr(''); await refreshCoaches(); load(); }} onError={setErr} />)}
      </ul>
      <BusinessDetails />
      <EnquiryWebhook />
      <details className="panel">
        <summary>Add a coach</summary>
        <form onSubmit={addCoach}>
          <div className="row">
            <label className="field"><span>Name</span><input type="text" required value={newName} onChange={(e) => setNewName(e.target.value)} /></label>
            <label className="field"><span>Email</span><input type="email" required value={newEmail} onChange={(e) => setNewEmail(e.target.value)} /></label>
          </div>
          <button className="btn small">Add coach</button>
        </form>
      </details>
    </>
  );
}

function CoachRow({ c, r, onSaved, onError }: { c: Coach; r?: Rates; onSaved: (m: string) => void; onError: (m: string) => void }) {
  const [email, setEmail] = useState(c.email ?? '');
  const [active, setActive] = useState(c.active);
  const [salaried, setSalaried] = useState(c.salaried);
  const [separate, setSeparate] = useState(c.paid_separately);
  const [vals, setVals] = useState<Record<string, string>>({});
  useEffect(() => {
    if (r) setVals(Object.fromEntries(RATE_FIELDS.map(([k]) => [k, r[k] === null ? '' : String(r[k])])));
  }, [r]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const c1 = await supabase.from('coaches').update({ email: email.trim().toLowerCase() || null, active, salaried, paid_separately: separate }).eq('id', c.id);
    if (c1.error) { onError(errorText(c1.error)); return; }
    const body = Object.fromEntries(RATE_FIELDS.map(([k]) => [k, vals[k] === '' ? (k === 'one_to_one' || k === 'assessment' ? null : 0) : Number(vals[k])]));
    const c2 = await supabase.from('coach_rates').upsert({ coach_id: c.id, ...body, updated_at: new Date().toISOString() });
    if (c2.error) { onError(errorText(c2.error)); return; }
    onSaved(`${c.name} saved.`);
  }

  return (
    <li className="session">
      <form onSubmit={save}>
        <div className="head">
          <span>{c.name}{c.is_admin ? ' (admin)' : ''}</span>
          <span className={c.user_id ? 'tag turf' : 'tag amber'}>{c.user_id ? 'Signed in before' : 'Not signed in yet'}</span>
        </div>
        <div className="row mt">
          <label className="field"><span>Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {RATE_FIELDS.map(([k, l]) => (
            <label key={k} className="field" style={{ flex: '1 1 90px' }}><span>{l} $</span>
              <input type="number" step="0.5" value={vals[k] ?? ''} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} /></label>
          ))}
        </div>
        <div className="row" style={{ alignItems: 'center' }}>
          <label className="field" style={{ display: 'flex', gap: 10, alignItems: 'center', margin: 0 }}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} style={{ width: 22, height: 22 }} />
            <span style={{ margin: 0 }}>Active</span>
          </label>
          <label className="field" style={{ display: 'flex', gap: 10, alignItems: 'center', margin: 0 }}>
            <input type="checkbox" checked={salaried} onChange={(e) => setSalaried(e.target.checked)} style={{ width: 22, height: 22 }} />
            <span style={{ margin: 0 }}>Salaried (no invoices)</span>
          </label>
          <label className="field" style={{ display: 'flex', gap: 10, alignItems: 'center', margin: 0 }}>
            <input type="checkbox" checked={separate} onChange={(e) => setSeparate(e.target.checked)} style={{ width: 22, height: 22 }} />
            <span style={{ margin: 0 }}>Paid separately (invoice needs no ABN or bank details)</span>
          </label>
          <button className="btn small" style={{ flex: '0 0 auto' }}>Save {c.name}</button>
        </div>
      </form>
    </li>
  );
}

function BusinessDetails() {
  const [name, setName] = useState('');
  const [abn, setAbn] = useState('');
  const [bsb, setBsb] = useState('');
  const [acct, setAcct] = useState('');
  const [acctName, setAcctName] = useState('');
  const [userId, setUserId] = useState('000000');
  const [remitter, setRemitter] = useState('ELEADE');
  const [stripeLink, setStripeLink] = useState('');
  const [sessionLink, setSessionLink] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    supabase.from('settings').select('key, value').in('key', ['business_name', 'business_abn', 'stripe_assessment_link', 'stripe_session_link']).then(({ data }) => {
      for (const r of (data as { key: string; value: string }[]) ?? []) {
        if (r.key === 'business_name') setName(r.value ?? '');
        else if (r.key === 'business_abn') setAbn(r.value ?? '');
        else if (r.key === 'stripe_session_link') setSessionLink(r.value ?? '');
        else setStripeLink(r.value ?? '');
      }
    });
    supabase.from('bank_file_settings').select('*').maybeSingle().then(({ data }) => {
      if (!data) return;
      setBsb(data.bsb ?? ''); setAcct(data.account_number ?? ''); setAcctName(data.account_name ?? '');
      setUserId(data.user_id_number ?? '000000'); setRemitter(data.remitter_name ?? 'ELEADE');
    });
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setMsg('');
    const a = digits(abn), b = digits(bsb), n = digits(acct), u = digits(userId);
    if (a && !validAbn(a)) { setErr('That ABN is not valid.'); return; }
    if (b && b.length !== 6) { setErr('A BSB has 6 digits.'); return; }
    if (n && (n.length < 4 || n.length > 9)) { setErr('An account number has 4 to 9 digits.'); return; }
    const sl = stripeLink.trim();
    if (sl && !/^https:\/\/(buy\.stripe\.com|checkout\.stripe\.com)\//.test(sl)) { setErr('The Stripe link should start with https://buy.stripe.com/'); return; }
    const ss = sessionLink.trim();
    if (ss && !/^https:\/\/(buy\.stripe\.com|checkout\.stripe\.com)\//.test(ss)) { setErr('The Stripe session link should start with https://buy.stripe.com/'); return; }
    if (u.length !== 6) { setErr('The User ID has 6 digits. Use 000000 if NAB has not given you one.'); return; }
    const s1 = await supabase.from('settings').upsert([{ key: 'business_name', value: name.trim() || 'Eleade' }, { key: 'business_abn', value: a }, { key: 'stripe_assessment_link', value: sl }, { key: 'stripe_session_link', value: ss }]);
    if (s1.error) { setErr(errorText(s1.error)); return; }
    const s2 = await supabase.from('bank_file_settings').update({
      bsb: b || null, account_number: n || null, account_name: acctName.trim() || null, user_id_number: u,
      remitter_name: remitter.trim() || 'ELEADE', updated_at: new Date().toISOString(),
    }).eq('id', true);
    if (s2.error) { setErr(errorText(s2.error)); return; }
    setAbn(a); setBsb(b); setAcct(n); setUserId(u);
    setMsg('Saved.');
  }

  return (
    <details className="panel">
      <summary>Eleade details: invoices, NAB payment file, Stripe link</summary>
      <form onSubmit={save}>
        <p className="hint">The business name and ABN appear as &quot;To&quot; on coach invoices. The account below is the one coaches are paid from; only you can see it.</p>
        <div className="row">
          <label className="field"><span>Business name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field"><span>ABN</span><input type="text" inputMode="numeric" value={abn} onChange={(e) => setAbn(e.target.value)} /></label>
        </div>
        <div className="row">
          <label className="field" style={{ flex: '0 0 130px' }}><span>NAB BSB</span><input type="text" inputMode="numeric" value={bsb} onChange={(e) => setBsb(e.target.value)} /></label>
          <label className="field"><span>Account number</span><input type="text" inputMode="numeric" value={acct} onChange={(e) => setAcct(e.target.value)} /></label>
        </div>
        <label className="field"><span>Account name</span><input type="text" value={acctName} onChange={(e) => setAcctName(e.target.value)} /></label>
        <div className="row">
          <label className="field"><span>Name on coaches&apos; statements</span><input type="text" maxLength={16} value={remitter} onChange={(e) => setRemitter(e.target.value)} /></label>
          <label className="field" style={{ flex: '0 0 130px' }}><span>User ID</span><input type="text" inputMode="numeric" value={userId} onChange={(e) => setUserId(e.target.value)} /></label>
        </div>
        <p className="hint">Leave the User ID as 000000 unless NAB has given you a Direct Entry User ID.</p>
        <label className="field"><span>Stripe payment link for assessments</span>
          <input type="url" value={stripeLink} onChange={(e) => setStripeLink(e.target.value)} placeholder="https://buy.stripe.com/..." /></label>
        <p className="hint">Coaches send this from the player&apos;s page. Each link is tagged with the player, so the payment confirms their assessment automatically.</p>
        <label className="field"><span>Stripe payment link for single sessions <span className="hint">(optional)</span></span>
          <input type="url" value={sessionLink} onChange={(e) => setSessionLink(e.target.value)} placeholder="https://buy.stripe.com/..." /></label>
        <p className="hint">Add it and coaches can send a session link that is tagged with the player too. Without it, a session payment arrives untagged and you say who paid on the Admin page.</p>
        {err && <div className="notice err" role="alert">{err}</div>}
        {msg && <div className="notice ok" role="status">{msg}</div>}
        <button className="btn small">Save details</button>
      </form>
    </details>
  );
}
