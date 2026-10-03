'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { addDays, fmtDate, fmtWeek, money, todayISO, weekStart } from '@/lib/dates';
import { FORMAT_LABEL, OUTCOME_LABEL, type Format, type Outcome } from '@/lib/types';

type PayRow = { session_id: string; session_date: string; coach_id: string; coach_name: string;
  format: Format; outcome: Outcome; players: string | null; pay: number | null };

export default function WeekPage() {
  const { coach, coaches, isAdmin } = useAuth();
  const [start, setStart] = useState(weekStart(todayISO()));
  const [coachId, setCoachId] = useState('');
  const [rows, setRows] = useState<PayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => { if (coach && !coachId) setCoachId(coach.id); }, [coach, coachId]);
  useEffect(() => {
    if (!coachId) return;
    setLoading(true);
    supabase.from('coach_pay').select('*').eq('coach_id', coachId)
      .gte('session_date', start).lte('session_date', addDays(start, 6)).order('session_date')
      .then(({ data }) => { setRows((data as PayRow[]) ?? []); setLoading(false); });
  }, [coachId, start]);

  const name = coaches.find((c) => c.id === coachId)?.name ?? '';
  const total = rows.reduce((t, r) => t + Number(r.pay ?? 0), 0);
  const missingRate = rows.some((r) => r.pay === null);
  const byFormat = rows.reduce<Record<string, number>>((m, r) => {
    if (r.outcome !== 'cancelled_in_time') m[r.format] = (m[r.format] ?? 0) + 1;
    return m;
  }, {});

  function invoiceText() {
    const lines = rows.filter((r) => Number(r.pay) > 0).map((r) =>
      `${fmtDate(r.session_date, true)}  ${r.players ?? ''}  ${FORMAT_LABEL[r.format]}${r.outcome !== 'attended' ? ` (${OUTCOME_LABEL[r.outcome].toLowerCase()})` : ''}  ${money(r.pay)}`);
    return [`Eleade sessions, ${name}, week of ${fmtWeek(start)}`, ...lines, `Total ${money(total)} ex GST`].join('\n');
  }
  async function copy() {
    await navigator.clipboard.writeText(invoiceText());
    setCopied(true); setTimeout(() => setCopied(false), 2500);
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
            <thead><tr><th>Day</th><th>Player</th><th>Type</th><th className="n">Pay</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.session_id}>
                  <td>{fmtDate(r.session_date, true)}</td>
                  <td>{r.players}{r.outcome !== 'attended' && <><br /><span className="hint">{OUTCOME_LABEL[r.outcome]}</span></>}</td>
                  <td>{FORMAT_LABEL[r.format]}</td>
                  <td className="n">{r.pay === null ? 'Rate not set' : money(r.pay)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="total"><span>Total for the week, ex GST</span><span className="score">{money(total)}</span></div>
          {missingRate && <div className="notice warn">Some session types have no pay rate yet. Jan sets rates on the Team page.</div>}
          <button className="btn ghost block" type="button" onClick={copy}>{copied ? 'Copied' : 'Copy for my invoice'}</button>
          <p className="hint mt">Your invoice comes from these entries, so it always matches what Jan sees.</p>
        </>
      )}
    </>
  );
}
