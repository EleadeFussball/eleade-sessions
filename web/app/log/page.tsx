'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { usePlayers } from '@/lib/usePlayers';
import { PlayerPicker } from '@/components/PlayerPicker';
import { PlannedSessions } from '@/components/PlannedSessions';
import { normaliseTime } from '@/lib/time';
import { todayISO, addDays, fmtDate, num } from '@/lib/dates';
import { FORMAT_LABEL, OUTCOME_LABEL, OUTCOME_HINT, MAX_PLAYERS, PAYMENT_LABEL, type Format, type Outcome, type PaymentMethod, type PlayerBalance } from '@/lib/types';

const FORMATS: Format[] = ['1:1', '2:1', '4:1', 'analysis', 'assessment', 'testing'];
const ASSESSMENT_HINT: Record<Outcome, string> = {
  attended: 'Charged $130, coach paid',
  cancelled_in_time: '12+ hours notice: free, not paid',
  cancelled_late: 'Charged $130, coach paid',
  no_show: 'Charged $130, coach paid',
};
const OUTCOMES: Outcome[] = ['attended', 'cancelled_in_time', 'cancelled_late', 'no_show'];

type Saved = { names: string[]; date: string; outcome: Outcome; format: Format; after: PlayerBalance[] };

export default function LogPage() {
  const { coach, coaches, isAdmin } = useAuth();
  const { players, reload, createPlayer } = usePlayers();
  const [date, setDate] = useState(todayISO());
  const [format, setFormat] = useState<Format>('1:1');
  const [ids, setIds] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<Outcome>('attended');
  const [coachId, setCoachId] = useState('');
  const [location, setLocation] = useState('');
  const [time, setTime] = useState('');
  const [topic, setTopic] = useState('');
  const [obs, setObs] = useState('');
  const [improve, setImprove] = useState('');
  const [payMethod, setPayMethod] = useState<PaymentMethod | ''>('');
  const [locations, setLocations] = useState<string[]>([]);
  const [locOpen, setLocOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState<Saved | null>(null);

  useEffect(() => { if (coach && !coachId) setCoachId(coach.id); }, [coach, coachId]);
  useEffect(() => {
    supabase.from('sessions').select('location').not('location', 'is', null)
      .order('session_date', { ascending: false }).limit(400)
      .then(({ data }) => {
        const counts = new Map<string, number>();
        (data ?? []).forEach((r: { location: string | null }) => {
          const l = (r.location ?? '').trim();
          if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
        });
        setLocations([...counts.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l).slice(0, 30));
      });
  }, []);

  const locQuery = location.trim().toLowerCase();
  const locMatches = locQuery
    ? locations.filter((l) => l.toLowerCase() !== locQuery &&
        (l.toLowerCase().startsWith(locQuery) || l.toLowerCase().split(/\s+/).some((w) => w.startsWith(locQuery)))).slice(0, 6)
    : locations.slice(0, 6);
  const max = MAX_PLAYERS[format];
  const chosen = ids.map((id) => players.find((p) => p.player_id === id)).filter(Boolean) as PlayerBalance[];
  const isAssessment = format === 'assessment';
  const empty = isAssessment ? [] : chosen.filter((p) => p.billing_model === 'package' && Number(p.sessions_left ?? 0) <= 0);
  const showNotes = outcome === 'attended';

  function pickFormat(f: Format) {
    setFormat(f);
    if (ids.length > MAX_PLAYERS[f]) setIds(ids.slice(0, MAX_PLAYERS[f]));
  }

  async function addPlayer(name: string) {
    setErr('');
    try {
      const id = await createPlayer(name, coach?.id);
      setIds(max === 1 ? [id] : [...ids, id]);
    } catch (e) { setErr(errorText(e)); }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    if (!ids.length) { setErr('Pick the player first.'); return; }
    if ((format === '2:1' || format === '4:1') && ids.length < 2) { setErr(`A ${format} session needs at least 2 players.`); return; }
    if (time.trim() && !normaliseTime(time)) { setErr('Start time not recognised. Type it like 630, 6:30 or 1800.'); return; }
    setBusy(true);
    const { error } = await supabase.rpc('log_session', {
      p_session_date: date, p_coach_id: coachId || coach!.id, p_format: format, p_outcome: outcome,
      p_player_ids: ids, p_location: location.trim() || null, p_start_time: normaliseTime(time) || null,
      p_topic: showNotes ? topic.trim() || null : null,
      p_observations: obs.trim() || null,
      p_improve: showNotes ? improve.trim() || null : null,
      p_payment_method: payMethod && (isAssessment || payMethod === 'cash') && outcome !== 'cancelled_in_time' ? payMethod : null,
    });
    setBusy(false);
    if (error) { setErr(errorText(error)); return; }
    const names = chosen.map((p) => p.name);
    const { data } = await supabase.from('player_balances').select('*').in('player_id', ids);
    setSaved({ names, date, outcome, format, after: (data as PlayerBalance[]) ?? [] });
    reload();
    setIds([]); setTopic(''); setObs(''); setImprove(''); setOutcome('attended'); setTime(''); setPayMethod('');
    window.scrollTo({ top: 0 });
  }

  return (
    <>
      <PlannedSessions onChanged={reload} />
      <h1>Log a session</h1>
      <p className="hint" style={{ marginTop: -4 }}>For a session that isn&apos;t a regular one. Set up regular sessions on the player&apos;s page.</p>
      {saved && (
        <div className="notice ok" role="status">
          <strong>{saved.format === 'assessment' ? 'Assessment logged.' : 'Session logged.'}</strong> {saved.names.join(' and ')}, {fmtDate(saved.date, true)}, {OUTCOME_LABEL[saved.outcome].toLowerCase()}.
          {saved.format === 'assessment' ? (
            <div>
              Jan will check the $130 payment. If the parents buy a package, record it on{' '}
              {saved.after.map((p) => <Link key={p.player_id} href={`/players/${p.player_id}`}>{p.name}&apos;s page</Link>)}.
            </div>
          ) : saved.after.map((p) => (
            <div key={p.player_id}>
              {p.name}: {p.billing_model === 'package' ? `${num(p.sessions_left)} ${Number(p.sessions_left) === 1 ? 'session' : 'sessions'} left` : 'pays weekly'}
              {p.billing_model === 'package' && Number(p.sessions_left) <= 2 && ' (Jan will contact the parents about renewing)'}
            </div>
          ))}
        </div>
      )}

      <form onSubmit={save}>
        <div className="field">
          <span className="fieldlabel">Date</span>
          <div className="seg">
            <button type="button" aria-pressed={date === todayISO()} onClick={() => setDate(todayISO())}>Today</button>
            <button type="button" aria-pressed={date === addDays(todayISO(), -1)} onClick={() => setDate(addDays(todayISO(), -1))}>Yesterday</button>
            <input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} aria-label="Other date" style={{ flex: '1 1 160px' }} />
          </div>
        </div>

        <div className="field">
          <span className="fieldlabel">Session type</span>
          <div className="seg">
            {FORMATS.map((f) => (
              <button key={f} type="button" aria-pressed={format === f} onClick={() => pickFormat(f)}>{FORMAT_LABEL[f]}</button>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="fieldlabel">{max === 1 ? 'Player' : `Players (up to ${max})`}</span>
          <PlayerPicker players={players} selected={ids} max={max} onChange={setIds} onCreate={addPlayer} />
          {empty.length > 0 && (
            <div className="notice warn">
              {empty.map((p) => p.name).join(' and ')} {empty.length > 1 ? 'have' : 'has'} no credits left. You can still log the session. Jan will follow up with the parents.
            </div>
          )}
        </div>

        <div className="field">
          <span className="fieldlabel">Session confirmation &amp; payment</span>
          <div className="seg outcomes">
            {OUTCOMES.map((o) => (
              <button key={o} type="button" aria-pressed={outcome === o} onClick={() => setOutcome(o)}>
                {OUTCOME_LABEL[o]}<small>{isAssessment ? ASSESSMENT_HINT[o] : OUTCOME_HINT[o]}</small>
              </button>
            ))}
          </div>
        </div>

        {isAssessment && outcome !== 'cancelled_in_time' && (
          <div className="field">
            <span className="fieldlabel">How did the parents pay the $130? <span className="hint">(Jan confirms it)</span></span>
            <div className="seg">
              {(['stripe', 'bank', 'cash'] as PaymentMethod[]).map((m) => (
                <button key={m} type="button" aria-pressed={payMethod === m} onClick={() => setPayMethod(payMethod === m ? '' : m)}>{m === 'cash' ? 'Paid cash' : PAYMENT_LABEL[m]}</button>
              ))}
              <button type="button" aria-pressed={payMethod === ''} onClick={() => setPayMethod('')}>Not paid yet</button>
            </div>
          </div>
        )}
        {!isAssessment && outcome !== 'cancelled_in_time' && format !== 'testing' && (
          <div className="field">
            <div className="seg">
              <button type="button" aria-pressed={payMethod === 'cash'} onClick={() => setPayMethod(payMethod === 'cash' ? '' : 'cash')}>
                Paid cash
              </button>
            </div>
            <p className="hint mt">
              {payMethod === 'cash'
                ? 'Paid in cash today: no package credit is used and it isn’t added to a weekly transfer. Jan confirms the cash.'
                : 'Tap if the parents paid you in cash for this session.'}
            </p>
          </div>
        )}

        <div className="row">
          <div className="field" style={{ position: 'relative' }}>
            <label htmlFor="loc" className="fieldlabel">Location</label>
            <input id="loc" type="text" autoComplete="off" value={location} placeholder="e.g. Moore Park"
                   onChange={(e) => { setLocation(e.target.value); setLocOpen(true); }}
                   onFocus={() => setLocOpen(true)} onBlur={() => setTimeout(() => setLocOpen(false), 150)} />
            {locOpen && locMatches.length > 0 && (
              <ul className="results" role="listbox" aria-label="Locations">
                {locMatches.map((l) => (
                  <li key={l}><button type="button" onMouseDown={(e) => e.preventDefault()}
                                      onClick={() => { setLocation(l); setLocOpen(false); }}>{l}</button></li>
                ))}
              </ul>
            )}
          </div>
          <label className="field" style={{ flex: '0 0 110px' }}>
            <span>Start</span>
            <input type="text" inputMode="numeric" value={time} placeholder="e.g. 630" maxLength={5}
                   onChange={(e) => setTime(e.target.value)} onBlur={() => setTime(normaliseTime(time))} />
          </label>
        </div>

        {showNotes ? (
          <>
            <p className="hint">Tap the microphone on your keyboard to dictate. German or English both work.</p>
            <label className="field">
              <span>What you worked on</span>
              <textarea value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Warm-up, topic 1, topic 2" />
            </label>
            <label className="field">
              <span>How it went</span>
              <textarea value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Observations and feedback" />
            </label>
            <label className="field">
              <span>Next session</span>
              <textarea value={improve} onChange={(e) => setImprove(e.target.value)} placeholder="What to work on next time" style={{ minHeight: 64 }} />
            </label>
          </>
        ) : (
          <label className="field">
            <span>Note <span className="hint">(optional)</span></span>
            <textarea value={obs} onChange={(e) => setObs(e.target.value)} placeholder="e.g. Parent cancelled by WhatsApp at 7am" style={{ minHeight: 64 }} />
          </label>
        )}

        {isAdmin && (
          <label className="field">
            <span>Coach</span>
            <select value={coachId} onChange={(e) => setCoachId(e.target.value)}>
              {coaches.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}

        {err && <div className="notice err" role="alert">{err}</div>}
        <button className="btn block" disabled={busy}>{busy ? 'Saving' : 'Log session'}</button>
        <p className="hint mt">Logged the wrong thing? Open the player from <Link href="/players">Players</Link> and edit it within 7 days.</p>
      </form>
    </>
  );
}

