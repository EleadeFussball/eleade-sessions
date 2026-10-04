'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { usePlayers } from '@/lib/usePlayers';
import { addDays, fmtDate, fmtWeek, money, num, todayISO, weekStart, isoWeek } from '@/lib/dates';
import { invoiceNo, type CoachInvoice, type PlayerBalance } from '@/lib/types';
import { buildAba, type AbaPayer } from '@/lib/bank';
import { StripeInbox } from '@/components/StripeInbox';

type Expiring = { player_id: string; name: string; family: string | null; package_name: string | null; expires_on: string; days_left: number; sessions_left: number | null; analyses_left: number | null };
type Missing = { player_id: string; name: string; main_coach_id: string | null; last_logged: string | null };
type Late = { session_id: string; session_date: string; logged_on: string; coach_name: string; days_late: number };
type Payg = { player_id: string; name: string; week_start: string; sessions: number; owed: number; paid: number; outstanding: number };
type Pay = { coach_name: string; pay: number | null; outcome: string };
type ToConfirm = { kind: 'session' | 'package'; item_id: string; player_id: string; name: string; item_date: string;
  what: string; amount: number | null; payment_method: string | null; recorded_by: string | null };
const METHOD: Record<string, string> = { stripe: 'Stripe link', bank: 'bank transfer', cash: 'cash', other: 'other' };

