'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { addDays, fmtDate, isoWeek, todayISO, weekStart } from '@/lib/dates';
import { FORMAT_LABEL, type Format, type Outcome } from '@/lib/types';

type Row = { session_id: string; session_date: string; week_start: string; coach_id: string; coach_name: string;
  format: Format; outcome: Outcome; regular: boolean; players: number; player_names: string | null; coach_pay: number; est_income: number; imported: boolean };
type Money = { received_on: string; source: string; amount: number };
type Move = { plan_id: string; plan_date: string; coach_id: string; coach_name: string };
type PlayerOutcome = { player_id: string; name: string; session_date: string; outcome: Outcome };
type History = { week_start: string; iso_week: number; coach_name: string | null; sessions: number; analyses: number };

const money = (n: number) => `${n < 0 ? '−' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-AU')}`;
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '');
const n1 = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const counts = (o: Outcome) => o !== 'cancelled_in_time';

/** Fetch every row (the API returns at most 1,000 per request). */
async function fetchAll<T>(make: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; ; i += 1000) {
    const { data } = await make(i, i + 999);
    const rows = (data as T[]) ?? [];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

export default function StatsPage() {
  const { isAdmin } = useAuth();
  const thisWeek = weekStart(todayISO());
  const yearStart = weekStart(`${todayISO().slice(0, 4)}-01-04`); // Monday of week 1
  const [from, setFrom] = useState(addDays(thisWeek, -7 * 11));
  const [toWeek, setToWeek] = useState(thisWeek);
  const [rows, setRows] = useState<Row[]>([]);
  const [docAnalyses, setDocAnalyses] = useState<{ week_start: string }[]>([]);
  const [history, setHistory] = useState<History[]>([]);
  const [historyUntil, setHistoryUntil] = useState('');
  const [moneyIn, setMoneyIn] = useState<Money[]>([]);
  const [moves, setMoves] = useState<Move[]>([]);
  const [po, setPo] = useState<PlayerOutcome[]>([]);
  const [loading, setLoading] = useState(true);

  const to = addDays(toWeek, 6);
  const nWeeks = Math.max(1, Math.round((Date.parse(toWeek) - Date.parse(from)) / (7 * 86400000)) + 1);
  const allWeeks = useMemo(() => {
    const out: string[] = [];
    for (let w = yearStart; w <= thisWeek; w = addDays(w, 7)) out.push(w);
    return out.reverse();
  }, [yearStart, thisWeek]);
  const quick: { label: string; f: string; t: string }[] = [
    { label: 'This week', f: thisWeek, t: thisWeek },
    { label: 'Last week', f: addDays(thisWeek, -7), t: addDays(thisWeek, -7) },
    { label: '4 weeks', f: addDays(thisWeek, -21), t: thisWeek },
    { label: '12 weeks', f: addDays(thisWeek, -77), t: thisWeek },
    { label: todayISO().slice(0, 4), f: yearStart, t: thisWeek },
  ];

  useEffect(() => {
    if (!isAdmin) return;
    setLoading(true);
    Promise.all([
      fetchAll<Row>((a, b) => supabase.from('stats_sessions').select('*').eq('imported', false)
        .gte('session_date', from).lte('session_date', to).order('session_date').range(a, b)),
      fetchAll<{ week_start: string }>((a, b) => supabase.from('stats_sessions').select('week_start').eq('imported', true)
        .eq('format', 'analysis').eq('outcome', 'attended').gte('session_date', from).lte('session_date', to).range(a, b)),
      fetchAll<History>((a, b) => supabase.from('stats_history').select('*').gte('week_start', from).lte('week_start', toWeek).range(a, b)),
      fetchAll<Money>((a, b) => supabase.from('stats_money_in').select('*').gte('received_on', from).lte('received_on', to).range(a, b)),
      fetchAll<Move>((a, b) => supabase.from('stats_moves').select('plan_id, plan_date, coach_id, coach_name').gte('plan_date', from).lte('plan_date', to).range(a, b)),
      fetchAll<PlayerOutcome>((a, b) => supabase.from('stats_player_outcomes').select('*').gte('session_date', from).lte('session_date', to).range(a, b)),
      supabase.from('settings').select('value').eq('key', 'stats_history_until').maybeSingle(),
    ]).then(([a, da, h, b, c, d, hu]) => {
      setRows(a); setDocAnalyses(da); setHistory(h); setMoneyIn(b); setMoves(c); setPo(d);
      setHistoryUntil(((hu.data?.value as string) ?? '').trim());
      setLoading(false);
    });
  }, [isAdmin, from, to, toWeek]);

  const weekList = useMemo(() => Array.from({ length: nWeeks }, (_, i) => addDays(from, 7 * i)), [from, nWeeks]);
  const fromHistory = (w: string) => !!historyUntil && w <= historyUntil;
  // sessions logged in the app count for weeks after the Abrechnung history
  const appRows = useMemo(() => rows.filter((r) => !fromHistory(r.week_start)), [rows, historyUntil]); // eslint-disable-line react-hooks/exhaustive-deps

  const perWeek = useMemo(() => weekList.map((w) => {
    const end = addDays(w, 6);
    const r = rows.filter((x) => x.week_start === w);
    let sessions: number, analyses: number;
    if (fromHistory(w)) {
      const h = history.filter((x) => x.week_start === w);
      sessions = h.reduce((t, x) => t + Number(x.sessions), 0);
      analyses = Math.max(h.reduce((t, x) => t + Number(x.analyses), 0), docAnalyses.filter((x) => x.week_start === w).length);
    } else {
      sessions = r.filter((x) => x.outcome === 'attended' && x.format !== 'analysis').length;
      analyses = r.filter((x) => x.outcome === 'attended' && x.format === 'analysis').length;
    }
    return {
      week: w, sessions, analyses, history: fromHistory(w),
      income: moneyIn.filter((m) => m.received_on >= w && m.received_on <= end).reduce((t, m) => t + Number(m.amount), 0),
      pay: r.reduce((t, x) => t + Number(x.coach_pay), 0),
    };
  }), [weekList, rows, history, docAnalyses, moneyIn, historyUntil]); // eslint-disable-line react-hooks/exhaustive-deps

  const sessionsByCoach = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of history) if (h.coach_name && fromHistory(h.week_start)) m.set(h.coach_name, (m.get(h.coach_name) ?? 0) + Number(h.sessions));
    for (const r of appRows) if (r.outcome === 'attended' && r.format !== 'analysis') m.set(r.coach_name, (m.get(r.coach_name) ?? 0) + 1);
    return [...m.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  }, [history, appRows, historyUntil]); // eslint-disable-line react-hooks/exhaustive-deps

  const totals = useMemo(() => ({
    sessions: perWeek.reduce((t, w) => t + w.sessions, 0),
    analyses: perWeek.reduce((t, w) => t + w.analyses, 0),
    historyWeeks: perWeek.filter((w) => w.history).length,
    income: moneyIn.reduce((t, m) => t + Number(m.amount), 0),
    pay: rows.reduce((t, x) => t + Number(x.coach_pay), 0),
    est: rows.reduce((t, x) => t + Number(x.est_income), 0),
  }), [rows, moneyIn, perWeek]);

  const byType = useMemo(() => {
    const m = new Map<Format, { n: number; app: number; income: number; pay: number }>();
    for (const r of appRows) {
      if (!counts(r.outcome)) continue;
      const e = m.get(r.format) ?? { n: 0, app: 0, income: 0, pay: 0 };
      e.n += 1; e.app += 1; e.income += Number(r.est_income); e.pay += Number(r.coach_pay);
      m.set(r.format, e);
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [appRows]);

  const byCoach = useMemo(() => {
    const m = new Map<string, { name: string; booked: number; inTime: number; late: number; noShow: number; moved: number }>();
    const get = (id: string, name: string) => {
      if (!m.has(id)) m.set(id, { name, booked: 0, inTime: 0, late: 0, noShow: 0, moved: 0 });
      return m.get(id)!;
    };
    for (const r of appRows) {
      const e = get(r.coach_id, r.coach_name);
      e.booked += 1;
      if (r.outcome === 'cancelled_in_time') e.inTime += 1;
      if (r.outcome === 'cancelled_late') e.late += 1;
      if (r.outcome === 'no_show') e.noShow += 1;
    }
    for (const mv of moves) get(mv.coach_id, mv.coach_name).moved += 1;
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [appRows, moves]);

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
      <div className="seg" style={{ marginBottom: 12 }} role="group" aria-label="Period">
        {quick.map((q) => (
          <button key={q.label} type="button" aria-pressed={from === q.f && toWeek === q.t} onClick={() => { setFrom(q.f); setToWeek(q.t); }}>{q.label}</button>
        ))}
      </div>
      <div className="row" style={{ marginBottom: 8 }}>
        <label className="field" style={{ marginBottom: 8 }}><span>From</span>
          <select value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > toWeek) setToWeek(e.target.value); }}>
            {allWeeks.map((w) => <option key={w} value={w}>Week {isoWeek(w)} · {fmtDate(w).replace(/ \d{4}$/, '')}</option>)}
          </select></label>
        <label className="field" style={{ marginBottom: 8 }}><span>To</span>
          <select value={toWeek} onChange={(e) => { setToWeek(e.target.value); if (e.target.value < from) setFrom(e.target.value); }}>
            {allWeeks.map((w) => <option key={w} value={w}>Week {isoWeek(w)} · {fmtDate(w).replace(/ \d{4}$/, '')}</option>)}
          </select></label>
      </div>
      <p className="muted">{nWeeks === 1 ? `Week ${isoWeek(from)}` : `Week ${isoWeek(from)} to week ${isoWeek(toWeek)}`}: {fmtDate(from)} to {fmtDate(to)}. Amounts ex GST.</p>

      {loading ? <p className="empty">Loading</p> : (
        <>
          <div className="tiles">
            <div className="tile"><div className="tile-label">Sessions delivered</div><div className="tile-value">{n1(totals.sessions)}</div></div>
            <div className="tile"><div className="tile-label">Game analyses</div><div className="tile-value">{n1(totals.analyses)}</div></div>
            <div className="tile"><div className="tile-label">Money in</div><div className="tile-value">{money(totals.income)}</div></div>
            <div className="tile"><div className="tile-label">Coach pay</div><div className="tile-value">{money(totals.pay)}</div></div>
            <div className="tile"><div className="tile-label">Session value after coach pay</div><div className="tile-value">{money(totals.est - totals.pay)}</div></div>
            <div className="tile"><div className="tile-label">Late cancellations and no-shows</div><div className="tile-value">{pct(all.late + all.noShow, all.booked) || '–'}</div></div>
          </div>
          {totals.historyWeeks > 0 && <p className="hint">Up to week {isoWeek(historyUntil)}, session counts come from the Abrechnung (the weekly session totals per coach), and game analyses from the Abrechnung or the documentation file, whichever has more. From week {isoWeek(addDays(historyUntil, 7))}, they come from sessions logged in the app. Pay, value and cancellations only cover sessions logged in the app.</p>}
          <p className="hint">Money in is what was received (packages, weekly transfers, confirmed single payments). Session value is what the sessions delivered were worth at each player&apos;s price, so it doesn&apos;t swing when a big package is paid.</p>

          <h2>Sessions per week</h2>
          <div className={`bars${nWeeks > 4 ? ' dense' : ''}${nWeeks > 12 ? ' xdense' : ''}`} role="img" aria-label="Sessions delivered per week">
            {perWeek.map((w) => (
              <div key={w.week} className="bar-col" title={`Week ${isoWeek(w.week)} (${fmtDate(w.week)}): ${n1(w.sessions)} sessions, ${n1(w.analyses)} analyses`}>
                <span className="bar-n">{w.sessions ? n1(w.sessions) : ''}</span>
                <div className="bar" style={{ height: `${(w.sessions / maxSessions) * 100}%` }} />
                <span className="bar-x">W{isoWeek(w.week)}</span>
              </div>
            ))}
          </div>

          <table className="t mt">
            <thead><tr><th>Week</th><th className="n">Sessions</th><th className="n">Analyses</th><th className="n">Money in</th><th className="n">Coach pay</th></tr></thead>
            <tbody>{[...perWeek].reverse().map((w) => (
              <tr key={w.week}><td>Week {isoWeek(w.week)}<br /><span className="hint">{fmtDate(w.week)}</span></td><td className="n">{n1(w.sessions)}</td><td className="n">{n1(w.analyses)}</td><td className="n">{money(w.income)}</td><td className="n">{money(w.pay)}</td></tr>
            ))}</tbody>
          </table>

          <h2>Sessions by coach</h2>
          {sessionsByCoach.length === 0 ? <p className="empty">No sessions in this period.</p> : (
            <table className="t">
              <thead><tr><th>Coach</th><th className="n">Sessions</th><th className="n">Share</th></tr></thead>
              <tbody>{sessionsByCoach.map(([c, n]) => (
                <tr key={c}><td>{c}</td><td className="n">{n1(n)}</td><td className="n">{pct(n, totals.sessions)}</td></tr>
              ))}</tbody>
            </table>
          )}

          <h2>By session type</h2>
          <p className="hint">Charged sessions only (attended, late cancellations and no-shows). Value per player uses their package price per session, or their single-session price. Game analyses and testing are counted as included in packages. Sessions logged in the app only; the Abrechnung doesn&apos;t record the session type.</p>
          {byType.length === 0 ? <p className="empty">No sessions logged in the app in this period.</p> : (
            <table className="t">
              <thead><tr><th>Type</th><th className="n">Sessions</th><th className="n">Value</th><th className="n">Coach pay</th><th className="n">Margin</th></tr></thead>
              <tbody>{byType.map(([f, e]) => (
                <tr key={f}>
                  <td>{FORMAT_LABEL[f]}</td><td className="n">{e.n}</td><td className="n">{money(e.income)}</td><td className="n">{money(e.pay)}</td>
                  <td className="n">{money(e.income - e.pay)}<br /><span className="hint">{money((e.income - e.pay) / e.app)} each</span></td>
                </tr>
              ))}</tbody>
            </table>
          )}

          <h2>Cancellations by coach</h2>
          <p className="hint">Booked counts every session logged, including cancellations. Late rate is late cancellations plus no-shows. Moved counts regular sessions moved to another day or time. Only sessions logged in the app, because the Abrechnung doesn&apos;t record cancellations.</p>
          {byCoach.length === 0 ? <p className="empty">No sessions logged in the app in this period.</p> : (
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
