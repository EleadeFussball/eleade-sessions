'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { addDays, fmtDate, todayISO, weekStart } from '@/lib/dates';
import { FORMAT_LABEL, type Format, type Outcome } from '@/lib/types';

type Row = { session_id: string; session_date: string; week_start: string; coach_id: string; coach_name: string;
  format: Format; outcome: Outcome; regular: boolean; players: number; player_names: string | null; coach_pay: number; est_income: number };
type Money = { received_on: string; source: string; amount: number };
type Move = { plan_id: string; plan_date: string; coach_id: string; coach_name: string };
type PlayerOutcome = { player_id: string; name: string; session_date: string; outcome: Outcome };

const RANGES = [4, 12, 26] as const;
const money = (n: number) => `${n < 0 ? '−' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-AU')}`;
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '');
const counts = (o: Outcome) => o !== 'cancelled_in_time';

export default function StatsPage() {
  const { isAdmin } = useAuth();
  const [weeks, setWeeks] = useState<(typeof RANGES)[number]>(12);
  const [rows, setRows] = useState<Row[]>([]);
  const [moneyIn, setMoneyIn] = useState<Money[]>([]);
  const [moves, setMoves] = useState<Move[]>([]);
  const [po, setPo] = useState<PlayerOutcome[]>([]);
  const [loading, setLoading] = useState(true);

  const thisWeek = weekStart(todayISO());
  const from = addDays(thisWeek, -7 * (weeks - 1));
  const to = addDays(thisWeek, 6);

  useEffect(() => {
    if (!isAdmin) return;
    setLoading(true);
    Promise.all([
      supabase.from('stats_sessions').select('*').gte('session_date', from).lte('session_date', to),
      supabase.from('stats_money_in').select('*').gte('received_on', from).lte('received_on', to),
      supabase.from('stats_moves').select('plan_id, plan_date, coach_id, coach_name').gte('plan_date', from).lte('plan_date', to),
      supabase.from('stats_player_outcomes').select('*').gte('session_date', from).lte('session_date', to),
    ]).then(([a, b, c, d]) => {
      setRows((a.data as Row[]) ?? []); setMoneyIn((b.data as Money[]) ?? []);
      setMoves((c.data as Move[]) ?? []); setPo((d.data as PlayerOutcome[]) ?? []);
      setLoading(false);
    });
  }, [isAdmin, from, to]);

  const weekList = useMemo(() => Array.from({ length: weeks }, (_, i) => addDays(from, 7 * i)), [from, weeks]);

  const perWeek = useMemo(() => weekList.map((w) => {
    const r = rows.filter((x) => x.week_start === w);
    const end = addDays(w, 6);
    return {
      week: w,
      sessions: r.filter((x) => x.outcome === 'attended').length,
      income: moneyIn.filter((m) => m.received_on >= w && m.received_on <= end).reduce((t, m) => t + Number(m.amount), 0),
      pay: r.reduce((t, x) => t + Number(x.coach_pay), 0),
    };
  }), [weekList, rows, moneyIn]);

  const totals = useMemo(() => ({
    sessions: rows.filter((x) => x.outcome === 'attended').length,
    income: moneyIn.reduce((t, m) => t + Number(m.amount), 0),
    pay: rows.reduce((t, x) => t + Number(x.coach_pay), 0),
    est: rows.reduce((t, x) => t + Number(x.est_income), 0),
  }), [rows, moneyIn]);

  const byType = useMemo(() => {
    const m = new Map<Format, { n: number; income: number; pay: number }>();
    for (const r of rows) {
      if (!counts(r.outcome)) continue;
      const e = m.get(r.format) ?? { n: 0, income: 0, pay: 0 };
      e.n += 1; e.income += Number(r.est_income); e.pay += Number(r.coach_pay);
      m.set(r.format, e);
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [rows]);

  const byCoach = useMemo(() => {
    const m = new Map<string, { name: string; booked: number; inTime: number; late: number; noShow: number; moved: number }>();
    const get = (id: string, name: string) => {
      if (!m.has(id)) m.set(id, { name, booked: 0, inTime: 0, late: 0, noShow: 0, moved: 0 });
      return m.get(id)!;
    };
    for (const r of rows) {
      const e = get(r.coach_id, r.coach_name);
      e.booked += 1;
      if (r.outcome === 'cancelled_in_time') e.inTime += 1;
      if (r.outcome === 'cancelled_late') e.late += 1;
      if (r.outcome === 'no_show') e.noShow += 1;
    }
    for (const mv of moves) get(mv.coach_id, mv.coach_name).moved += 1;
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, moves]);

  const byPlayer = useMemo(() => {
    const m = new Map<string, { id: string; name: string; booked: number; inTime: number; lateOrNo: number }>();
    for (const r of po) {
      const e = m.get(r.player_id) ?? { id: r.player_id, name: r.name, booked: 0, inTime: 0, lateOrNo: 0 };
      e.booked += 1;
      if (r.outcome === 'cancelled_in_time') e.inTime += 1;
      if (r.outcome === 'cancelled_late' || r.outcome === 'no_show') e.lateOrNo += 1;
      m.set(r.player_id, e);
    }
    return [...m.values()].filter((e) => e.lateOrNo + e.inTime > 0)
      .sort((a, b) => b.lateOrNo - a.lateOrNo || b.inTime - a.inTime).slice(0, 10);
  }, [po]);

  if (!isAdmin) return <p className="empty">This page is for Jan.</p>;
  const maxSessions = Math.max(1, ...perWeek.map((w) => w.sessions));
  const all = byCoach.reduce((t, c) => ({ booked: t.booked + c.booked, inTime: t.inTime + c.inTime, late: t.late + c.late, noShow: t.noShow + c.noShow, moved: t.moved + c.moved }),
    { booked: 0, inTime: 0, late: 0, noShow: 0, moved: 0 });

  return (
    <>
      <h1>Stats</h1>
      <div className="seg" style={{ marginBottom: 16 }} role="group" aria-label="Period">
        {RANGES.map((r) => <button key={r} type="button" aria-pressed={weeks === r} onClick={() => setWeeks(r)}>{r} weeks</button>)}
      </div>
      <p className="muted">{fmtDate(from)} to {fmtDate(to)}. Amounts ex GST. Sessions from the old files are not included.</p>

      {loading ? <p className="empty">Loading</p> : (
        <>
          <div className="tiles">
            <div className="tile"><div className="tile-label">Sessions delivered</div><div className="tile-value">{totals.sessions}</div></div>
            <div className="tile"><div className="tile-label">Money in</div><div className="tile-value">{money(totals.income)}</div></div>
            <div className="tile"><div className="tile-label">Coach pay</div><div className="tile-value">{money(totals.pay)}</div></div>
            <div className="tile"><div className="tile-label">Session value after coach pay</div><div className="tile-value">{money(totals.est - totals.pay)}</div></div>
          </div>
          <p className="hint">Money in is what was received (packages, weekly transfers, confirmed single payments). Session value is what the sessions delivered were worth at each player&apos;s price, so it doesn&apos;t swing when a big package is paid.</p>

          <h2>Sessions per week</h2>
          <div className={`bars${weeks > 4 ? ' dense' : ''}${weeks > 12 ? ' xdense' : ''}`} role="img" aria-label="Sessions delivered per week">
            {perWeek.map((w) => (
              <div key={w.week} className="bar-col" title={`Week of ${fmtDate(w.week)}: ${w.sessions} sessions`}>
                <span className="bar-n">{w.sessions || ''}</span>
                <div className="bar" style={{ height: `${(w.sessions / maxSessions) * 100}%` }} />
                <span className="bar-x">{fmtDate(w.week).replace(/ \d{4}$/, '')}</span>
              </div>
            ))}
          </div>

          <table className="t mt">
            <thead><tr><th>Week of</th><th className="n">Sessions</th><th className="n">Money in</th><th className="n">Coach pay</th></tr></thead>
            <tbody>{[...perWeek].reverse().map((w) => (
              <tr key={w.week}><td>{fmtDate(w.week)}</td><td className="n">{w.sessions}</td><td className="n">{money(w.income)}</td><td className="n">{money(w.pay)}</td></tr>
            ))}</tbody>
          </table>

          <h2>By session type</h2>
          <p className="hint">Charged sessions only (attended, late cancellations and no-shows). Value per player uses their package price per session, or their single-session price. Game analyses and testing are counted as included in packages.</p>
          {byType.length === 0 ? <p className="empty">No sessions in this period.</p> : (
            <table className="t">
              <thead><tr><th>Type</th><th className="n">Sessions</th><th className="n">Value</th><th className="n">Coach pay</th><th className="n">Margin</th></tr></thead>
              <tbody>{byType.map(([f, e]) => (
                <tr key={f}>
                  <td>{FORMAT_LABEL[f]}</td><td className="n">{e.n}</td><td className="n">{money(e.income)}</td><td className="n">{money(e.pay)}</td>
                  <td className="n">{money(e.income - e.pay)}<br /><span className="hint">{money((e.income - e.pay) / e.n)} each</span></td>
                </tr>
              ))}</tbody>
            </table>
          )}

          <h2>Cancellations by coach</h2>
          <p className="hint">Booked counts every session logged, including cancellations. Late rate is late cancellations plus no-shows. Moved counts regular sessions moved to another day or time.</p>
          {byCoach.length === 0 ? <p className="empty">No sessions in this period.</p> : (
            <table className="t">
              <thead><tr><th>Coach</th><th className="n">Booked</th><th className="n">In time</th><th className="n">Late</th><th className="n">No-show</th><th className="n">Moved</th><th className="n">Late rate</th></tr></thead>
              <tbody>{byCoach.map((c) => (
                <tr key={c.name}><td>{c.name}</td><td className="n">{c.booked}</td><td className="n">{c.inTime}</td><td className="n">{c.late}</td><td className="n">{c.noShow}</td><td className="n">{c.moved}</td>
                  <td className="n">{pct(c.late + c.noShow, c.booked)}</td></tr>
              ))}</tbody>
              <tfoot><tr><td>All</td><td className="n">{all.booked}</td><td className="n">{all.inTime}</td><td className="n">{all.late}</td><td className="n">{all.noShow}</td><td className="n">{all.moved}</td><td className="n">{pct(all.late + all.noShow, all.booked)}</td></tr></tfoot>
            </table>
          )}

          <h2>Players who cancel most</h2>
          {byPlayer.length === 0 ? <p className="empty">No cancellations in this period.</p> : (
            <table className="t">
              <thead><tr><th>Player</th><th className="n">Booked</th><th className="n">In time</th><th className="n">Late or no-show</th></tr></thead>
              <tbody>{byPlayer.map((p) => (
                <tr key={p.id}><td><Link href={`/players/${p.id}`}>{p.name}</Link></td><td className="n">{p.booked}</td><td className="n">{p.inTime}</td><td className="n">{p.lateOrNo}</td></tr>
              ))}</tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}