export default function MondayPage() {
  const { isAdmin, coaches } = useAuth();
  const [lastWeek] = useState(addDays(weekStart(todayISO()), -7));
  const [low, setLow] = useState<PlayerBalance[]>([]);
  const [missing, setMissing] = useState<Missing[]>([]);
  const [late, setLate] = useState<Late[]>([]);
  const [payg, setPayg] = useState<Payg[]>([]);
  const [pay, setPay] = useState<Pay[]>([]);
  const [unconfirmed, setUnconfirmed] = useState(0);
  const [toConfirm, setToConfirm] = useState<ToConfirm[]>([]);
  const [err, setErr] = useState('');
  const { players } = usePlayers();
  const [expiring, setExpiring] = useState<Expiring[]>([]);
  const [toPay, setToPay] = useState<CoachInvoice[]>([]);
  const [bank, setBank] = useState<AbaPayer & { bsb: string | null; account_number: string | null; account_name: string | null } | null>(null);

  const load = useCallback(async () => {
    const [b, m, l, g, p, c, inv, bk, ex] = await Promise.all([
      supabase.from('player_balances').select('*').eq('active', true).eq('billing_model', 'package').order('sessions_left'),
      supabase.from('missing_sessions').select('*').order('name'),
      supabase.from('late_logs').select('*').gte('session_date', addDays(lastWeek, -7)).order('session_date', { ascending: false }),
      supabase.from('payg_weeks').select('*').gt('outstanding', 0).order('week_start', { ascending: false }),
      supabase.from('coach_pay').select('coach_name, pay, outcome').gte('session_date', lastWeek).lte('session_date', addDays(lastWeek, 6)),
      supabase.from('payments_to_confirm').select('*').order('item_date', { ascending: false }),
      supabase.from('coach_invoices').select('*').eq('status', 'submitted').order('coach_name').order('number'),
      supabase.from('bank_file_settings').select('*').maybeSingle(),
      supabase.from('expiring_packages').select('*').order('days_left'),
    ]);
    setExpiring((ex.data as Expiring[]) ?? []);
    setToPay((inv.data as CoachInvoice[]) ?? []);
    setBank(bk.data as typeof bank);
    setToConfirm((c.data as ToConfirm[]) ?? []);
    const all = (b.data as PlayerBalance[]) ?? [];
    // one line per family for renewals
    const seen = new Set<string>();
    setLow(all.filter((x) => Number(x.sessions_left ?? 0) <= 2).filter((x) => {
      const k = x.family ?? x.player_id; if (seen.has(k)) return false; seen.add(k); return true;
    }));
    setUnconfirmed(all.filter((x) => !x.opening_confirmed).length);
    setMissing((m.data as Missing[]) ?? []); setLate((l.data as Late[]) ?? []);
    setPayg((g.data as Payg[]) ?? []); setPay((p.data as Pay[]) ?? []);
    const e = [b, m, l, g, p, c, inv].find((x) => x.error); if (e?.error) setErr(e.error.message);
  }, [lastWeek]);

  useEffect(() => { if (isAdmin) load(); }, [isAdmin, load]);
  if (!isAdmin) return <p className="empty">This page is for Jan.</p>;

  async function confirmItem(r: ToConfirm) {
    const q = r.kind === 'session'
      ? supabase.from('sessions').update({ payment_status: 'confirmed' }).eq('id', r.item_id)
      : supabase.from('credit_ledger').update({ payment_status: 'confirmed' }).eq('id', r.item_id);
    const { error } = await q;
    if (error) setErr(errorText(error)); else load();
  }

  async function markPaid(r: Payg) {
    const { error } = await supabase.from('payments').insert({ player_id: r.player_id, week_start: r.week_start, amount: r.outstanding });
    if (error) setErr(errorText(error)); else load();
  }

  async function markInvoicesPaid(ids: string[]) {
    if (ids.length > 1 && !window.confirm(`Mark ${ids.length} invoices as paid?`)) return;
    const { error } = await supabase.rpc('mark_invoices_paid', { p_ids: ids });
    if (error) setErr(errorText(error)); else load();
  }

  const bankReady = !!(bank?.bsb && bank.account_number && bank.account_name);
  function downloadBankFile() {
    if (!bank || !bankReady) return;
    try {
      const text = buildAba(
        { bsb: bank.bsb!, account_number: bank.account_number!, account_name: bank.account_name!, user_id_number: bank.user_id_number, remitter_name: bank.remitter_name },
        toPay.map((i) => ({ bsb: i.bsb, account_number: i.account_number, account_name: i.account_name, amount: Number(i.total), reference: `ELEADE ${invoiceNo(i)}` })),
        new Date(),
      );
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url; a.download = `eleade-coach-pay-${todayISO()}.aba`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setErr(errorText(e)); }
  }
  const toPayTotal = toPay.reduce((t, i) => t + Number(i.total), 0);

  const salariedNames = new Set(coaches.filter((c) => c.salaried).map((c) => c.name));
  const payByCoach = pay.filter((r) => !salariedNames.has(r.coach_name)).reduce<Record<string, number>>((m, r) => { m[r.coach_name] = (m[r.coach_name] ?? 0) + Number(r.pay ?? 0); return m; }, {});
  const payTotal = Object.values(payByCoach).reduce((a, b) => a + b, 0);
  const coachName = (id: string | null) => coaches.find((c) => c.id === id)?.name ?? '';

  return (
    <>
      <h1>Monday check</h1>
      <p className="muted">Last week: {fmtWeek(lastWeek)}</p>
      {err && <div className="notice err">{err}</div>}
      {unconfirmed > 0 && <div className="notice warn">{unconfirmed} package players still have an unconfirmed starting balance. Confirm them on each player page.</div>}

      <h2>Coach invoices to pay ({toPay.length})</h2>
      {toPay.length === 0 ? <p className="empty">No invoices waiting.</p> : (
        <>
          <table className="t">
            <thead><tr><th>Coach</th><th>Invoice</th><th className="n">Amount</th><th></th></tr></thead>
            <tbody>{toPay.map((i) => (
              <tr key={i.id}>
                <td>{i.coach_name}</td>
                <td><Link href={`/invoices/${i.id}`}>{invoiceNo(i)}</Link><br /><span className="hint">Week {isoWeek(i.period_start)}, to {fmtDate(i.period_end)}</span></td>
                <td className="n">{money(i.total)}</td>
                <td className="n"><button className="btn small ghost" type="button" onClick={() => markInvoicesPaid([i.id])}>Mark paid</button></td>
              </tr>
            ))}</tbody>
            <tfoot><tr><td>Total</td><td></td><td className="n">{money(toPayTotal)}</td><td></td></tr></tfoot>
          </table>
          {bankReady ? (
            <div className="row">
              <button className="btn small" type="button" onClick={downloadBankFile}>Download NAB payment file</button>
              <button className="btn small ghost" type="button" onClick={() => markInvoicesPaid(toPay.map((i) => i.id))}>Mark all paid</button>
            </div>
          ) : (
            <div className="notice warn">Add Eleade&apos;s paying account on the <Link href="/team">Team</Link> page to download a NAB payment file.</div>
          )}
          <p className="hint mt">In NAB Internet Banking on a computer, import the file as a multiple payment, check the total matches, and approve. Then tap Mark all paid.</p>
        </>
      )}

      <StripeInbox players={players} onChanged={load} />

      <h2>Payments to confirm ({toConfirm.length})</h2>
      <p className="hint">Assessments, packages and cash handed to you that the coaches recorded. Check Stripe, your bank account or the cash you collected, then confirm. Cash that coaches keep is taken off their weekly invoice instead.</p>
      {toConfirm.length === 0 ? <p className="empty">Nothing to confirm.</p> : (
        <table className="t">
          <thead><tr><th>Player</th><th>What</th><th className="n">Amount</th><th></th></tr></thead>
          <tbody>{toConfirm.map((r) => (
            <tr key={r.kind + r.item_id}>
              <td><Link href={`/players/${r.player_id}`}>{r.name}</Link><br /><span className="hint">{fmtDate(r.item_date)}{r.recorded_by ? `, by ${r.recorded_by}` : ''}</span></td>
              <td>{r.what}<br /><span className="hint">{r.payment_method ? `Coach says: ${METHOD[r.payment_method] ?? r.payment_method}` : 'Not paid yet'}</span></td>
              <td className="n">{money(r.amount)}</td>
              <td className="n"><button className="btn small ghost" type="button" onClick={() => confirmItem(r)}>Confirm paid</button></td>
            </tr>
          ))}</tbody>
        </table>
      )}

      <h2>Renewals: 2 or fewer sessions left ({low.length})</h2>
      {low.length === 0 ? <p className="empty">Nobody is running low.</p> : (
        <table className="t">
          <thead><tr><th>Player</th><th>Last session</th><th className="n">Left</th></tr></thead>
          <tbody>
            {low.map((p) => (
              <tr key={p.player_id}>
                <td><Link href={`/players/${p.player_id}`}>{p.family ? `${p.family} family` : p.name}</Link></td>
                <td>{fmtDate(p.last_session)}</td>
                <td className="n"><span className={`score ${Number(p.sessions_left) <= 0 ? 'out' : 'low'}`} style={{ fontSize: '1.4rem' }}>{num(p.sessions_left)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Packages expiring soon ({expiring.length})</h2>
      <p className="hint">Packages that expire within 4 weeks, or expired in the last 2, with credits still left.</p>
      {expiring.length === 0 ? <p className="empty">No packages about to expire with credits left.</p> : (
        <table className="t">
          <thead><tr><th>Player</th><th>Expires</th><th className="n">Left</th></tr></thead>
          <tbody>{expiring.map((e) => (
            <tr key={e.player_id}>
              <td><Link href={`/players/${e.player_id}`}>{e.family ? `${e.family} family` : e.name}</Link><br /><span className="hint">{e.package_name ?? 'Package'}</span></td>
              <td>{fmtDate(e.expires_on)}<br /><span className={e.days_left < 0 ? 'tag red' : e.days_left <= 7 ? 'tag amber' : 'tag'}>{e.days_left < 0 ? `Expired ${-e.days_left} days ago` : e.days_left === 0 ? 'Today' : `In ${e.days_left} days`}</span></td>
              <td className="n">{num(e.sessions_left)}{Number(e.analyses_left) > 0 ? ` + ${num(e.analyses_left)} analyses` : ''}</td>
            </tr>
          ))}</tbody>
        </table>
      )}

      <h2>Regular players with nothing logged last week ({missing.length})</h2>
      <p className="hint">These players trained every week for the three weeks before. Check with the coach whether a session happened.</p>
      {missing.length === 0 ? <p className="empty">Every regular player has a session logged.</p> : (
        <table className="t">
          <thead><tr><th>Player</th><th>Main coach</th><th>Last logged</th></tr></thead>
          <tbody>{missing.map((m) => (
            <tr key={m.player_id}><td><Link href={`/players/${m.player_id}`}>{m.name}</Link></td><td>{coachName(m.main_coach_id)}</td><td>{fmtDate(m.last_logged)}</td></tr>
          ))}</tbody>
        </table>
      )}

      <h2>Logged late ({late.length})</h2>
      {late.length === 0 ? <p className="empty">Everything was logged within 2 days.</p> : (
        <table className="t">
          <thead><tr><th>Coach</th><th>Session</th><th className="n">Days late</th></tr></thead>
          <tbody>{late.map((l) => (
            <tr key={l.session_id}><td>{l.coach_name}</td><td>{fmtDate(l.session_date, true)}</td><td className="n">{l.days_late}</td></tr>
          ))}</tbody>
        </table>
      )}

      <h2>Weekly payers still to pay ({payg.length})</h2>
      {payg.length === 0 ? <p className="empty">All weekly payers are paid up.</p> : (
        <table className="t">
          <thead><tr><th>Player</th><th>Week</th><th className="n">Owed</th><th></th></tr></thead>
          <tbody>{payg.map((r) => (
            <tr key={r.player_id + r.week_start}>
              <td><Link href={`/players/${r.player_id}`}>{r.name}</Link><br /><span className="hint">{r.sessions} session{r.sessions > 1 ? 's' : ''}</span></td>
              <td>{fmtDate(r.week_start)}<br /><span className="hint">Week {isoWeek(r.week_start)}</span></td>
              <td className="n">{money(r.outstanding)}</td>
              <td className="n"><button className="btn small ghost" type="button" onClick={() => markPaid(r)}>Mark paid</button></td>
            </tr>
          ))}</tbody>
        </table>
      )}

      <h2>Coach pay for last week</h2>
      {Object.keys(payByCoach).length === 0 ? <p className="empty">No sessions logged last week.</p> : (
        <table className="t">
          <tbody>{Object.entries(payByCoach).sort().map(([c, v]) => (
            <tr key={c}><td>{c}</td><td className="n">{money(v)}</td></tr>
          ))}</tbody>
          <tfoot><tr><td>Total</td><td className="n">{money(payTotal)}</td></tr></tfoot>
        </table>
      )}
      <p className="hint mt">Each coach&apos;s line matches what they see under My week, so their invoice can be paid without checking. Salaried staff are not listed.</p>
    </>
  );
}
