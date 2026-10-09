'use client';
import { useEffect, useMemo, useState } from 'react';
import { supabase, errorText } from '@/lib/supabase';
import { addDays, fmtWeek, isoWeek, money, todayISO, weekStart } from '@/lib/dates';

export type OwnerWeekRow = {
  week_start: string; salary_cost: number; elle_hours: number; elle_rate: number; elle_amount: number;
  tyler_elle_sessions: number; tyler_commission_rate: number; tyler_commission: number; note: string | null;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const numIn = (s: string) => { const n = Number(s.replace(',', '.')); return Number.isFinite(n) ? n : 0; };

/** Jan only: his salary cost, Elle Academy hours and Tyler's Elle commission, filled in each Sunday. */
export function OwnerWeek() {
  const thisWeek = weekStart(todayISO());
  const [rows, setRows] = useState<OwnerWeekRow[]>([]);
  const [week, setWeek] = useState(thisWeek);
  const [hours, setHours] = useState('0');
  const [rate, setRate] = useState('70');
  const [elle, setElle] = useState('0');
  const [elleTouched, setElleTouched] = useState(false);
  const [tSessions, setTSessions] = useState('0');
  const [tRate, setTRate] = useState('20');
  const [tComm, setTComm] = useState('0');
  const [tTouched, setTTouched] = useState(false);
  const [salary, setSalary] = useState('1960');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    const { data, error } = await supabase.from('owner_weeks').select('*').order('week_start', { ascending: false });
    if (error) setErr(errorText(error)); else setRows((data as OwnerWeekRow[]) ?? []);
  }
  useEffect(() => { load(); }, []);

  // the week's own figures, or last week's as a starting point
  const saved = rows.find((r) => r.week_start === week);
  const base = saved ?? rows.find((r) => r.week_start < week);
  useEffect(() => {
    const b = base;
    setHours(String(b ? Number(b.elle_hours) : 0)); setRate(String(b ? Number(b.elle_rate) : 70));
    setElle(String(b ? Number(b.elle_amount) : 0)); setElleTouched(!!saved && Number(saved.elle_amount) !== r2(Number(saved.elle_hours) * Number(saved.elle_rate)));
    setTSessions(String(b ? Number(b.tyler_elle_sessions) : 0)); setTRate(String(b ? Number(b.tyler_commission_rate) : 20));
    setTComm(String(b ? Number(b.tyler_commission) : 0));
    setTTouched(!!saved && Number(saved.tyler_commission) !== r2(Number(saved.tyler_elle_sessions) * Number(saved.tyler_commission_rate)));
    setSalary(String(b ? Number(b.salary_cost) : 1960)); setNote(saved?.note ?? ''); setMsg(''); setErr('');
  }, [week, rows]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!elleTouched) setElle(String(r2(numIn(hours) * numIn(rate)))); }, [hours, rate, elleTouched]);
  useEffect(() => { if (!tTouched) setTComm(String(r2(numIn(tSessions) * numIn(tRate)))); }, [tSessions, tRate, tTouched]);

  const weeks = useMemo(() => Array.from({ length: 10 }, (_, i) => addDays(thisWeek, -7 * i)), [thisWeek]);
  const brought = numIn(elle) + numIn(tComm);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(''); setMsg('');
    const { error } = await supabase.from('owner_weeks').upsert({
      week_start: week, salary_cost: numIn(salary), elle_hours: numIn(hours), elle_rate: numIn(rate), elle_amount: numIn(elle),
      tyler_elle_sessions: Math.round(numIn(tSessions)), tyler_commission_rate: numIn(tRate), tyler_commission: numIn(tComm),
      note: note.trim() || null, updated_at: new Date().toISOString(),
    });
    setBusy(false);
    if (error) setErr(errorText(error)); else { setMsg(`Week ${isoWeek(week)} saved.`); load(); }
  }

  return (
    <section>
      <h2>My week: salary and Elle Academy</h2>
      <p className="hint">Only you can see this. Fill it in each Sunday. The figures start from last week&apos;s, so usually you only check them and save.</p>
      <form onSubmit={save}>
        <label className="field"><span>Week</span>
          <select value={week} onChange={(e) => setWeek(e.target.value)}>
            {weeks.map((w) => (
              <option key={w} value={w}>Week {isoWeek(w)}, {fmtWeek(w)}{rows.some((r) => r.week_start === w) ? ' (saved)' : ''}</option>
            ))}
          </select>
        </label>
        {!saved && <div className="notice">Not saved yet for this week. The figures below are copied from {base ? `week ${isoWeek(base.week_start)}` : 'the defaults'}.</div>}

        <div className="row">
          <label className="field"><span>Hours at Elle</span>
            <input type="text" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} /></label>
          <label className="field"><span>Rate per hour</span>
            <input type="text" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} /></label>
          <label className="field"><span>Elle total</span>
            <input type="text" inputMode="decimal" value={elle} onChange={(e) => { setElle(e.target.value); setElleTouched(true); }} /></label>
        </div>
        <div className="row">
          <label className="field"><span>Tyler&apos;s sessions at Elle</span>
            <input type="text" inputMode="numeric" value={tSessions} onChange={(e) => setTSessions(e.target.value)} /></label>
          <label className="field"><span>Commission per session</span>
            <input type="text" inputMode="decimal" value={tRate} onChange={(e) => setTRate(e.target.value)} /></label>
          <label className="field"><span>Commission total</span>
            <input type="text" inputMode="decimal" value={tComm} onChange={(e) => { setTComm(e.target.value); setTTouched(true); }} /></label>
        </div>
        <label className="field"><span>My salary cost this week</span>
          <input type="text" inputMode="decimal" value={salary} onChange={(e) => setSalary(e.target.value)} /></label>
        <p className="hint">$1,960 a week = $3,500 gross a fortnight ($2,742 paid out + $758 PAYG) plus $420 super, halved.</p>
        <label className="field"><span>Note <span className="hint">(optional)</span></span>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} /></label>

        <p><strong>Brought in by you this week: {money(brought)}</strong> (Elle {money(numIn(elle))} + Tyler&apos;s commission {money(numIn(tComm))})</p>
        {err && <div className="notice err" role="alert">{err}</div>}
        {msg && <div className="notice ok">{msg}</div>}
        <button className="btn small" disabled={busy}>{busy ? 'Saving' : saved ? 'Update week' : 'Save week'}</button>
      </form>

      {rows.length > 0 && (
        <table className="t mt">
          <thead><tr><th>Week</th><th className="n">Elle</th><th className="n">Tyler</th><th className="n">Salary</th></tr></thead>
          <tbody>{rows.slice(0, 8).map((r) => (
            <tr key={r.week_start}><td>Week {isoWeek(r.week_start)}<br /><span className="hint">{Number(r.elle_hours)} h</span></td>
              <td className="n">{money(Number(r.elle_amount))}</td><td className="n">{money(Number(r.tyler_commission))}</td>
              <td className="n">{money(Number(r.salary_cost))}</td></tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}
