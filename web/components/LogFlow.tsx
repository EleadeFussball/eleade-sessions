'use client';
import { useEffect, useMemo, useState } from 'react';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { usePlayers } from '@/lib/usePlayers';
import { todayISO } from '@/lib/dates';
import { canComplete, carriedFocus, completeFrom, confirmEntry, type ScheduleEntry } from '@/lib/schedule';
import { FORMAT_LABEL, MAX_PLAYERS, OUTCOME_LABEL, placeField, FOCUS_LABEL, FOCUS_PLACEHOLDER, type Format, type Outcome } from '@/lib/types';
import { PlayerPicker } from '@/components/PlayerPicker';
import { StripeNote, useUnusedPayments } from '@/components/StripeNote';
import { ClipButton } from '@/components/ClipUpload';

const FORMATS: Format[] = ['1:1', '2:1', '4:1', 'analysis', 'assessment', 'testing'];
const LENGTHS = [45, 60, 90, 120];
type Method = '' | 'cash' | 'stripe' | 'bank';
type Folder = { id: string; name: string; drive_folder_id: string | null };

/**
 * Logging a planned session, in order: 1 type, 2 outcome, 3 payment, 4 notes, 5 clip.
 * Everything is filled in from the plan and the player's usual way of paying.
 */
export function LogFlow({ o, onDone, onCancel }: { o: ScheduleEntry; onDone: () => void; onCancel: () => void }) {
  const { coach, isAdmin } = useAuth();
  const { players, createPlayer } = usePlayers(true);
  const future = o.session_date > todayISO();
  const completable = canComplete(o, isAdmin);

  const [format, setFormat] = useState<Format>(o.format);
  const [outcome, setOutcome] = useState<Outcome>(!future && completable ? 'attended' : 'cancelled_in_time');
  const [method, setMethod] = useState<Method>('');
  const [topic, setTopic] = useState(o.prep ?? '');
  const [obs, setObs] = useState('');
  const [improve, setImprove] = useState('');
  const [ids, setIds] = useState<string[]>(o.player_ids ?? []);
  const [location, setLocation] = useState(o.location ?? '');
  const [minutes, setMinutes] = useState(o.minutes || 60);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const unused = useUnusedPayments(ids);

  // No plan saved: start "What you worked on" from last time's "Next session" (the coach can edit it).
  useEffect(() => {
    if (o.prep || future) return;
    let live = true;
    carriedFocus(o).then((c) => { if (live && c) setTopic((t) => (t.trim() ? t : c.text)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ids.length === 0) { setFolders([]); return; }
    supabase.from('players').select('id, name, drive_folder_id').in('id', ids).then(({ data }) => setFolders((data as Folder[]) ?? []));
  }, [ids]);

  // The player's standard way of paying: package credit, or the weekly payment for weekly payers.
  const standard = useMemo(() => {
    if (format === 'assessment') return 'Not paid yet';
    const plans = new Set(ids.map((id) => players.find((p) => p.player_id === id)?.payment_plan ?? 'package'));
    if (plans.size === 1 && plans.has('weekly')) return 'Weekly payment';
    if (plans.size === 1 && plans.has('casual')) return 'Not paid yet';
    if (plans.size > 1) return 'Package or weekly';
    return 'Package credit';
  }, [format, ids, players]);
  // Casual players: their set way of paying is preselected.
  const casualKey = useMemo(() => {
    const ps = ids.map((id) => players.find((p) => p.player_id === id));
    return ps.length > 0 && ps.every((p) => p?.payment_plan === 'casual' && p.casual_method) && new Set(ps.map((p) => p!.casual_method)).size === 1
      ? ps[0]!.casual_method! : '';
  }, [ids, players]);
  useEffect(() => { if (casualKey && format !== 'assessment' && format !== 'testing') setMethod(casualKey); }, [casualKey, format]);

  const attended = outcome === 'attended';
  const showType = !future;
  const showPay = !future && outcome !== 'cancelled_in_time' && format !== 'testing';
  const showClip = attended;
  let n = 0;
  const step = () => ++n;

  function pickFormat(f: Format) { setFormat(f); if (ids.length > MAX_PLAYERS[f]) setIds(ids.slice(0, MAX_PLAYERS[f])); }

  async function save() {
    setErr('');
    if (ids.length === 0) { setErr('Pick at least one player under More settings.'); return; }
    if ((format === '2:1' || format === '4:1') && ids.length < 2) { setErr(`A ${format} session needs 2 players. Add the other player under More settings, or choose 1:1.`); return; }
    if (format === 'analysis' && attended && (!location.trim() || !topic.trim())) { setErr('For a game analysis, add the opponent and the key focus points.'); return; }
    if (ids.length > MAX_PLAYERS[format]) { setErr(`A ${FORMAT_LABEL[format]} session can have at most ${MAX_PLAYERS[format]} player${MAX_PLAYERS[format] === 1 ? '' : 's'}.`); return; }
    setBusy(true);
    const pay = showPay ? method : '';
    const notes = attended ? { topic, obs, improve, method: pay } : { obs, method: pay };
    const { data: sessionId, error } = await confirmEntry(o, outcome, notes);
    if (error) { setBusy(false); setErr(errorText(error)); return; }
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
    const changed = format !== o.format || !same(ids, o.player_ids ?? []) || location !== (o.location ?? '') || minutes !== o.minutes;
    if (changed && sessionId) {
      const r = await supabase.rpc('edit_session', {
        p_session_id: sessionId, p_session_date: o.session_date, p_start_time: o.start_time, p_minutes: minutes, p_format: format,
        p_outcome: outcome, p_location: location, p_player_ids: ids,
        p_topic: attended ? topic : null, p_observations: obs, p_improve: attended ? improve : null,
        p_payment_method: pay || null, p_coach_id: isAdmin ? o.coach_id : null,
      });
      if (r.error) { setBusy(false); setErr(`The session is saved, but the changes under More settings were not: ${errorText(r.error)} Use Edit session to fix it.`); return; }
    }
    setBusy(false);
    onDone();
  }

  const outcomes: Outcome[] = future ? ['cancelled_in_time', 'cancelled_late'] : ['attended', 'cancelled_in_time', 'cancelled_late', 'no_show'];
  const place = placeField(format);

  return (
    <div className="logflow mt">
      {showType && (
        <div className="step">
          <div className="step-h"><span className="step-n">{step()}</span>Session type</div>
          <div className="seg">
            {FORMATS.map((f) => <button key={f} type="button" aria-pressed={format === f} onClick={() => pickFormat(f)}>{FORMAT_LABEL[f]}</button>)}
          </div>
          {format !== o.format && <p className="hint">Changed from {FORMAT_LABEL[o.format]}. {(format === '2:1' || format === '4:1') && ids.length < 2 ? 'Add the other player under More settings.' : ''}</p>}
        </div>
      )}

      <div className="step">
        <div className="step-h"><span className="step-n">{step()}</span>Outcome</div>
        <div className="seg outcomes">
          {outcomes.map((k) => (
            <button key={k} type="button" aria-pressed={outcome === k} disabled={k === 'attended' && !completable} onClick={() => setOutcome(k)}>
              {OUTCOME_LABEL[k]}
              {k === 'cancelled_in_time' && <small>12+ hours notice: free</small>}
              {(k === 'cancelled_late' || k === 'no_show') && <small>Uses a credit, coach paid</small>}
            </button>
          ))}
        </div>
        {!future && !completable && <p className="hint">You can mark it as attended from {completeFrom(o)}, five minutes after it ends.</p>}
        {outcome === 'cancelled_in_time' && <p className="hint">No credit is used and it is not on your invoice. It stays in the calendar, faded, and you can undo it.</p>}
      </div>

      {showPay && (
        <div className="step">
          <div className="step-h"><span className="step-n">{step()}</span>How it was paid</div>
          <div className="seg">
            <button type="button" aria-pressed={method === ''} onClick={() => setMethod('')}>{standard}</button>
            <button type="button" aria-pressed={method === 'cash'} onClick={() => setMethod('cash')}>Paid cash</button>
            <button type="button" aria-pressed={method === 'stripe'} onClick={() => setMethod('stripe')}>Stripe</button>
            <button type="button" aria-pressed={method === 'bank'} onClick={() => setMethod('bank')}>Bank transfer</button>
          </div>
          {method === 'stripe' && <StripeNote playerIds={ids} />}
          {method === '' && unused.length > 0 && <p className="hint mt">A Stripe payment from this player is waiting. If it was for this session, tap Stripe.</p>}
          {method === 'cash' && !coach?.salaried && <p className="hint mt">You keep the cash. It is taken off your weekly invoice automatically.</p>}
        </div>
      )}

      <div className="step">
        <div className="step-h"><span className="step-n">{step()}</span>{attended ? (format === 'analysis' ? 'Game analysis' : 'Session notes') : 'Note'}</div>
        {attended && format === 'analysis' ? (
          <>
            <label className="field"><span>Opponent</span>
              <input type="text" value={location} placeholder={place.placeholder} onChange={(e) => setLocation(e.target.value)} /></label>
            <label className="field"><span>{FOCUS_LABEL}</span><textarea value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={FOCUS_PLACEHOLDER} /></label>
          </>
        ) : attended ? (
          <>
            <p className="hint">{o.prep ? 'Your plan is filled in. Change it if the session went differently.' : 'Tap the microphone on your keyboard to dictate. German or English both work.'}</p>
            <label className="field"><span>What you worked on</span><textarea value={topic} onChange={(e) => setTopic(e.target.value)} /></label>
            <label className="field"><span>How it went</span><textarea value={obs} onChange={(e) => setObs(e.target.value)} /></label>
            <label className="field"><span>Next session</span><textarea value={improve} onChange={(e) => setImprove(e.target.value)} style={{ minHeight: 64 }} /></label>
          </>
        ) : (
          <label className="field"><span>Note <span className="hint">(optional)</span></span>
            <textarea value={obs} onChange={(e) => setObs(e.target.value)} placeholder="e.g. Sick, parent messaged at 7am" style={{ minHeight: 56 }} /></label>
        )}
      </div>

      {showClip && (
        <div className="step">
          <div className="step-h"><span className="step-n">{step()}</span>Clip <span className="hint">(optional)</span></div>
          <p className="hint">30 to 60 seconds. It uploads to the player&apos;s Drive folder while you carry on, even after you save.</p>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {ids.map((id) => {
              const f = folders.find((x) => x.id === id);
              const name = f?.name ?? players.find((p) => p.player_id === id)?.name ?? 'Player';
              return <ClipButton key={id} playerId={id} playerName={name} folderId={f?.drive_folder_id ?? null} label={ids.length > 1 ? `Clip for ${name.split(' ')[0]}` : 'Upload clip'} />;
            })}
          </div>
        </div>
      )}

      {!future && (
        <details className="more">
          <summary>More settings: players, length{format === 'analysis' && attended ? '' : `, ${place.label.toLowerCase()}`}</summary>
          <div className="field">
            <span className="fieldlabel">{MAX_PLAYERS[format] === 1 ? 'Player' : `Players (up to ${MAX_PLAYERS[format]})`}</span>
            <PlayerPicker players={players} selected={ids} max={MAX_PLAYERS[format]} onChange={setIds}
                          onCreate={async (name) => { const id = await createPlayer(name, o.coach_id); if (id) setIds([...ids, id].slice(0, MAX_PLAYERS[format])); }} />
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
          {!(format === 'analysis' && attended) && (
            <label className="field"><span>{place.label}</span>
              <input type="text" list={format === 'analysis' ? undefined : 'pitches'} value={location} placeholder={place.placeholder} onChange={(e) => setLocation(e.target.value)} /></label>
          )}
          <p className="hint">To change the day or start time, go Back and use Move.</p>
        </details>
      )}

      {err && <div className="notice err" role="alert">{err}</div>}
      <div className="row mt">
        <button type="button" className="btn small" disabled={busy} onClick={save}>
          {busy ? 'Saving' : outcome === 'cancelled_in_time' ? 'Save cancellation' : 'Save session'}
        </button>
        <button type="button" className="btn small ghost" onClick={onCancel}>Back</button>
      </div>
    </div>
  );
}
