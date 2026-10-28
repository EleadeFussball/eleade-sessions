'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase, errorText } from '@/lib/supabase';
import { fmtDate } from '@/lib/dates';
import { useAdminTask } from '@/components/AdminFold';

type Reminder = {
  key: string; kind: 'renewal' | 'monthly' | 'elle'; title: string; details: string; bill_to: string; item: string;
  amount_ex: number; gst: number; total: number; due_from: string; player_id: string | null; done_at: string | null; dismissed: boolean;
  package_name: string | null; sessions: number | null; analyses: number | null; pairs: number | null;
  status: 'open' | 'waiting' | 'paid' | 'dismissed'; paid_at: string | null; ledger_id: string | null; payment_method: string | null;
};
const aud = (n: number) => `$${Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const n0 = (n: number | null) => Number(n ?? 0);
const METHODS: [string, string][] = [['bank', 'Bank transfer'], ['stripe', 'Stripe'], ['cash', 'Cash']];
const methodLabel = (m: string | null) => METHODS.find(([k]) => k === m)?.[1] ?? 'paid';
const PRESETS = [
  { name: '5 pack', s: 5, a: 0, price: 650 },
  { name: '10 pack', s: 10, a: 1, price: 1250 },
  { name: 'Monthly', s: 4, a: 1, price: 650 },
];

function contents(r: Pick<Reminder, 'sessions' | 'analyses' | 'pairs'>) {
  const parts = [`${n0(r.sessions)} session${n0(r.sessions) === 1 ? '' : 's'}`];
  if (n0(r.pairs)) parts.push(`${n0(r.pairs)} 2:1 session${n0(r.pairs) === 1 ? '' : 's'}`);
  if (n0(r.analyses)) parts.push(`${n0(r.analyses)} game ${n0(r.analyses) === 1 ? 'analysis' : 'analyses'}`);
  return parts.join(', ');
}

/** Jan only: invoices to raise in MYOB (package renewals, monthly packages, the weekly Elle invoice). */
export function InvoiceReminders() {
  const [rows, setRows] = useState<Reminder[]>([]);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('invoice_reminders');
    if (error) setErr(errorText(error)); else { setErr(''); setRows((data as Reminder[]) ?? []); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function run(key: string, fn: () => PromiseLike<{ error: unknown }>) {
    setBusy(key); setErr('');
    const { error } = await fn();
    setBusy('');
    if (error) setErr(errorText(error)); else { setEditing(null); load(); }
  }

  const open = rows.filter((r) => r.status === 'open');
  const waiting = rows.filter((r) => r.status === 'waiting');
  const done = rows.filter((r) => r.status === 'paid' || r.status === 'dismissed');
  useAdminTask('myob', 'fold-myob', 'Invoices to send in MYOB', open.length, 10);

  return (
    <section>
      <h2>Invoices to send in MYOB ({open.length})</h2>
      {err && <div className="notice err" role="alert">{err}</div>}
      {open.length === 0 ? <p className="empty">Nothing to invoice right now.</p> : (
        <ul className="list">{open.map((r) => (
          <li key={r.key} className="session">
            <div className="head"><span>{r.title}</span><span className={r.kind === 'elle' ? 'tag' : 'tag amber'}>{r.kind === 'elle' ? 'Elle' : r.kind === 'monthly' ? 'Monthly' : 'Renewal'}</span></div>
            <div className="sub" style={{ whiteSpace: 'pre-wrap' }}>{r.details}</div>
            {r.kind !== 'elle' && <div className="sub"><strong>Package:</strong> {r.package_name ?? 'Tailored'}, {contents(r)}</div>}
            <div className="mt">{Number(r.amount_ex) === 0
              ? <span className="tag amber">Price not set: tap Edit package</span>
              : <><strong>{aud(r.amount_ex)}</strong> + GST {aud(r.gst)} = <strong>{aud(r.total)}</strong></>}
              {r.kind === 'monthly' && <span className="hint"> · for the month from {fmtDate(r.due_from)}</span>}</div>
            {editing === r.key ? (
              <PackageEditor r={r} busy={busy === r.key} onCancel={() => setEditing(null)}
                onSave={(v) => run(r.key, () => supabase.rpc('save_reminder_package', { p_key: r.key, p_package_name: v.name, p_sessions: v.s, p_analyses: v.a, p_pairs: v.p, p_amount_ex: v.price }))} />
            ) : (
              <div className="row mt" style={{ flexWrap: 'wrap' }}>
                {r.kind !== 'elle' && <button type="button" className="btn small ghost" onClick={() => setEditing(r.key)}>Edit package</button>}
                <button type="button" className="btn small" disabled={busy === r.key || Number(r.amount_ex) === 0}
                  onClick={() => run(r.key, () => supabase.rpc('send_reminder', { p_key: r.key, p_dismiss: false }))}>Sent in MYOB</button>
                <button type="button" className="btn small ghost" disabled={busy === r.key}
                  onClick={() => run(r.key, () => supabase.rpc('send_reminder', { p_key: r.key, p_dismiss: true }))}>Not needed</button>
                {r.player_id && <Link className="btn small ghost" href={`/players/${r.player_id}`}>Open player</Link>}
              </div>
            )}
          </li>
        ))}</ul>
      )}

      {waiting.length > 0 && (
        <>
          <h3 className="mt">Sent, waiting for payment ({waiting.length})</h3>
          <ul className="list">{waiting.map((r) => (
            <li key={r.key} className="session">
              <div className="head"><span>{r.title}</span><span className="tag amber">Waiting</span></div>
              <div className="sub">{r.kind !== 'elle' ? `${r.package_name ?? 'Package'}: ${contents(r)} · ` : ''}{aud(r.total)} inc GST · sent {fmtDate(r.done_at!.slice(0, 10))}</div>
              {r.ledger_id && <p className="hint">The credits are already on the player. They show as payment awaiting until you confirm it. To change the sessions or price, or delete the package, open the player and tap Edit or delete package.</p>}
              <div className="row mt" style={{ flexWrap: 'wrap' }}>
                <span className="hint" style={{ alignSelf: 'center' }}>Paid by:</span>
                {METHODS.map(([m, label]) => (
                  <button key={m} type="button" className="btn small" disabled={busy === r.key}
                    onClick={() => run(r.key, () => supabase.rpc('reminder_paid', { p_key: r.key, p_paid: true, p_method: m }))}>{label}</button>
                ))}
                <button type="button" className="btn small ghost" disabled={busy === r.key} onClick={() => run(r.key, () => supabase.rpc('undo_reminder', { p_key: r.key }))}>Undo sent</button>
                {r.player_id && <Link className="btn small ghost" href={`/players/${r.player_id}`}>Open player</Link>}
              </div>
            </li>
          ))}</ul>
        </>
      )}

      <p className="hint mt">Prices ex GST: 5 pack $650, 10 pack $1,250 (with 1 game analysis), monthly $650 (4 sessions and 1 game analysis). Tap Edit package to change what goes on the invoice. Sent in MYOB adds the package to the player straight away (payment awaiting), so there is no need to record it on the player page; once the money is in, tap how it was paid: bank transfer, Stripe or cash. A renewal shows up when a family has one credit or less left; a recurring monthly package 5 days before the next month; Elle once the week is over.</p>
      {done.length > 0 && (
        <>
          <button type="button" className="linkbtn" onClick={() => setShowDone(!showDone)}>{showDone ? 'Hide' : 'Show'} handled in the last 14 days ({done.length})</button>
          {showDone && <ul className="list mt">{done.map((r) => (
            <li key={r.key} className="session"><div className="head"><span>{r.title}</span><span className={r.status === 'dismissed' ? 'tag' : 'tag turf'}>{r.status === 'dismissed' ? 'Not needed' : 'Paid'}</span></div>
              <div className="sub">{aud(r.total)} inc GST · {r.status === 'paid' && r.paid_at ? `${methodLabel(r.payment_method)} ${fmtDate(r.paid_at.slice(0, 10))}` : `marked ${fmtDate(r.done_at!.slice(0, 10))}`} ·{' '}
                {r.status === 'paid'
                  ? <button type="button" className="linkbtn" onClick={() => run(r.key, () => supabase.rpc('reminder_paid', { p_key: r.key, p_paid: false }))}>Not paid after all</button>
                  : <button type="button" className="linkbtn" onClick={() => run(r.key, () => supabase.rpc('undo_reminder', { p_key: r.key }))}>Undo</button>}</div></li>
          ))}</ul>}
        </>
      )}
    </section>
  );
}

function PackageEditor({ r, busy, onSave, onCancel }: {
  r: Reminder; busy: boolean; onCancel: () => void;
  onSave: (v: { name: string; s: number; a: number; p: number; price: number }) => void;
}) {
  const [name, setName] = useState(r.package_name && PRESETS.some((x) => x.name === r.package_name) ? r.package_name : 'Tailored');
  const [s, setS] = useState(String(n0(r.sessions)));
  const [a, setA] = useState(String(n0(r.analyses)));
  const [p, setP] = useState(String(n0(r.pairs)));
  const [price, setPrice] = useState(String(Number(r.amount_ex) || ''));
  const num = (x: string) => { const v = Number(x.replace(',', '.')); return Number.isFinite(v) ? v : 0; };
  function pick(n: string) {
    setName(n);
    const k = PRESETS.find((x) => x.name === n);
    if (k) { setS(String(k.s)); setA(String(k.a)); setP('0'); setPrice(String(k.price)); }
  }
  const ex = num(price);
  return (
    <div className="panel mt">
      <div className="seg" style={{ marginBottom: 12 }}>
        {[...PRESETS.map((x) => x.name), 'Tailored'].map((n) => <button key={n} type="button" aria-pressed={name === n} onClick={() => pick(n)}>{n}</button>)}
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="field" style={{ flex: '1 1 90px' }}><span>Sessions</span>
          <input type="text" inputMode="numeric" value={s} onChange={(e) => { setS(e.target.value); setName('Tailored'); }} /></label>
        <label className="field" style={{ flex: '1 1 90px' }}><span>Game analyses</span>
          <input type="text" inputMode="numeric" value={a} onChange={(e) => { setA(e.target.value); setName('Tailored'); }} /></label>
        <label className="field" style={{ flex: '1 1 90px' }}><span>2:1 sessions</span>
          <input type="text" inputMode="numeric" value={p} onChange={(e) => { setP(e.target.value); setName('Tailored'); }} /></label>
        <label className="field" style={{ flex: '1 1 120px' }}><span>Price ex GST</span>
          <input type="text" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
      </div>
      <p className="hint">{ex > 0 ? `${aud(ex)} + GST ${aud(ex * 0.1)} = ${aud(ex * 1.1)}` : 'Add the price.'}</p>
      <div className="row">
        <button type="button" className="btn small" disabled={busy} onClick={() => onSave({ name, s: num(s), a: num(a), p: num(p), price: ex })}>{busy ? 'Saving' : 'Save package'}</button>
        <button type="button" className="btn small ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
