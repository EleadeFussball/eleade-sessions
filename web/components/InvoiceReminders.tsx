'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase, errorText } from '@/lib/supabase';
import { fmtDate } from '@/lib/dates';

type Reminder = {
  key: string; kind: 'renewal' | 'monthly' | 'elle'; title: string; details: string; bill_to: string; item: string;
  amount_ex: number; gst: number; total: number; due_from: string; player_id: string | null; done_at: string | null; dismissed: boolean;
};
const aud = (n: number) => `$${Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Jan only: invoices to raise in MYOB (package renewals, monthly packages, the weekly Elle invoice). */
export function InvoiceReminders() {
  const [rows, setRows] = useState<Reminder[]>([]);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState('');
  const [showDone, setShowDone] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('invoice_reminders');
    if (error) setErr(errorText(error)); else { setErr(''); setRows((data as Reminder[]) ?? []); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function mark(r: Reminder, done: boolean, dismissed = false) {
    const { error } = done
      ? await supabase.from('invoice_reminders_done').insert({ key: r.key, dismissed })
      : await supabase.from('invoice_reminders_done').delete().eq('key', r.key);
    if (error) setErr(errorText(error)); else load();
  }

  async function copy(r: Reminder) {
    const text = [`Bill to: ${r.bill_to}`, `Item: ${r.item}`, r.details, `Amount ex GST: ${aud(r.amount_ex)}`, `GST: ${aud(r.gst)}`, `Total inc GST: ${aud(r.total)}`].join('\n');
    try { await navigator.clipboard.writeText(text); setCopied(r.key); setTimeout(() => setCopied(''), 2000); } catch { /* ignore */ }
  }

  const open = rows.filter((r) => !r.done_at);
  const done = rows.filter((r) => r.done_at);

  return (
    <section>
      <h2>Invoices to send in MYOB ({open.length})</h2>
      {err && <div className="notice err" role="alert">{err}</div>}
      {open.length === 0 ? <p className="empty">Nothing to invoice right now.</p> : (
        <ul className="list">{open.map((r) => (
          <li key={r.key} className="session">
            <div className="head"><span>{r.title}</span><span className={r.kind === 'elle' ? 'tag' : 'tag amber'}>{r.kind === 'elle' ? 'Elle' : r.kind === 'monthly' ? 'Monthly' : 'Renewal'}</span></div>
            <div className="sub" style={{ whiteSpace: 'pre-wrap' }}>{r.details}</div>
            <div className="mt">{Number(r.amount_ex) === 0
              ? <span className="tag amber">Price not known: older tailored package, check before invoicing</span>
              : <><strong>{aud(r.amount_ex)}</strong> + GST {aud(r.gst)} = <strong>{aud(r.total)}</strong></>}
              {r.kind === 'monthly' && <span className="hint"> · for the month from {fmtDate(r.due_from)}</span>}</div>
            <div className="row mt" style={{ flexWrap: 'wrap' }}>
              <button type="button" className="btn small ghost" onClick={() => copy(r)}>{copied === r.key ? 'Copied' : 'Copy details'}</button>
              <button type="button" className="btn small" onClick={() => mark(r, true)}>Sent in MYOB</button>
              <button type="button" className="btn small ghost" onClick={() => mark(r, true, true)}>Not needed</button>
              {r.player_id && <Link className="btn small ghost" href={`/players/${r.player_id}`}>Open player</Link>}
            </div>
          </li>
        ))}</ul>
      )}
      <p className="hint mt">Prices ex GST: 5 pack $650, 10 pack $1,250 (with 1 game analysis), monthly $650 (4 sessions and 1 game analysis). A renewal shows up when a family has one credit or less left (tap Not needed if they stop or pay another way); a recurring monthly package 5 days before the next month; Elle once the week is over. When the payment arrives, record the package on the player page as usual.</p>
      {done.length > 0 && (
        <>
          <button type="button" className="linkbtn" onClick={() => setShowDone(!showDone)}>{showDone ? 'Hide' : 'Show'} handled in the last 14 days ({done.length})</button>
          {showDone && <ul className="list mt">{done.map((r) => (
            <li key={r.key} className="session"><div className="head"><span>{r.title}</span><span className={r.dismissed ? 'tag' : 'tag turf'}>{r.dismissed ? 'Not needed' : 'Sent'}</span></div>
              <div className="sub">{aud(r.total)} inc GST · marked {fmtDate(r.done_at!.slice(0, 10))} · <button type="button" className="linkbtn" onClick={() => mark(r, false)}>Undo</button></div></li>
          ))}</ul>}
        </>
      )}
    </section>
  );
}
