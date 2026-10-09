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
type Owner = { week_start: string; salary_cost: number; elle_amount: number; elle_hours: number; tyler_commission: number };
type History = { week_start: string; iso_week: number; coach_name: string | null; sessions: number; analyses: number; pay: number | null };

// Jan's assumptions (4 Oct 2026), ex GST: every session is charged $120, an assessment $130,
// a game analysis $120. Coaches get $60 per game analysis before the app.
const SESSION_PRICE = 120;
const ASSESSMENT_PRICE = 130;
const ANALYSIS_PRICE = 120;
const HISTORY_ANALYSIS_RATE = 60;
const revenueOf = (r: { format: Format; outcome: Outcome }) =>
  r.outcome === 'cancelled_in_time' ? 0 : r.format === 'assessment' ? ASSESSMENT_PRICE : r.format === 'analysis' ? ANALYSIS_PRICE : SESSION_PRICE;

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
  const [owner, setOwner] = useState<Owner[]>([]);
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
      supabase.from('owner_weeks').select('week_start, salary_cost, elle_amount, elle_hours, tyler_commission').order('week_start'),
    ]).then(([a, da, h, b, c, d, hu, ow]) => {
      setOwner((ow.data as Owner[]) ?? []);
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
    let sessions: number, analyses: number, pay: number, revenue: number;
    if (fromHistory(w)) {
      const h = history.filter((x) => x.week_start === w);
      sessions = h.reduce((t, x) => t + Number(x.sessions), 0);
      analyses = Math.max(h.reduce((t, x) => t + Number(x.analyses), 0), docAnalyses.filter((x) => x.week_start === w).length);
      pay = h.filter((x) => x.coach_name).reduce((t, x) => t + Number(x.pay ?? 0), 0) + analyses * HISTORY_ANALYSIS_RATE;
      revenue = sessions * SESSION_PRICE + analyses * ANALYSIS_PRICE;
    } else {
      sessions = r.filter((x) => x.outcome === 'attended' && x.format !== 'analysis').length;
      analyses = r.filter((x) => x.outcome === 'attended' && x.format === 'analysis').length;
      pay = r.reduce((t, x) => t + Number(x.coach_pay), 0);
      revenue = r.reduce((t, x) => t + revenueOf(x), 0);
    }
    // Jan's own figures: Elle income and Tyler's commission as entered; salary from the week's row or the latest earlier one
    const own = owner.find((o) => o.week_start === w);
    const salaryRow = own ?? [...owner].reverse().find((o) => o.week_start < w);
    const elle = Number(own?.elle_amount ?? 0), tyler = Number(own?.tyler_commission ?? 0), salary = Number(salaryRow?.salary_cost ?? 0);
    return {
      week: w, sessions, analyses, history: fromHistory(w), elle, tyler, salary, entered: !!own,
      result: revenue - pay + elle + tyler - salary,
      income: moneyIn.filter((m) => m.received_on >= w && m.received_on <= end).reduce((t, m) => t + Number(m.amount), 0),
      pay, revenue, earned: revenue - pay,
    };
  }), [weekList, rows, history, docAnalyses, moneyIn, historyUntil, owner]); // eslint-disable-line react-hooks/exhaustive-deps

  const sessionsByCoach = useMemo(() => {
    const m = new Map<string, { n: number; pay: number; revenue: number; noRate: boolean }>();
    const get = (c: string) => { if (!m.has(c)) m.set(c, { n: 0, pay: 0, revenue: 0, noRate: false }); return m.get(c)!; };
    for (const h of history) {
      if (!h.coach_name || !fromHistory(h.week_start)) continue;
      const e = get(h.coach_name); e.n += Number(h.sessions); e.revenue += Number(h.sessions) * SESSION_PRICE;
      if (h.pay === null) { if (Number(h.sessions) > 0) e.noRate = true; } else e.pay += Number(h.pay);
    }
    for (const r of appRows) {
      const e = get(r.coach_name);
      if (r.outcome === 'attended' && r.format !== 'analysis') e.n += 1;
      e.pay += Number(r.coach_pay); e.revenue += revenueOf(r);
    }
    return [...m.entries()].filter(([, e]) => e.n > 0 || e.pay > 0).sort((a, b) => b[1].n - a[1].n);
  }, [history, appRows, historyUntil]); // eslint-disable-line react-hooks/exhaustive-deps
  const historyAnalyses = perWeek.filter((w) => w.history).reduce((t, w) => t + w.analyses, 0);

  const totals = useMemo(() => ({
    sessions: perWeek.reduce((t, w) => t + w.sessions, 0),
    analyses: perWeek.reduce((t, w) => t + w.analyses, 0),
    historyWeeks: perWeek.filter((w) => w.history).length,
    income: moneyIn.reduce((t, m) => t + Number(m.amount), 0),
    pay: perWeek.reduce((t, w) => t + w.pay, 0),
    revenue: perWeek.reduce((t, w) => t + w.revenue, 0),
    elle: perWeek.reduce((t, w) => t + w.elle, 0),
    tyler: perWeek.reduce((t, w) => t + w.tyler, 0),
    salary: perWeek.reduce((t, w) => t + w.salary, 0),
    result: perWeek.reduce((t, w) => t + w.result, 0),
    missing: perWeek.filter((w) => w.salary > 0 && !w.entered && w.week < thisWeek).length,
  }), [appRows, moneyIn, perWeek]);

  const byType = useMemo(() => {
    const m = new Map<Format, { n: number; app: number; income: number; pay: number }>();
    for (const r of appRows) {
      if (!counts(r.outcome)) continue;
      const e = m.get(r.format) ?? { n: 0, app: 0, income: 0, pay: 0 };
      e.n += 1; e.app += 1; e.income += revenueOf(r); e.pay += Number(r.coach_pay);
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
            <div className="tile"><div className="tile-label">Revenue</div><div className="tile-value">{money(totals.revenue)}</div></div>
            <div className="tile"><div className="tile-label">Coach pay</div><div className="tile-value">{money(totals.pay)}</div></div>
            <div className="tile"><div className="tile-label">Earned after coach pay</div><div className="tile-value">{money(totals.revenue - totals.pay)}</div></div>
            <div className="tile"><div className="tile-label">Elle Academy (Jan)</div><div className="tile-value">{money(totals.elle)}</div></div>
            <div className="tile"><div className="tile-label">Tyler&apos;s Elle commission</div><div className="tile-value">{money(totals.tyler)}</div></div>
            <div className="tile"><div className="tile-label">Jan&apos;s salary and super</div><div className="tile-value">{money(-totals.salary)}</div></div>
            <div className="tile tile-key"><div className="tile-label">Business result</div><div className="tile-value">{money(totals.result)}</div></div>
            <div className="tile"><div className="tile-label">Business result per week</div><div className="tile-value">{money(totals.result / nWeeks)}</div></div>
          </div>
          <p className="hint">Business result = earned after coach pay + Elle Academy + Tyler&apos;s Elle commission − your salary and super. Salary counts from week 41 at $1,960 a week ($3,500 gross a fortnight plus $420 super); Elle and commission come from &quot;My week&quot; on the Admin page.</p>
          {totals.missing > 0 && <div className="notice warn">{totals.missing} week{totals.missing === 1 ? '' : 's'} in this period {totals.missing === 1 ? 'has' : 'have'} no Elle figures yet. <Link href="/admin">Fill them in on the Admin page</Link>.</div>}
          {totals.historyWeeks > 0 && <p className="hint">Up to week {isoWeek(historyUntil)}, session counts come from the Abrechnung (the weekly session totals per coach), and game analyses from the Abrechnung or the documentation file, whichever has more. From week {isoWeek(addDays(historyUntil, 7))}, they come from sessions logged in the app. Cancellations only cover sessions logged in the app.</p>}
          <p className="hint">Revenue assumes every session is charged $120, an assessment $130 and a game analysis $120 (all ex GST); late cancellations and no-shows are charged too. Coach pay: Tyler and Paul $60, David $50, Luca $55 per session, $60 per game analysis. Jani&apos;s sessions have no coach cost; your salary is counted separately above.</p>

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

          <div style={{ overflowX: 'auto' }}>
          <table className="t mt">
            <thead><tr><th>Week</th><th className="n">Sessions</th><th className="n">Revenue</th><th className="n">Coach pay</th><th className="n">Earned</th><th className="n">Elle + Tyler</th><th className="n">Salary</th><th className="n">Result</th></tr></thead>
            <tbody>{[...perWeek].reverse().map((w) => (
              <tr key={w.week}><td>Week {isoWeek(w.week)}<br /><span className="hint">{fmtDate(w.week)}</span></td><td className="n">{n1(w.sessions)}{w.analyses > 0 && <><br /><span className="hint">+{n1(w.analyses)} {w.analyses === 1 ? "analysis" : "analyses"}</span></>}</td><td className="n">{money(w.revenue)}</td><td className="n">{money(w.pay)}</td><td className="n">{money(w.earned)}</td><td className="n">{money(w.elle + w.tyler)}</td><td className="n">{w.salary ? money(-w.salary) : ''}</td><td className="n"><strong>{money(w.result)}</strong></td></tr>
            ))}</tbody>
          </table>
          </div>

          <h2>Sessions by coach</h2>
          {sessionsByCoach.length === 0 ? <p className="empty">No sessions in this period.</p> : (
            <table className="t">
              <thead><tr><th>Coach</th><th className="n">Sessions</th><th className="n">Revenue</th><th className="n">Pay</th><th className="n">Earned</th></tr></thead>
              <tbody>{sessionsByCoach.map(([c, e]) => (
                <tr key={c}><td>{c}</td><td className="n">{n1(e.n)}<br /><span className="hint">{pct(e.n, totals.sessions)}</span></td><td className="n">{money(e.revenue)}</td>
                  <td className="n">{money(e.pay)}</td><td className="n"><strong>{money(e.revenue - e.pay)}</strong></td></tr>
              ))}
              {historyAnalyses > 0 && (
                <tr><td>Game analyses<br /><span className="hint">before the app</span></td><td className="n">{n1(historyAnalyses)}</td><td className="n">{money(historyAnalyses * ANALYSIS_PRICE)}</td>
                  <td className="n">{money(historyAnalyses * HISTORY_ANALYSIS_RATE)}</td><td className="n"><strong>{money(historyAnalyses * (ANALYSIS_PRICE - HISTORY_ANALYSIS_RATE))}</strong></td></tr>
              )}</tbody>
              <tfoot><tr><td>Total</td><td className="n"></td><td className="n">{money(totals.revenue)}</td><td className="n">{money(totals.pay)}</td><td className="n">{money(totals.revenue - totals.pay)}</td></tr></tfoot>
            </table>
          )}

          <h2>By session type</h2>
          <p className="hint">Charged sessions logged in the app (attended, late cancellations and no-shows), at the same prices. The Abrechnung doesn&apos;t record the session type.</p>
          {byType.length === 0 ? <p className="empty">No sessions logged in the app in this period.</p> : (
            <table className="t">
              <thead><tr><th>Type</th><th className="n">Sessions</th><th className="n">Revenue</th><th className="n">Coach pay</th><th className="n">Earned</th></tr></thead>
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
