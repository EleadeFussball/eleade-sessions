'use client';
import { useState } from 'react';
import Link from 'next/link';
import { errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { addDays, fmtDate, todayISO } from '@/lib/dates';
import { normaliseTime } from '@/lib/time';
import { FORMAT_LABEL, OUTCOME_LABEL, type Outcome } from '@/lib/types';
import { cancelEntry, confirmEntry, hhmm, moveEntry, type ScheduleEntry } from '@/lib/schedule';

/** One planned session, with the actions a coach needs: done, cancelled, moved, removed. */
export function ScheduleItem({ o, onDone, showDay = false, showCoach = false }:
  { o: ScheduleEntry; onDone: () => void; showDay?: boolean; showCoach?: boolean }) {
  const { coach, coaches, isAdmin } = useAuth();
  const [mode, setMode] = useState<'' | 'done' | 'cancel' | 'move'>('');
  const [topic, setTopic] = useState('');
  const [obs, setObs] = useState('');
  const [improve, setImprove] = useState('');
  const [cash, setCash] = useState(false);
  const [cancelKind, setCancelKind] = useState<Outcome>('cancelled_in_time');
  const [newDate, setNewDate] = useState(o.session_date);
  const [newTime, setNewTime] = useState(hhmm(o.start_time));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const future = o.session_date > todayISO();
  const mine = isAdmin || o.coach_id === coach?.id;
  const coachName = coaches.find((c) => c.id === o.coach_id)?.name ?? '';

  async function confirm(outcome: Outcome) {
    setBusy(true); setErr('');
    const { error } = await confirmEntry(o, outcome, { topic, obs, improve, cash });
    setBusy(false);
    if (error) setErr(errorText(error)); else { setMode(''); onDone(); }
  }

  async function move(e: React.FormEvent) {
    e.preventDefault();
    const t = normaliseTime(newTime);
    if (!t) { setErr('Start time not recognised. Type it like 630, 6:30 or 1800.'); return; }
    setBusy(true); setErr('');
    const { error } = await moveEntry(o, newDate, t);
    setBusy(false);
    if (error) setErr(errorText(error)); else { setMode(''); onDone(); }
  }

  async function remove() {
    if (!window.confirm('Take this session off the calendar? Nobody is charged.')) return;
    setBusy(true); setErr('');
    const { error } = await cancelEntry(o);
    setBusy(false);
    if (error) setErr(errorText(error)); else onDone();
  }

  return (
    <li className="session">
      <div className="head">
        <span>{showDay ? `${fmtDate(o.session_date, true)}, ` : ''}{hhmm(o.start_time)} · {o.players}</span>
        {o.session_id
          ? <span className={o.outcome === 'attended' ? 'tag turf' : 'tag amber'}>{OUTCOME_LABEL[o.outcome as Outcome]}</span>
          : o.moved ? <span className="tag">Moved</span>
          : o.kind === 'regular' ? <span className="tag">Weekly</span> : null}
      </div>
      <div className="sub">
        {FORMAT_LABEL[o.format]}{o.location ? `, ${o.location}` : ''}{showCoach && coachName ? ` · ${coachName}` : ''}
      </div>
      {o.note && <div className="sub">{o.note}</div>}

      {!o.session_id && mode === '' && mine && (
        <div className="row mt" style={{ flexWrap: 'wrap' }}>
          <button type="button" className="btn small" disabled={future} onClick={() => setMode('done')}>Done</button>
          <button type="button" className="btn small ghost" disabled={future} onClick={() => setMode('cancel')}>Cancelled</button>
          <button type="button" className="btn small ghost" onClick={() => setMode('move')}>Move</button>
          {o.kind === 'once' && <button type="button" className="btn small ghost" disabled={busy} onClick={remove}>Remove</button>}
        </div>
      )}

      {mode === 'done' && (
        <div className="mt">
          <p className="hint">Notes are optional. Tap the microphone on your keyboard to dictate.</p>
          <label className="field"><span>What you worked on</span><textarea value={topic} onChange={(e) => setTopic(e.target.value)} /></label>
          <label className="field"><span>How it went</span><textarea value={obs} onChange={(e) => setObs(e.target.value)} /></label>
          <label className="field"><span>Next session</span><textarea value={improve} onChange={(e) => setImprove(e.target.value)} style={{ minHeight: 64 }} /></label>
          <div className="seg" style={{ marginBottom: 12 }}>
            <button type="button" aria-pressed={cash} onClick={() => setCash(!cash)}>Paid cash</button>
          </div>
          <div className="row">
            <button type="button" className="btn small" disabled={busy} onClick={() => confirm('attended')}>{busy ? 'Saving' : 'Confirm session'}</button>
            <button type="button" className="btn small ghost" onClick={() => setMode('')}>Back</button>
          </div>
        </div>
      )}

      {mode === 'cancel' && (
        <div className="mt">
          <div className="seg outcomes" style={{ marginBottom: 12 }}>
            {(['cancelled_in_time', 'cancelled_late', 'no_show'] as Outcome[]).map((k) => (
              <button key={k} type="button" aria-pressed={cancelKind === k} onClick={() => setCancelKind(k)}>
                {OUTCOME_LABEL[k]}<small>{k === 'cancelled_in_time' ? '12+ hours notice: free' : 'Uses a credit, coach paid'}</small>
              </button>
            ))}
          </div>
          <label className="field"><span>Note <span className="hint">(optional)</span></span>
            <textarea value={obs} onChange={(e) => setObs(e.target.value)} placeholder="e.g. Sick, parent messaged at 7am" style={{ minHeight: 56 }} /></label>
          <div className="row">
            <button type="button" className="btn small" disabled={busy} onClick={() => confirm(cancelKind)}>{busy ? 'Saving' : 'Save cancellation'}</button>
            <button type="button" className="btn small ghost" onClick={() => setMode('')}>Back</button>
          </div>
        </div>
      )}

      {mode === 'move' && (
        <form className="mt" onSubmit={move}>
          <div className="row">
            <label className="field"><span>New day</span>
              <input type="date" value={newDate}
                     min={o.kind === 'regular' && o.plan_date ? addDays(o.plan_date, -14) : undefined}
                     max={o.kind === 'regular' && o.plan_date ? addDays(o.plan_date, 14) : undefined}
                     onChange={(e) => setNewDate(e.target.value)} /></label>
            <label className="field" style={{ flex: '0 0 110px' }}><span>Start</span>
              <input type="text" inputMode="numeric" value={newTime} onChange={(e) => setNewTime(e.target.value)}
                     onBlur={() => setNewTime(normaliseTime(newTime) || newTime)} /></label>
          </div>
          {o.kind === 'regular' && <p className="hint">A weekly session can be moved up to two weeks either way. Only this week changes.</p>}
          <div className="row">
            <button className="btn small" disabled={busy}>{busy ? 'Saving' : 'Move session'}</button>
            <button type="button" className="btn small ghost" onClick={() => setMode('')}>Back</button>
          </div>
        </form>
      )}

      {err && <div className="notice err" role="alert">{err}</div>}
      {future && !o.session_id && mode === '' && mine && <p className="hint">You can confirm it once it has happened.</p>}
      {!mine && !o.session_id && <p className="hint">{coachName}&apos;s session.</p>}
      {o.player_ids?.length === 1 && <p className="hint" style={{ marginTop: 6 }}><Link href={`/players/${o.player_ids[0]}`}>Open player</Link></p>}
    </li>
  );
}
