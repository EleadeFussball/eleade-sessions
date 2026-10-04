'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { usePlayers } from '@/lib/usePlayers';
import { PlayerPicker } from '@/components/PlayerPicker';
import { ScheduleItem } from '@/components/ScheduleItem';
import { CalendarGrid } from '@/components/CalendarGrid';
import { addDays, fmtDate, isoWeek, todayISO, weekStart } from '@/lib/dates';
import { normaliseTime } from '@/lib/time';
import { entryKey, hhmm, loadSchedule, moveEntry, type ScheduleEntry } from '@/lib/schedule';
import { FORMAT_LABEL, MAX_PLAYERS, type Format } from '@/lib/types';

const FORMATS: Format[] = ['1:1', '2:1', '4:1', 'analysis', 'assessment', 'testing'];
const LENGTHS = [45, 60, 90, 120];

export default function CalendarPage() {
  const { coach, isAdmin } = useAuth();
  const { players, createPlayer } = usePlayers();
  const [view, setView] = useState<'week' | 'day'>('week');
  const [anchor, setAnchor] = useState(todayISO());
  const [mine, setMine] = useState(true);
  const [items, setItems] = useState<ScheduleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [slot, setSlot] = useState<{ day: string; time: string } | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);

  // A phone shows one day, a computer the whole week.
  useEffect(() => {
    const set = () => setView(window.innerWidth >= 700 ? 'week' : 'day');
    set();
    window.addEventListener('resize', set);
    return () => window.removeEventListener('resize', set);
  }, []);

  const days = useMemo(
    () => (view === 'day' ? [anchor] : Array.from({ length: 7 }, (_, i) => addDays(weekStart(anchor), i))),
    [view, anchor],
  );
  const from = days[0];
  const to = days[days.length - 1];

  const load = useCallback(async () => {
    setLoading(true);
    setItems(await loadSchedule(from, to));
    setLoading(false);
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(
    () => (mine && coach ? items.filter((o) => o.coach_id === coach.id) : items),
    [items, mine, coach],
  );
  const open = shown.find((o) => entryKey(o) === openKey) ?? null;
  useEffect(() => {
    if (slot || open) panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [slot, open]);
  const step = view === 'day' ? 1 : 7;
  const today = todayISO();

  async function onMove(o: ScheduleEntry, day: string, time: string) {
    setErr('');
    const { error } = await moveEntry(o, day, time);
    if (error) setErr(errorText(error));
    load();
  }

  return (
    <>
      <div className="toolbar">
        <div className="weeknav">
          <button type="button" aria-label="Back" onClick={() => setAnchor(addDays(anchor, -step))}>‹</button>
          <span>{view === 'day' ? fmtDate(anchor, true) : `Week ${isoWeek(weekStart(anchor))}`}</span>
          <button type="button" aria-label="Forward" onClick={() => setAnchor(addDays(anchor, step))}>›</button>
        </div>
        <button type="button" className="btn small ghost" style={{ flex: '0 0 auto' }}
                onClick={() => setAnchor(today)} disabled={view === 'day' ? anchor === today : weekStart(anchor) === weekStart(today)}>
          Today
        </button>
      </div>
      <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        {coach && (
          <div className="seg" style={{ flex: '1 1 180px' }}>
            <button type="button" aria-pressed={mine} onClick={() => setMine(true)}>Mine</button>
            <button type="button" aria-pressed={!mine} onClick={() => setMine(false)}>All coaches</button>
          </div>
        )}
        <div className="seg" style={{ flex: '0 1 150px' }}>
          <button type="button" aria-pressed={view === 'day'} onClick={() => setView('day')}>Day</button>
          <button type="button" aria-pressed={view === 'week'} onClick={() => setView('week')}>Week</button>
        </div>
      </div>
      {err && <div className="notice err" role="alert">{err}</div>}

      {loading ? <p className="empty">Loading</p> : (
        <CalendarGrid
          days={days} entries={shown} selected={openKey}
          onPickSlot={(day, time) => { setOpenKey(null); setSlot({ day, time }); setErr(''); }}
          onPickEntry={(o) => { setSlot(null); setOpenKey(entryKey(o) === openKey ? null : entryKey(o)); }}
          onMove={onMove}
        />
      )}

      <div ref={panelRef} />
      {slot && (
        <AddSession slot={slot} players={players} createPlayer={createPlayer} onCancel={() => setSlot(null)}
                    onSaved={() => { setSlot(null); load(); }} onError={setErr} />
      )}

      {open && (
        <div className="panel" style={{ padding: '0 14px' }}>
          <ul className="list" style={{ borderTop: 0 }}>
            <ScheduleItem o={open} onDone={() => { setOpenKey(null); load(); }} showDay showCoach={!mine || isAdmin} />
          </ul>
        </div>
      )}
    </>
  );
}

function AddSession({ slot, players, createPlayer, onSaved, onCancel, onError }: {
  slot: { day: string; time: string }; players: ReturnType<typeof usePlayers>['players'];
  createPlayer: ReturnType<typeof usePlayers>['createPlayer'];
  onSaved: () => void; onCancel: () => void; onError: (m: string) => void;
}) {
  const { coach, coaches, isAdmin } = useAuth();
  const [time, setTime] = useState(slot.time);
  const [minutes, setMinutes] = useState(60);
  const [format, setFormat] = useState<Format>('1:1');
  const [ids, setIds] = useState<string[]>([]);
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');
  const [weekly, setWeekly] = useState(false);
  const [coachId, setCoachId] = useState(coach?.id ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => { setTime(slot.time); }, [slot.time, slot.day]);

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
    const who = coachId || coach!.id;
    if (weekly) {
      const { data, error } = await supabase.rpc('create_plan', {
        p_coach_id: who, p_format: format, p_weekday: ((new Date(slot.day).getDay() + 6) % 7) + 1,
        p_start_time: t, p_player_ids: ids, p_location: location, p_starts_on: slot.day,
      });
      if (!error && data) await supabase.rpc('set_plan_minutes', { p_plan_id: data as string, p_minutes: minutes });
      setBusy(false);
      if (error) { onError(errorText(error)); return; }
    } else {
      const { error } = await supabase.rpc('book_session', {
        p_coach_id: who, p_session_date: slot.day, p_start_time: t, p_minutes: minutes,
        p_format: format, p_player_ids: ids, p_location: location, p_note: note,
      });
      setBusy(false);
      if (error) { onError(errorText(error)); return; }
    }
    onSaved();
  }

  return (
    <form onSubmit={save} className="panel-form mt">
      <h2 style={{ marginTop: 0 }}>New session · {fmtDate(slot.day, true)}</h2>
      <div className="row">
        <label className="field" style={{ flex: '0 0 104px' }}><span>Start</span>
          <input type="text" inputMode="numeric" value={time} autoFocus
                 onChange={(e) => setTime(e.target.value)} onBlur={() => setTime(normaliseTime(time) || time)} /></label>
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
      </div>
      <div className="field">
        <span className="fieldlabel">Session type</span>
        <div className="seg">
          {FORMATS.map((f) => <button key={f} type="button" aria-pressed={format === f} onClick={() => pickFormat(f)}>{FORMAT_LABEL[f]}</button>)}
        </div>
      </div>
      <div className="field">
        <span className="fieldlabel">Player{MAX_PLAYERS[format] > 1 ? `s (up to ${MAX_PLAYERS[format]})` : ''}</span>
        <PlayerPicker players={players} selected={ids} max={MAX_PLAYERS[format]} onChange={setIds}
                      onCreate={async (name) => {
                        onError('');
                        try {
                          const id = await createPlayer(name, coachId || coach?.id);
                          setIds(MAX_PLAYERS[format] === 1 ? [id] : [...ids, id]);
                        } catch (e) { onError(errorText(e)); }
                      }} />
      </div>
      <div className="row">
        <label className="field"><span>Location</span>
          <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Moore Park" /></label>
        {!weekly && (
          <label className="field"><span>Note <span className="hint">(optional)</span></span>
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Meet at the car park" /></label>
        )}
      </div>
      <div className="seg" style={{ marginBottom: 14 }}>
        <button type="button" aria-pressed={weekly} onClick={() => setWeekly(!weekly)}>Repeat every week</button>
      </div>
      {weekly && <p className="hint" style={{ marginTop: -8 }}>This slot is kept every week from {fmtDate(slot.day)} until you stop it on the player&apos;s page.</p>}
      {isAdmin && (
        <label className="field"><span>Coach</span>
          <select value={coachId} onChange={(e) => setCoachId(e.target.value)}>
            {coaches.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label>
      )}
      <div className="row">
        <button className="btn small" disabled={busy}>{busy ? 'Saving' : `Add at ${hhmm(normaliseTime(time) || time)}`}</button>
        <button type="button" className="btn small ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
