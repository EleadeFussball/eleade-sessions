'use client';
import { useCallback, useEffect, useState } from 'react';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { usePlayers } from '@/lib/usePlayers';
import { PlayerPicker } from '@/components/PlayerPicker';
import { useLastLocation } from '@/lib/useLastLocation';
import { fmtDate, todayISO } from '@/lib/dates';
import { normaliseTime } from '@/lib/time';
import { FORMAT_LABEL, MAX_PLAYERS, placeField, placeLabel, type Format } from '@/lib/types';

type Plan = { id: string; coach_id: string; format: Format; weekday: number; start_time: string; location: string | null; minutes: number;
  starts_on: string; ends_on: string | null; plan_players: { player_id: string; players: { name: string } | null }[] };

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const FORMATS: Format[] = ['1:1', '2:1', '4:1', 'analysis'];

export function RegularSessions({ playerId }: { playerId: string }) {
  const { coach, coaches, isAdmin } = useAuth();
  const { players, createPlayer } = usePlayers(true);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [adding, setAdding] = useState(false);
  const [weekday, setWeekday] = useState(0);
  const [time, setTime] = useState('');
  const [format, setFormat] = useState<Format>('1:1');
  const [ids, setIds] = useState<string[]>([playerId]);
  const [location, setLocation] = useState('');
  const loc = useLastLocation(ids[0], setLocation, format === 'analysis');
  const [startsOn, setStartsOn] = useState(todayISO());
  const [coachId, setCoachId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [changing, setChanging] = useState<Plan | null>(null);
  const [cDay, setCDay] = useState(0);
  const [cTime, setCTime] = useState('');
  const [cMinutes, setCMinutes] = useState(60);
  const [cLocation, setCLocation] = useState('');
  const [cFrom, setCFrom] = useState(todayISO());

  const load = useCallback(async () => {
    const { data: links } = await supabase.from('plan_players').select('plan_id').eq('player_id', playerId);
    const planIds = (links ?? []).map((l: { plan_id: string }) => l.plan_id);
    if (!planIds.length) { setPlans([]); return; }
    const { data } = await supabase.from('session_plans')
      .select('*, plan_players(player_id, players(name))').in('id', planIds).order('weekday');
    setPlans((data as unknown as Plan[]) ?? []);
  }, [playerId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (coach && !coachId) setCoachId(coach.id); }, [coach, coachId]);

  const today = todayISO();
  const current = plans.filter((p) => !p.ends_on || p.ends_on > today);
  const coachName = (id: string) => coaches.find((c) => c.id === id)?.name ?? '';
  const canManage = (p: Plan) => isAdmin || p.coach_id === coach?.id;

  function pickFormat(f: Format) {
    setFormat(f);
    if (ids.length > MAX_PLAYERS[f]) setIds([playerId]);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    const t = normaliseTime(time);
    if (!t) { setErr('Add a start time, like 630, 6:30 or 1800.'); return; }
    if ((format === '2:1' || format === '4:1') && ids.length < 2) { setErr(`Add the other player for a ${format} session.`); return; }
    setBusy(true);
    const { error } = await supabase.rpc('create_plan', {
      p_coach_id: coachId || coach!.id, p_format: format, p_weekday: weekday + 1, p_start_time: t,
      p_player_ids: ids, p_location: location, p_starts_on: startsOn,
    });
    setBusy(false);
    if (error) { setErr(errorText(error)); return; }
    setAdding(false); setTime(''); setLocation(''); setIds([playerId]); setFormat('1:1');
    load();
  }

  function startChange(p: Plan) {
    setChanging(p); setErr('');
    setCDay(p.weekday - 1); setCTime(p.start_time.slice(0, 5)); setCMinutes(p.minutes || 60);
    setCLocation(p.location ?? ''); setCFrom(p.starts_on > todayISO() ? p.starts_on : todayISO());
  }

  async function saveChange(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    if (!changing) return;
    const t = normaliseTime(cTime);
    if (!t) { setErr('Add a start time, like 630, 6:30 or 1800.'); return; }
    setBusy(true);
    const { error } = await supabase.rpc('change_plan', {
      p_plan_id: changing.id, p_from: cFrom, p_weekday: cDay + 1, p_start_time: t, p_minutes: cMinutes, p_location: cLocation,
    });
    setBusy(false);
    if (error) { setErr(errorText(error)); return; }
    setChanging(null);
    load();
  }

  async function stop(p: Plan) {
    if (!window.confirm(`Stop the regular ${DAYS[p.weekday - 1]} session?\n\nAll upcoming sessions are removed from the calendar and the week view. Past sessions stay in the history.`)) return;
    const { error } = await supabase.rpc('stop_plan', { p_plan_id: p.id });
    if (error) setErr(errorText(error)); else load();
  }

  return (
    <>
      <h2>Regular sessions</h2>
      {current.length === 0 && !adding && <p className="empty">No regular sessions set up.</p>}
      {current.length > 0 && (
        <ul className="list">
          {current.map((p) => (
            <li key={p.id} className="session">
              <div className="head">
                <span>{DAYS[p.weekday - 1]}s at {p.start_time.slice(0, 5)}</span>
                {canManage(p) && (
                  <span>
                    <button type="button" className="linkbtn" onClick={() => startChange(p)}>Change</button>{' '}
                    <button type="button" className="linkbtn" onClick={() => stop(p)}>Stop</button>
                  </span>
                )}
              </div>
              <div className="sub">
                {FORMAT_LABEL[p.format]} with {coachName(p.coach_id)}{p.location ? `, ${placeLabel(p.format, p.location)}` : ''}
                {p.plan_players.length > 1 ? `, together with ${p.plan_players.filter((x) => x.player_id !== playerId).map((x) => x.players?.name).join(', ')}` : ''}
                {p.starts_on > today ? `, starts ${fmtDate(p.starts_on)}` : ''}
              </div>
              {changing?.id === p.id && (
                <form onSubmit={saveChange} className="panel-form mt">
                  <div className="field">
                    <span className="fieldlabel">New day</span>
                    <div className="seg">
                      {DAYS.map((d, i) => <button key={d} type="button" aria-pressed={cDay === i} onClick={() => setCDay(i)}>{d.slice(0, 3)}</button>)}
                    </div>
                  </div>
                  <div className="row">
                    <label className="field" style={{ flex: '0 0 120px' }}><span>Start</span>
                      <input type="text" inputMode="numeric" value={cTime} onChange={(e) => setCTime(e.target.value)}
                             onBlur={() => setCTime(normaliseTime(cTime) || cTime)} /></label>
                    <label className="field"><span>{placeField(p.format).label}</span>
                      <input type="text" list={p.format === 'analysis' ? undefined : 'pitches'} value={cLocation} onChange={(e) => setCLocation(e.target.value)} /></label>
                  </div>
                  <div className="field">
                    <span className="fieldlabel">Length</span>
                    <div className="seg">
                      {[45, 60, 90, 120].map((m) => (
                        <button key={m} type="button" aria-pressed={cMinutes === m} onClick={() => setCMinutes(m)}>
                          {m < 60 ? `${m}m` : m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h${m % 60}`}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="field"><span>Change starts from</span>
                    <input type="date" min={todayISO()} value={cFrom} onChange={(e) => setCFrom(e.target.value)} /></label>
                  <p className="hint">Sessions before this date stay as they are. From this date the session follows the new day and time. For a single week only, use Move on the calendar instead.</p>
                  {err && <div className="notice err" role="alert">{err}</div>}
                  <div className="row">
                    <button className="btn small" disabled={busy}>{busy ? 'Saving' : 'Save change'}</button>
                    <button type="button" className="btn small ghost" onClick={() => { setChanging(null); setErr(''); }}>Cancel</button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      {!adding ? (
        <button type="button" className="btn small ghost mt" onClick={() => setAdding(true)}>Add a regular session</button>
      ) : (
        <form onSubmit={save} className="panel-form mt">
          <div className="field">
            <span className="fieldlabel">Day</span>
            <div className="seg">
              {DAYS.map((d, i) => <button key={d} type="button" aria-pressed={weekday === i} onClick={() => setWeekday(i)}>{d.slice(0, 3)}</button>)}
            </div>
          </div>
          <div className="row">
            <label className="field" style={{ flex: '0 0 120px' }}><span>Start</span>
              <input type="text" inputMode="numeric" value={time} placeholder="e.g. 630" onChange={(e) => setTime(e.target.value)}
                     onBlur={() => setTime(normaliseTime(time) || time)} /></label>
            <label className="field"><span>{placeField(format).label}</span>
              <input type="text" list={format === 'analysis' ? undefined : 'pitches'} value={location} onChange={(e) => loc.edit(e.target.value)} placeholder={placeField(format).placeholder} /></label>
          </div>
          <div className="field">
            <span className="fieldlabel">Session type</span>
            <div className="seg">
              {FORMATS.map((f) => <button key={f} type="button" aria-pressed={format === f} onClick={() => pickFormat(f)}>{FORMAT_LABEL[f]}</button>)}
            </div>
          </div>
          {(format === '2:1' || format === '4:1') && (
            <div className="field">
              <span className="fieldlabel">Players (up to {MAX_PLAYERS[format]})</span>
              <PlayerPicker players={players} selected={ids} max={MAX_PLAYERS[format]}
                            onChange={(next) => setIds(next.includes(playerId) ? next : [playerId, ...next])}
                            onCreate={async (name) => {
                              setErr('');
                              const id = await createPlayer(name, coachId || coach?.id);
                              setIds([...ids, id]);
                            }} />
            </div>
          )}
          <div className="row">
            <label className="field"><span>First session from</span>
              <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></label>
            {isAdmin && (
              <label className="field"><span>Coach</span>
                <select value={coachId} onChange={(e) => setCoachId(e.target.value)}>
                  {coaches.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select></label>
            )}
          </div>
          {err && <div className="notice err" role="alert">{err}</div>}
          <div className="row">
            <button className="btn small" disabled={busy}>{busy ? 'Saving' : 'Save regular session'}</button>
            <button type="button" className="btn small ghost" onClick={() => { setAdding(false); setErr(''); }}>Cancel</button>
          </div>
        </form>
      )}
    </>
  );
}
