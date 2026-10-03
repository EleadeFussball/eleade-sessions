'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { addDays, fmtDate, fmtWeek, money, todayISO, weekStart } from '@/lib/dates';
import { FORMAT_LABEL, OUTCOME_LABEL, type Format, type Outcome } from '@/lib/types';

type PayRow = { session_id: string; session_date: string; coach_id: string; coach_name: string;
  format: Format; outcome: Outcome; players: string | null; pay: number | null; old?: boolean };

export default function WeekPage() {
  const { coach, coaches, isAdmin } = useAuth();
  const [start, setStart] = useState(weekStart(todayISO()));
  const [coachId, setCoachId] = useState('');
  const [paid, setPaid] = useState<PayRow[]>([]);
  const [old, setOld] = useState<PayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => { if (coach && !coachId) setCoachId(coach.id); }, [coach, coachId]);
  useEffect(() => {
    if (!coachId) return;
    setLoading(true);
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

  function invoiceText() {
    const lines = paid.filter((r) => Number(r.pay) > 0).map((r) =>
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
                  <td className="n">{r.old ? <span className="hint">Old invoice</span> : r.pay === null ? 'Rate not set' : money(r.pay)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="total"><span>Total for the week, ex GST</span><span className="score">{money(total)}</span></div>
          {old.length > 0 && <p className="hint">{old.length} session{old.length > 1 ? 's' : ''} marked “Old invoice” came from the old documentation file. They were paid through the old invoice, so they aren&apos;t in this total.</p>}
          {missingRate && <div className="notice warn">Some session types have no pay rate yet. Jan sets rates on the Team page.</div>}
          <button className="btn ghost block" type="button" onClick={copy}>{copied ? 'Copied' : 'Copy for my invoice'}</button>
          <p className="hint mt">Your invoice comes from these entries, so it always matches what Jan sees.</p>
        </>
      )}
    </>
  );
}
