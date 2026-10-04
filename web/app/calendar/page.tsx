'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { usePlayers } from '@/lib/usePlayers';
import { PlayerPicker } from '@/components/PlayerPicker';
import { ScheduleItem } from '@/components/ScheduleItem';
import { addDays, fmtDate, isoWeek, todayISO, weekStart } from '@/lib/dates';
import { normaliseTime } from '@/lib/time';
import { entryKey, loadSchedule, type ScheduleEntry } from '@/lib/schedule';
import { FORMAT_LABEL, MAX_PLAYERS, type Format } from '@/lib/types';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const FORMATS: Format[] = ['1:1', '2:1', '4:1', 'analysis', 'assessment', 'testing'];

export default function CalendarPage() {
  const { coach, coaches, isAdmin } = useAuth();
  const { players } = usePlayers();
  const [start, setStart] = useState(weekStart(todayISO()));
  const [mine, setMine] = useState(true);
  const [items, setItems] = useState<ScheduleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [addDay, setAddDay] = useState('');
  const [err, setErr] = useState('');

  const end = addDays(start, 6);
  const load = useCallback(async () => {
    setLoading(true);
    setItems(await loadSchedule(start, end));
    setLoading(false);
  }, [start, end]);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(
    () => (mine && coach ? items.filter((o) => o.coach_id === coach.id) : items),
    [items, mine, coach],
  );
  const byDay = useMemo(() => {
    const m = new Map<string, ScheduleEntry[]>();
    for (let i = 0; i < 7; i++) m.set(addDays(start, i), []);
    for (const o of shown) m.get(o.session_date)?.push(o);
    for (const list of m.values()) list.sort((a, b) => a.start_time.localeCompare(b.start_time));
    return [...m.entries()];
  }, [shown, start]);

  const today = todayISO();
  return (
    <>
      <h1>Calendar</h1>
      <div className="toolbar">
        <div className="weeknav">
          <button type="button" aria-label="Previous week" onClick={() => setStart(addDays(start, -7))}>‹</button>
          <span>Week {isoWeek(start)}</span>
          <button type="button" aria-label="Next week" onClick={() => setStart(addDays(start, 7))}>›</button>
        </div>
        <button type="button" className="btn small ghost" style={{ flex: '0 0 auto' }}
                onClick={() => setStart(weekStart(today))} disabled={start === weekStart(today)}>This week</button>
      </div>
      <p className="muted">{fmtDate(start)} to {fmtDate(end)}</p>
      {coach && (
        <div className="seg" style={{ marginBottom: 14 }}>
          <button type="button" aria-pressed={mine} onClick={() => setMine(true)}>My sessions</button>
          <button type="button" aria-pressed={!mine} onClick={() => setMine(false)}>All coaches</button>
        </div>
      )}
      {err && <div className="notice err" role="alert">{err}</div>}

      {loading ? <p className="empty">Loading</p> : byDay.map(([day, list]) => (
        <section key={day} className={`cal-day${day === today ? ' today' : ''}${list.length === 0 ? ' empty-day' : ''}`}>
          <div className="cal-head">
            <h2>{DAYS[(new Date(day).getDay() + 6) % 7]} {fmtDate(day)}{day === today ? ' · today' : ''}
              {list.length > 0 && <span className="cal-count">{list.length}</span>}</h2>
            <button type="button" className="linkbtn" onClick={() => { setAddDay(addDay === day ? '' : day); setErr(''); }}>
              {addDay === day ? 'Close' : 'Add'}
            </button>
          </div>
          {addDay === day && (
            <AddSession day={day} players={players} onCancel={() => setAddDay('')}
                        onSaved={() => { setAddDay(''); load(); }} onError={setErr} />
          )}
          {list.length > 0 && (
            <ul className="list">
              {list.map((o) => <ScheduleItem key={entryKey(o)} o={o} onDone={load} showCoach={!mine || isAdmin} />)}
            </ul>
          )}
        </section>
      ))}
      <p className="hint mt">Weekly regular sessions appear here automatically. Set them up on a player&apos;s page.</p>
    </>
  );
}

function AddSession({ day, players, onSaved, onCancel, onError }: {
  day: string; players: ReturnType<typeof usePlayers>['players'];
  onSaved: () => void; onCancel: () => void; onError: (m: string) => void;
}) {
  const { coach, coaches, isAdmin } = useAuth();
  const [time, setTime] = useState('');
  const [format, setFormat] = useState<Format>('1:1');
  const [ids, setIds] = useState<string[]>([]);
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');
  const [coachId, setCoachId] = useState(coach?.id ?? '');
  const [busy, setBusy] = useState(false);

  function pickFormat(f: Format) {
    setFormat(f);
    if (ids.length > MAX_PLAYERS[f]) setIds(ids.slice(0, MAX_PLAYERS[f]));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault(); onError('');
    const t = normaliseTime(time);
    if (!t) { onError('Add a start time, like 630, 6:30 or 1800.'); return; }
    if (ids.length === 0) { onError('Pick at least one player.'); return; }
    setBusy(true);
    const { error } = await supabase.rpc('create_booking', {
      p_coach_id: coachId || coach!.id, p_session_date: day, p_start_time: t, p_format: format,
      p_player_ids: ids, p_location: location, p_note: note,
    });
    setBusy(false);
    if (error) onError(errorText(error)); else onSaved();
  }

  return (
    <form onSubmit={save} className="panel-form" style={{ marginBottom: 12 }}>
      <div className="row">
        <label className="field" style={{ flex: '0 0 110px' }}><span>Start</span>
          <input type="text" inputMode="numeric" value={time} placeholder="e.g. 1600" autoFocus
                 onChange={(e) => setTime(e.target.value)} onBlur={() => setTime(normaliseTime(time) || time)} /></label>
        <label className="field"><span>Location</span>
          <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Moore Park" /></label>
      </div>
      <div className="field">
        <span className="fieldlabel">Session type</span>
        <div className="seg">
          {FORMATS.map((f) => <button key={f} type="button" aria-pressed={format === f} onClick={() => pickFormat(f)}>{FORMAT_LABEL[f]}</button>)}
        </div>
      </div>
      <div className="field">
        <span className="fieldlabel">Player{MAX_PLAYERS[format] > 1 ? `s (up to ${MAX_PLAYERS[format]})` : ''}</span>
        <PlayerPicker players={players} selected={ids} max={MAX_PLAYERS[format]} onChange={setIds} />
      </div>
      <label className="field"><span>Note <span className="hint">(optional)</span></span>
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Meet at the car park" /></label>
      {isAdmin && (
        <label className="field"><span>Coach</span>
          <select value={coachId} onChange={(e) => setCoachId(e.target.value)}>
            {coaches.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label>
      )}
      <div className="row">
        <button className="btn small" disabled={busy}>{busy ? 'Saving' : 'Add to calendar'}</button>
        <button type="button" className="btn small ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
