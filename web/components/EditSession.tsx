'use client';
import { useEffect, useState } from 'react';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { usePlayers } from '@/lib/usePlayers';
import { PlayerPicker } from '@/components/PlayerPicker';
import { normaliseTime } from '@/lib/time';
import { todayISO } from '@/lib/dates';
import { FORMAT_LABEL, MAX_PLAYERS, OUTCOME_LABEL, PAYMENT_LABEL, type Format, type Outcome, type PaymentMethod } from '@/lib/types';

const FORMATS: Format[] = ['1:1', '2:1', '4:1', 'analysis', 'assessment', 'testing'];
const OUTCOMES: Outcome[] = ['attended', 'cancelled_in_time', 'cancelled_late', 'no_show'];
const LENGTHS = [45, 60, 90, 120];

type Row = {
  id: string; session_date: string; start_time: string | null; minutes: number; coach_id: string; format: Format;
  outcome: Outcome; location: string | null; topic: string | null; observations: string | null; improve: string | null;
  payment_method: PaymentMethod | null; session_players: { player_id: string }[];
};

/** Who may edit a completed session: Jan always; a coach their own sessions from the last 30 days. */
export function canEditSession(s: { coach_id: string; session_date: string; imported?: boolean }, isAdmin: boolean, myCoachId?: string) {
  if (isAdmin) return true;
  const cutoff = new Date(todayISO()); cutoff.setDate(cutoff.getDate() - 30);
  return !s.imported && s.coach_id === myCoachId && s.session_date >= cutoff.toISOString().slice(0, 10);
}

