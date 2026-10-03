'use client';
import { useCallback, useEffect, useState } from 'react';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import type { Coach } from '@/lib/types';

type Rates = { coach_id: string; one_to_one: number | null; two_to_one: number; four_to_one: number; analysis: number; testing: number };
const RATE_FIELDS: [keyof Omit<Rates, 'coach_id'>, string][] = [
  ['one_to_one', '1:1'], ['two_to_one', '2:1'], ['four_to_one', '4:1'], ['analysis', 'Analysis'], ['testing', 'Testing'],
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
      <p className="muted">Coaches sign in with the email you enter here. Rates are per session, ex GST, and only you and that coach can see them.</p>
      {msg && <div className="notice ok">{msg}</div>}
      {err && <div className="notice err">{err}</div>}
      <ul className="list">
        {coaches.map((c) => <CoachRow key={c.id} c={c} r={rates[c.id]} onSaved={async (m) => { setMsg(m); setErr(''); await refreshCoaches(); load(); }} onError={setErr} />)}
      </ul>
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
  const [vals, setVals] = useState<Record<string, string>>({});
  useEffect(() => {
    if (r) setVals(Object.fromEntries(RATE_FIELDS.map(([k]) => [k, r[k] === null ? '' : String(r[k])])));
  }, [r]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const c1 = await supabase.from('coaches').update({ email: email.trim().toLowerCase() || null, active }).eq('id', c.id);
    if (c1.error) { onError(errorText(c1.error)); return; }
    const body = Object.fromEntries(RATE_FIELDS.map(([k]) => [k, vals[k] === '' ? (k === 'one_to_one' ? null : 0) : Number(vals[k])]));
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
          <button className="btn small" style={{ flex: '0 0 auto' }}>Save {c.name}</button>
        </div>
      </form>
    </li>
  );
}
