'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { addDays, fmtDate, fmtWeek, money, todayISO, weekStart } from '@/lib/dates';
import { FORMAT_LABEL, OUTCOME_LABEL, invoiceNo, type CoachInvoice, type Format, type InvoiceLine, type Outcome } from '@/lib/types';

type PayRow = { session_id: string; session_date: string; coach_id: string; coach_name: string;
  format: Format; outcome: Outcome; players: string | null; pay: number | null; old?: boolean };

export default function WeekPage() {
  const { coach, coaches, isAdmin } = useAuth();
  const [start, setStart] = useState(weekStart(todayISO()));
  const [coachId, setCoachId] = useState('');
  const [paid, setPaid] = useState<PayRow[]>([]);
  const [old, setOld] = useState<PayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<InvoiceLine[]>([]);
  const [invoices, setInvoices] = useState<CoachInvoice[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const router = useRouter();

  useEffect(() => { if (coach && !coachId) setCoachId(coach.id); }, [coach, coachId]);
  const loadInvoices = useCallback(async () => {
    if (!coachId) return;
    const [d, i] = await Promise.all([
      supabase.rpc('invoice_draft', { p_coach_id: coachId, p_until: addDays(start, 6) }),
      supabase.from('coach_invoices').select('*').eq('coach_id', coachId).order('number', { ascending: false }).limit(12),
    ]);
    setDraft((d.data as InvoiceLine[]) ?? []);
    setInvoices((i.data as CoachInvoice[]) ?? []);
  }, [coachId, start]);
  useEffect(() => { loadInvoices(); }, [loadInvoices]);

  useEffect(() => {
    if (!coachId) return;
    setLoading(true); setErr('');
    const end = addDays(start, 6);
    Promise.all([
      supabase.from('coach_pay').select('*').eq('coach_id', coachId)
        .gte('session_date', start).lte('session_date', end).order('session_date'),
      // sessions from the old documentation file: shown, but paid through the old invoice
      supabase.from('sessions').select('id, session_date, coach_id, format, outcome, session_players(players(name))')
        .eq('coach_id', coachId).eq('imported', true).gte('session_date', start).lte('session_date', end),
    ]).then(([a, b]) => {
      setPaid((a.data as PayRow[]) ?? []);
      type OldRow = { id: string; session_date: string; coach_id: string; format: Format; outcome: Outcome;
        session_players: { players: { name: string } | { name: string }[] | null }[] };
      setOld(((b.data as unknown as OldRow[]) ?? []).map((r) => ({
        session_id: r.id, session_date: r.session_date, coach_id: r.coach_id, coach_name: '', format: r.format,
        outcome: r.outcome, pay: null, old: true,
        players: r.session_players.map((sp) => (Array.isArray(sp.players) ? sp.players[0]?.name : sp.players?.name) ?? '').join(', '),
      })));
      setLoading(false);
    });
  }, [coachId, start]);

  const name = coaches.find((c) => c.id === coachId)?.name ?? '';
  const rows = [...paid, ...old].sort((a, b) => a.session_date.localeCompare(b.session_date));
  const total = paid.reduce((t, r) => t + Number(r.pay ?? 0), 0);
  const missingRate = paid.some((r) => r.pay === null);
  const byFormat = rows.reduce<Record<string, number>>((m, r) => {
    if (r.outcome !== 'cancelled_in_time') m[r.format] = (m[r.format] ?? 0) + 1;
    return m;
  }, {});

  const selected = coaches.find((c) => c.id === coachId);
  const salaried = !!selected?.salaried;
  const weekEnd = addDays(start, 6);
  const weekOver = weekEnd <= todayISO();
  const draftTotal = draft.reduce((t, l) => t + Number(l.amount), 0);
  const draftNoRate = draft.some((l) => l.no_rate);
  const thisWeeks = invoices.filter((i) => i.period_end === weekEnd);

  async function submit() {
    if (!window.confirm(`Submit your invoice for ${money(draftTotal)} to Jan?`)) return;
    setBusy(true); setErr('');
    const { data, error } = await supabase.rpc('submit_invoice', { p_coach_id: coachId, p_until: weekEnd });
    setBusy(false);
    if (error) { setErr(errorText(error)); return; }
    router.push(`/invoices/${data as string}`);
  }

  return (
    <>
      <h1>{coachId === coach?.id ? 'My week' : `${name}'s week`}</h1>
      <div className="toolbar">
        <div className="weeknav">
          <button type="button" aria-label="Previous week" onClick={() => setStart(addDays(start, -7))}>‹</button>
          <span>{fmtWeek(start)}</span>
          <button type="button" aria-label="Next week" onClick={() => setStart(addDays(start, 7))} disabled={start >= weekStart(todayISO())}>›</button>
        </div>
        {isAdmin && (
          <select value={coachId} onChange={(e) => setCoachId(e.target.value)} aria-label="Coach" style={{ width: 'auto' }}>
            {coaches.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
      </div>

      {loading ? <p className="empty">Loading</p> : rows.length === 0 ? (
        <p className="empty">No sessions logged this week. Sessions you log appear here straight away.</p>
      ) : (
        <>
          <p className="muted">
            {Object.entries(byFormat).map(([f, n]) => `${n} × ${FORMAT_LABEL[f as Format]}`).join(', ')}
          </p>
          <table className="t">
            <thead><tr><th>Day</th><th>Player</th><th>Type</th>{!salaried && <th className="n">Pay</th>}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.session_id}>
                  <td>{fmtDate(r.session_date, true)}</td>
                  <td>{r.players}{r.outcome !== 'attended' && <><br /><span className="hint">{OUTCOME_LABEL[r.outcome]}</span></>}</td>
                  <td>{FORMAT_LABEL[r.format]}</td>
                  {!salaried && <td className="n">{r.old ? <span className="hint">Old invoice</span> : r.pay === null ? 'Rate not set' : money(r.pay)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          {salaried ? (
            <p className="hint mt">Salaried: sessions are tracked here, and no invoice is needed.</p>
          ) : (
            <>
              <div className="total"><span>Total for the week</span><span className="score">{money(total)}</span></div>
              {old.length > 0 && <p className="hint">{old.length} session{old.length > 1 ? 's' : ''} marked “Old invoice” came from the old documentation file. They were paid through the old invoice, so they aren&apos;t in this total.</p>}
              {missingRate && <div className="notice warn">Some session types have no pay rate yet. Jan sets rates on the Team page.</div>}
            </>
          )}
        </>
      )}

      {!salaried && !loading && (
        <>
          <h2>Invoice</h2>
          {thisWeeks.map((i) => (
            <p key={i.id}><Link href={`/invoices/${i.id}`}>Invoice {invoiceNo(i)}</Link>, {money(i.total)}{' '}
              <span className={i.status === 'paid' ? 'tag turf' : 'tag amber'}>{i.status === 'paid' ? 'Paid' : 'Submitted'}</span></p>
          ))}
          {draft.length === 0 ? (
            thisWeeks.length === 0 && <p className="empty">Nothing to invoice for this week.</p>
          ) : (
            <>
              <p className="hint">{thisWeeks.length ? 'Not on an invoice yet:' : 'Your invoice for this week will contain:'}</p>
              <table className="t">
                <tbody>{draft.map((l, k) => (
                  <tr key={k}><td>{fmtDate(l.line_date, true)}</td><td>{l.description}</td>
                    <td className="n">{l.no_rate ? 'Rate not set' : money(l.amount)}</td></tr>
                ))}</tbody>
                <tfoot><tr><td></td><td>Total (no GST)</td><td className="n">{money(draftTotal)}</td></tr></tfoot>
              </table>
              {draft.some((l) => l.line_date < start) && <p className="hint">Includes earlier sessions that were logged late or changed after an invoice.</p>}
              {err && <div className="notice err" role="alert">{err}</div>}
              {coachId !== coach?.id && !isAdmin ? null : !weekOver ? (
                <p className="hint">You can submit this invoice on Sunday, once the week is over.</p>
              ) : draftNoRate ? (
                <div className="notice warn">Some session types have no pay rate yet. Jan sets rates on the Team page.</div>
              ) : draftTotal <= 0 ? (
                <p className="hint">Nothing to pay for this week.</p>
              ) : (
                <button className="btn block" type="button" disabled={busy} onClick={submit}>{busy ? 'Submitting' : `Submit invoice to Jan (${money(draftTotal)})`}</button>
              )}
              <p className="hint mt">Your invoice comes from these entries, so it always matches what Jan sees. Your ABN and bank details come from the <Link href="/account">Account</Link> page.</p>
            </>
          )}

          {invoices.length > 0 && (
            <>
              <h3 className="mt">Past invoices</h3>
              <table className="t">
                <tbody>{invoices.map((i) => (
                  <tr key={i.id}>
                    <td><Link href={`/invoices/${i.id}`}>{invoiceNo(i)}</Link><br /><span className="hint">Week to {fmtDate(i.period_end)}</span></td>
                    <td className="n">{money(i.total)}</td>
                    <td className="n"><span className={i.status === 'paid' ? 'tag turf' : 'tag amber'}>{i.status === 'paid' ? 'Paid' : 'Submitted'}</span></td>
                  </tr>
                ))}</tbody>
              </table>
            </>
          )}
        </>
      )}
    </>
  );
}
