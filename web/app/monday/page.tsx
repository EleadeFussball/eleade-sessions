'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { addDays, fmtDate, fmtWeek, money, num, todayISO, weekStart } from '@/lib/dates';
import type { PlayerBalance } from '@/lib/types';

type Missing = { player_id: string; name: string; main_coach_id: string | null; last_logged: string | null };
type Late = { session_id: string; session_date: string; logged_on: string; coach_name: string; days_late: number };
type Payg = { player_id: string; name: string; week_start: string; sessions: number; owed: number; paid: number; outstanding: number };
type Pay = { coach_name: string; pay: number | null; outcome: string };

export default function MondayPage() {
  const { isAdmin, coaches } = useAuth();
  const [lastWeek] = useState(addDays(weekStart(todayISO()), -7));
  const [low, setLow] = useState<PlayerBalance[]>([]);
  const [missing, setMissing] = useState<Missing[]>([]);
  const [late, setLate] = useState<Late[]>([]);
  const [payg, setPayg] = useState<Payg[]>([]);
  const [pay, setPay] = useState<Pay[]>([]);
  const [unconfirmed, setUnconfirmed] = useState(0);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    const [b, m, l, g, p] = await Promise.all([
      supabase.from('player_balances').select('*').eq('active', true).eq('billing_model', 'package').order('sessions_left'),
      supabase.from('missing_sessions').select('*').order('name'),
      supabase.from('late_logs').select('*').gte('session_date', addDays(lastWeek, -7)).order('session_date', { ascending: false }),
      supabase.from('payg_weeks').select('*').gt('outstanding', 0).order('week_start', { ascending: false }),
      supabase.from('coach_pay').select('coach_name, pay, outcome').gte('session_date', lastWeek).lte('session_date', addDays(lastWeek, 6)),
    ]);
    const all = (b.data as PlayerBalance[]) ?? [];
    // one line per family for renewals
    const seen = new Set<string>();
    setLow(all.filter((x) => Number(x.sessions_left ?? 0) <= 2).filter((x) => {
      const k = x.family ?? x.player_id; if (seen.has(k)) return false; seen.add(k); return true;
    }));
    setUnconfirmed(all.filter((x) => !x.opening_confirmed).length);
    setMissing((m.data as Missing[]) ?? []); setLate((l.data as Late[]) ?? []);
    setPayg((g.data as Payg[]) ?? []); setPay((p.data as Pay[]) ?? []);
    const e = [b, m, l, g, p].find((x) => x.error); if (e?.error) setErr(e.error.message);
  }, [lastWeek]);

  useEffect(() => { if (isAdmin) load(); }, [isAdmin, load]);
  if (!isAdmin) return <p className="empty">This page is for Jan.</p>;

  async function markPaid(r: Payg) {
    const { error } = await supabase.from('payments').insert({ player_id: r.player_id, week_start: r.week_start, amount: r.outstanding });
    if (error) setErr(errorText(error)); else load();
  }

  const payByCoach = pay.reduce<Record<string, number>>((m, r) => { m[r.coach_name] = (m[r.coach_name] ?? 0) + Number(r.pay ?? 0); return m; }, {});
  const payTotal = Object.values(payByCoach).reduce((a, b) => a + b, 0);
  const coachName = (id: string | null) => coaches.find((c) => c.id === id)?.name ?? '';

  return (
    <>
      <h1>Monday check</h1>
      <p className="muted">Last week: {fmtWeek(lastWeek)}</p>
      {err && <div className="notice err">{err}</div>}
      {unconfirmed > 0 && <div className="notice warn">{unconfirmed} package players still have an unconfirmed starting balance. Confirm them on each player page.</div>}

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
              <td>{fmtDate(r.week_start)}</td>
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
          <tfoot><tr><td>Total, ex GST</td><td className="n">{money(payTotal)}</td></tr></tfoot>
        </table>
      )}
      <p className="hint mt">Each coach&apos;s line matches what they see under My week, so their invoice can be paid without checking.</p>
    </>
  );
}
