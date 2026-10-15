'use client';
import { useState } from 'react';
import Link from 'next/link';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { addDays, fmtDate, todayISO } from '@/lib/dates';
import { normaliseTime } from '@/lib/time';
import { FORMAT_LABEL, OUTCOME_LABEL, placeLabel, type Outcome } from '@/lib/types';
import { cancelEntry, canComplete, completeFrom, hhmm, moveEntry, savePrep, timeRange, type ScheduleEntry } from '@/lib/schedule';
import { LogFlow } from '@/components/LogFlow';
import { EditSession, canEditSession } from '@/components/EditSession';

/** One planned session, with the actions a coach needs: done, cancelled, moved, removed. */
export function ScheduleItem({ o, onDone, showDay = false, showCoach = false, startMode = '' }:
  { o: ScheduleEntry; onDone: () => void; showDay?: boolean; showCoach?: boolean; startMode?: '' | 'done' | 'plan' }) {
  const { coach, coaches, isAdmin } = useAuth();
  const loggable = !o.session_id && o.kind !== 'logged' && (isAdmin || o.coach_id === coach?.id);
  const [mode, setMode] = useState<'' | 'log' | 'move' | 'edit' | 'plan'>(
    startMode === 'done' ? (loggable ? 'log' : '') : startMode === 'plan' ? 'plan' : '');
  const [plan, setPlan] = useState(o.prep ?? '');
  const [newDate, setNewDate] = useState(o.session_date);
  const [newTime, setNewTime] = useState(hhmm(o.start_time));
  const [minutes, setMinutes] = useState(o.minutes);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const future = o.session_date > todayISO();
  const mine = isAdmin || o.coach_id === coach?.id;
  const completable = canComplete(o, isAdmin);
  const coachName = coaches.find((c) => c.id === o.coach_id)?.name ?? '';

  async function move(e: React.FormEvent) {
    e.preventDefault();
    const t = normaliseTime(newTime);
    if (!t) { setErr('Start time not recognised. Type it like 630, 6:30 or 1800.'); return; }
    setBusy(true); setErr('');
    const { error } = await moveEntry(o, newDate, t, minutes);
    setBusy(false);
    if (error) setErr(errorText(error)); else { setMode(''); onDone(); }
  }

  async function savePlan() {
    setBusy(true); setErr('');
    const { error } = await savePrep(o, plan);
    setBusy(false);
    if (error) setErr(errorText(error)); else { setMode(''); onDone(); }
  }

  async function undoCancel() {
    if (!o.session_id) return;
    setBusy(true); setErr('');
    const { error } = await supabase.rpc('undo_cancellation', { p_session_id: o.session_id });
    setBusy(false);
    if (error) setErr(errorText(error)); else onDone();
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
      <div className={loggable && mode === '' ? 'head tappable' : 'head'} role={loggable && mode === '' ? 'button' : undefined}
           tabIndex={loggable && mode === '' ? 0 : undefined} onClick={() => { if (loggable && mode === '') setMode('log'); }}
           onKeyDown={(e) => { if (loggable && mode === '' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setMode('log'); } }}>
        <span>{showDay ? `${fmtDate(o.session_date, true)}, ` : ''}{timeRange(o.start_time, o.minutes) || 'No time set'} · {o.players}</span>
        {o.session_id
          ? <span className={o.outcome === 'attended' ? 'tag turf' : 'tag amber'}>{OUTCOME_LABEL[o.outcome as Outcome]}</span>
          : o.moved ? <span className="tag">Moved</span>
          : o.kind === 'regular' ? <span className="tag">Weekly</span> : null}
      </div>
      <div className="sub">
        {FORMAT_LABEL[o.format]}{o.location ? `, ${placeLabel(o.format, o.location)}` : ''}{showCoach && coachName ? ` · ${coachName}` : ''}
      </div>
      {o.note && <div className="sub">{o.note}</div>}
      {o.prep && mode !== 'plan' && <div className="prep"><span className="prep-label">Plan</span> {o.prep}</div>}

      {o.session_id && mode === '' && canEditSession(o, isAdmin, coach?.id) && (
        <div className="row mt" style={{ flexWrap: 'wrap' }}>
          {o.outcome === 'cancelled_in_time' && mine && (
            <button type="button" className="btn small" disabled={busy} onClick={undoCancel}>Undo cancellation</button>
          )}
          <button type="button" className="btn small ghost" onClick={() => setMode('edit')}>Edit session</button>
        </div>
      )}
      {mode === 'edit' && o.session_id && (
        <EditSession sessionId={o.session_id} onCancel={() => setMode('')} onDone={() => { setMode(''); onDone(); }} />
      )}
      {o.kind !== 'logged' && !o.session_id && mode === '' && mine && (
        <div className="row mt" style={{ flexWrap: 'wrap' }}>
          <button type="button" className="btn small ghost" onClick={() => setMode('plan')}>{o.prep ? 'Edit plan' : 'Plan session'}</button>
          {future
            ? <button type="button" className="btn small ghost" onClick={() => setMode('log')}>Cancel in advance</button>
            : <button type="button" className="btn small" onClick={() => setMode('log')}>Log session</button>}
          <button type="button" className="btn small ghost" onClick={() => setMode('move')}>Move</button>
          {o.kind === 'once' && <button type="button" className="btn small ghost" disabled={busy} onClick={remove}>Remove</button>}
        </div>
      )}

      {mode === 'plan' && (
        <div className="mt">
          <label className="field"><span>What you will work on</span>
            <textarea value={plan} onChange={(e) => setPlan(e.target.value)} autoFocus
                      placeholder="e.g. Receiving on the half turn, weak foot finishing, 1v1 to goal" /></label>
          <p className="hint">Optional. Your plan is used as &quot;What you worked on&quot; when you complete the session, so afterwards you only add how it went and the next session. You can still change it then.</p>
          <div className="row">
            <button type="button" className="btn small" disabled={busy} onClick={savePlan}>{busy ? 'Saving' : 'Save plan'}</button>
            <button type="button" className="btn small ghost" onClick={() => { setPlan(o.prep ?? ''); setMode(''); }}>Back</button>
          </div>
        </div>
      )}

      {mode === 'log' && <LogFlow o={o} onCancel={() => setMode('')} onDone={() => { setMode(''); onDone(); }} />}

      {mode === 'move' && (
        <form className="mt" onSubmit={move}>
          <div className="row">
            <label className="field"><span>New day</span>
              <input type="date" value={newDate}
                     min={o.kind === 'regular' && o.plan_date ? addDays(o.plan_date, -14) : undefined}
                     max={o.kind === 'regular' && o.plan_date ? addDays(o.plan_date, 14) : undefined}
                     onChange={(e) => setNewDate(e.target.value)} /></label>
            <label className="field" style={{ flex: '0 0 100px' }}><span>Start</span>
              <input type="text" inputMode="numeric" value={newTime} onChange={(e) => setNewTime(e.target.value)}
                     onBlur={() => setNewTime(normaliseTime(newTime) || newTime)} /></label>
          </div>
          <div className="field">
            <span className="fieldlabel">Length</span>
            <div className="seg">
              {[45, 60, 90, 120].map((m) => (
                <button key={m} type="button" aria-pressed={minutes === m} onClick={() => setMinutes(m)}>
                  {m < 60 ? `${m}m` : m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h${m % 60}`}
                </button>
              ))}
            </div>
          </div>
          {o.kind === 'regular' && <p className="hint">A weekly session can be moved up to two weeks either way. Only this week moves; a new length applies every week.</p>}
          <div className="row">
            <button className="btn small" disabled={busy}>{busy ? 'Saving' : 'Move session'}</button>
            <button type="button" className="btn small ghost" onClick={() => setMode('')}>Back</button>
          </div>
        </form>
      )}

      {err && <div className="notice err" role="alert">{err}</div>}
      {!completable && !future && !o.session_id && o.kind !== 'logged' && mode === '' && mine && o.start_time && (
        <p className="hint">You can log it as attended from {completeFrom(o)}, five minutes after it ends. A cancellation or no-show can be logged now.</p>
      )}
      {!mine && !o.session_id && <p className="hint">{coachName}&apos;s session.</p>}
      {o.player_ids?.length === 1 && <p className="hint" style={{ marginTop: 6 }}><Link href={`/players/${o.player_ids[0]}`}>Open player</Link></p>}
    </li>
  );
}
