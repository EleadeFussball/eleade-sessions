'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { addDays, fmtDate, todayISO } from '@/lib/dates';
import { FORMAT_LABEL, OUTCOME_LABEL, type Format, type Outcome } from '@/lib/types';
import { normaliseTime } from '@/lib/time';

export type Occurrence = {
  plan_id: string; plan_date: string; session_date: string; start_time: string; coach_id: string;
  format: Format; location: string | null; player_ids: string[]; players: string; moved: boolean;
  session_id: string | null; outcome: Outcome | null;
};

const hhmm = (t: string) => t.slice(0, 5);

/** The coach's planned sessions: today's, plus any from the last 7 days not yet confirmed. */
export function PlannedSessions({ onChanged }: { onChanged?: () => void }) {
  const { coach } = useAuth();
  const [items, setItems] = useState<Occurrence[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!coach) return;
    const today = todayISO();
    const { data } = await supabase.rpc('plan_occurrences', { p_from: addDays(today, -7), p_to: today });
    setItems(((data as Occurrence[]) ?? []).filter((o) => o.coach_id === coach.id));
    setLoaded(true);
  }, [coach]);
  useEffect(() => { load(); }, [load]);

  const today = todayISO();
  const todays = items.filter((o) => o.session_date === today);
  const overdue = items.filter((o) => o.session_date < today && !o.session_id);
  if (!loaded || (todays.length === 0 && overdue.length === 0)) return null;

  const refresh = () => { load(); onChanged?.(); };
  return (
    <section className="planned" aria-label="Planned sessions">
      <h2 style={{ marginTop: 0 }}>Today</h2>
      {todays.length === 0 ? <p className="empty">No regular sessions planned for today.</p> : (
        <ul className="list">{todays.map((o) => <PlannedItem key={o.plan_id + o.plan_date} o={o} onDone={refresh} />)}</ul>
      )}
      {overdue.length > 0 && (
        <>
          <h3 className="mt">Still to confirm</h3>
          <ul className="list">{overdue.map((o) => <PlannedItem key={o.plan_id + o.plan_date} o={o} onDone={refresh} showDay />)}</ul>
        </>
      )}
    </section>
  );
}

function PlannedItem({ o, onDone, showDay = false }: { o: Occurrence; onDone: () => void; showDay?: boolean }) {
  const [mode, setMode] = useState<'' | 'done' | 'cancel' | 'move'>('');
  const [topic, setTopic] = useState('');
  const [obs, setObs] = useState('');
  const [improve, setImprove] = useState('');
  const [cash, setCash] = useState(false);
  const [cancelKind, setCancelKind] = useState<Outcome>('cancelled_in_time');
  const [newDate, setNewDate] = useState(addDays(o.session_date, 1));
  const [newTime, setNewTime] = useState(hhmm(o.start_time));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const future = o.session_date > todayISO();

  async function confirm(outcome: Outcome) {
    setBusy(true); setErr('');
    const { error } = await supabase.rpc('confirm_plan_session', {
      p_plan_id: o.plan_id, p_plan_date: o.plan_date, p_outcome: outcome,
      p_topic: outcome === 'attended' ? topic : null, p_observations: obs, p_improve: outcome === 'attended' ? improve : null,
      p_payment_method: cash && outcome !== 'cancelled_in_time' ? 'cash' : null,
    });
    setBusy(false);
    if (error) setErr(errorText(error)); else { setMode(''); onDone(); }
  }

  async function move(e: React.FormEvent) {
    e.preventDefault();
    const t = normaliseTime(newTime);
    if (!t) { setErr('Start time not recognised. Type it like 630, 6:30 or 1800.'); return; }
    setBusy(true); setErr('');
    const { error } = await supabase.rpc('move_plan_session', {
      p_plan_id: o.plan_id, p_plan_date: o.plan_date, p_new_date: newDate, p_new_time: t,
    });
    setBusy(false);
    if (error) setErr(errorText(error)); else { setMode(''); onDone(); }
  }

  return (
    <li className="session">
      <div className="head">
        <span>{showDay ? `${fmtDate(o.session_date, true)}, ` : ''}{hhmm(o.start_time)} · {o.players}</span>
        {o.session_id
          ? <span className={o.outcome === 'attended' ? 'tag turf' : 'tag amber'}>{OUTCOME_LABEL[o.outcome as Outcome]}</span>
          : o.moved ? <span className="tag">Moved</span> : null}
      </div>
      <div className="sub">{FORMAT_LABEL[o.format]}{o.location ? `, ${o.location}` : ''}</div>

      {!o.session_id && mode === '' && (
        <div className="row mt" style={{ flexWrap: 'wrap' }}>
          <button type="button" className="btn small" disabled={future} onClick={() => setMode('done')}>Done</button>
          <button type="button" className="btn small ghost" disabled={future} onClick={() => setMode('cancel')}>Cancelled</button>
          <button type="button" className="btn small ghost" onClick={() => setMode('move')}>Move</button>
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
              <input type="date" value={newDate} min={addDays(o.plan_date, -14)} max={addDays(o.plan_date, 14)} onChange={(e) => setNewDate(e.target.value)} /></label>
            <label className="field" style={{ flex: '0 0 110px' }}><span>Start</span>
              <input type="text" inputMode="numeric" value={newTime} onChange={(e) => setNewTime(e.target.value)} onBlur={() => setNewTime(normaliseTime(newTime) || newTime)} /></label>
          </div>
          <div className="row">
            <button className="btn small" disabled={busy}>{busy ? 'Saving' : 'Move session'}</button>
            <button type="button" className="btn small ghost" onClick={() => setMode('')}>Back</button>
          </div>
        </form>
      )}

      {err && <div className="notice err" role="alert">{err}</div>}
      {future && !o.session_id && mode === '' && <p className="hint">You can confirm it once it has happened.</p>}
      {o.player_ids.length === 1 && <p className="hint" style={{ marginTop: 6 }}><Link href={`/players/${o.player_ids[0]}`}>Open player</Link></p>}
    </li>
  );
}