/** Full edit of a completed session: date, time, length, type, players, outcome, location, notes and payment. */
export function EditSession({ sessionId, onDone, onCancel, onDelete }:
  { sessionId: string; onDone: () => void; onCancel: () => void; onDelete?: () => void }) {
  const { coaches, isAdmin } = useAuth();
  const { players, createPlayer } = usePlayers(true);
  const [s, setS] = useState<Row | null>(null);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [coachId, setCoachId] = useState('');
  const [format, setFormat] = useState<Format>('1:1');
  const [ids, setIds] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<Outcome>('attended');
  const [location, setLocation] = useState('');
  const [topic, setTopic] = useState('');
  const [obs, setObs] = useState('');
  const [improve, setImprove] = useState('');
  const [method, setMethod] = useState<PaymentMethod | ''>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    supabase.from('sessions').select('*, session_players(player_id)').eq('id', sessionId).single().then(({ data, error }) => {
      if (error || !data) { setErr(error ? errorText(error) : 'Session not found'); return; }
      const r = data as Row;
      setS(r); setDate(r.session_date); setTime(r.start_time ? r.start_time.slice(0, 5) : ''); setMinutes(r.minutes ?? 60);
      setCoachId(r.coach_id); setFormat(r.format); setIds(r.session_players.map((p) => p.player_id)); setOutcome(r.outcome);
      setLocation(r.location ?? ''); setTopic(r.topic ?? ''); setObs(r.observations ?? ''); setImprove(r.improve ?? '');
      setMethod(r.payment_method ?? '');
    });
  }, [sessionId]);

  const max = MAX_PLAYERS[format];
  function pickFormat(f: Format) { setFormat(f); if (ids.length > MAX_PLAYERS[f]) setIds(ids.slice(0, MAX_PLAYERS[f])); }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const t = time.trim() ? normaliseTime(time) : '';
    if (time.trim() && !t) { setErr('Start time not recognised. Type it like 630, 6:30 or 1800.'); return; }
    if (ids.length === 0) { setErr('Pick at least one player.'); return; }
    if ((format === '2:1' || format === '4:1') && ids.length < 2) { setErr(`A ${format} session needs at least 2 players. For one player, choose 1:1.`); return; }
    setBusy(true); setErr('');
    const { error } = await supabase.rpc('edit_session', {
      p_session_id: sessionId, p_session_date: date, p_start_time: t || null, p_minutes: minutes, p_format: format,
      p_outcome: outcome, p_location: location, p_player_ids: ids, p_topic: topic, p_observations: obs, p_improve: improve,
      p_payment_method: method || null, p_coach_id: isAdmin ? coachId : null,
    });
    setBusy(false);
    if (error) setErr(errorText(error)); else onDone();
  }

  if (!s) return err ? <div className="notice err" role="alert">{err}</div> : <p className="empty">Loading</p>;

  return (
    <form className="mt" onSubmit={save}>
      <div className="row">
        <label className="field"><span>Date</span>
          <input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="field" style={{ flex: '0 0 100px' }}><span>Start</span>
          <input type="text" inputMode="numeric" value={time} placeholder="e.g. 1630" onChange={(e) => setTime(e.target.value)}
                 onBlur={() => setTime(normaliseTime(time) || time)} /></label>
      </div>
      <div className="field">
        <span className="fieldlabel">Length</span>
        <div className="seg">
          {LENGTHS.map((m) => (
            <button key={m} type="button" aria-pressed={minutes === m} onClick={() => setMinutes(m)}>
              {m < 60 ? `${m}m` : m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h${m % 60}`}
            </button>
          ))}
        </div>
      </div>
      {isAdmin && (
        <label className="field"><span>Coach</span>
          <select value={coachId} onChange={(e) => setCoachId(e.target.value)}>
            {coaches.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      )}
      <div className="field">
        <span className="fieldlabel">Session type</span>
        <div className="seg">
          {FORMATS.map((f) => <button key={f} type="button" aria-pressed={format === f} onClick={() => pickFormat(f)}>{FORMAT_LABEL[f]}</button>)}
        </div>
      </div>
      <div className="field">
        <span className="fieldlabel">{max === 1 ? 'Player' : `Players (up to ${max})`}</span>
        <PlayerPicker players={players} selected={ids} max={max} onChange={setIds}
                      onCreate={async (name) => { const id = await createPlayer(name, coachId); if (id) setIds([...ids, id].slice(0, max)); }} />
      </div>
      <div className="field">
        <span className="fieldlabel">Outcome</span>
        <div className="seg outcomes">
          {OUTCOMES.map((o) => <button key={o} type="button" aria-pressed={outcome === o} onClick={() => setOutcome(o)}>{OUTCOME_LABEL[o]}</button>)}
        </div>
      </div>
      {outcome !== 'cancelled_in_time' && format !== 'testing' && (
        <div className="field">
          <span className="fieldlabel">How was it paid?</span>
          <div className="seg">
            <button type="button" aria-pressed={method === ''} onClick={() => setMethod('')}>{format === 'assessment' ? 'Not paid yet' : 'Package credit'}</button>
            {(['cash', 'stripe', 'bank'] as PaymentMethod[]).map((m) => (
              <button key={m} type="button" aria-pressed={method === m} onClick={() => setMethod(m)}>{m === 'cash' ? 'Paid cash' : PAYMENT_LABEL[m]}</button>
            ))}
          </div>
        </div>
      )}
      <label className="field"><span>Location</span><input type="text" value={location} onChange={(e) => setLocation(e.target.value)} /></label>
      <label className="field"><span>What you worked on</span><textarea value={topic} onChange={(e) => setTopic(e.target.value)} /></label>
      <label className="field"><span>How it went</span><textarea value={obs} onChange={(e) => setObs(e.target.value)} /></label>
      <label className="field"><span>Next session</span><textarea value={improve} onChange={(e) => setImprove(e.target.value)} style={{ minHeight: 64 }} /></label>
      <p className="hint">Credits and coach pay update automatically. If the session was already on an invoice, the difference appears as a correction on the next one.</p>
      {err && <div className="notice err" role="alert">{err}</div>}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn small" disabled={busy}>{busy ? 'Saving' : 'Save changes'}</button>
        <button type="button" className="btn small ghost" onClick={onCancel}>Cancel</button>
        {onDelete && <button type="button" className="btn small ghost" onClick={onDelete} style={{ color: 'var(--red)' }}>Delete session</button>}
      </div>
    </form>
  );
}
