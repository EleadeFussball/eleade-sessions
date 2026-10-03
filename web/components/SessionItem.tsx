'use client';
import { useState } from 'react';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/dates';
import { FORMAT_LABEL, OUTCOME_LABEL, type Outcome, type SessionRow } from '@/lib/types';

const OUTCOMES: Outcome[] = ['attended', 'cancelled_in_time', 'cancelled_late', 'no_show'];

export function SessionItem({ s, onChanged, showPlayers = false }: { s: SessionRow; onChanged: () => void; showPlayers?: boolean }) {
  const { session, coaches, isAdmin } = useAuth();
  const [editing, setEditing] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(s.outcome);
  const [topic, setTopic] = useState(s.topic ?? '');
  const [obs, setObs] = useState(s.observations ?? '');
  const [improve, setImprove] = useState(s.improve ?? '');
  const [err, setErr] = useState('');

  const recent = Date.now() - new Date(s.logged_at).getTime() < 7 * 864e5;
  const canEdit = isAdmin || (!s.imported && s.logged_by === session?.user.id && recent);
  const coachName = coaches.find((c) => c.id === s.coach_id)?.name ?? '';
  const names = (s.session_players ?? []).map((sp) => sp.players?.name).filter(Boolean).join(', ');

  async function save() {
    setErr('');
    const { error } = await supabase.from('sessions')
      .update({ outcome, topic: topic.trim() || null, observations: obs.trim() || null, improve: improve.trim() || null })
      .eq('id', s.id);
    if (error) setErr(errorText(error)); else { setEditing(false); onChanged(); }
  }

  async function remove() {
    if (!window.confirm('Delete this session? Credits and coach pay are recalculated.')) return;
    const { error } = await supabase.from('sessions').delete().eq('id', s.id);
    if (error) setErr(errorText(error)); else onChanged();
  }

  return (
    <li className="session">
      <div className="head">
        <span>{fmtDate(s.session_date, true)}{showPlayers && names ? `, ${names}` : ''}</span>
        <span className={s.outcome === 'attended' ? 'tag turf' : s.outcome === 'cancelled_in_time' ? 'tag' : 'tag amber'}>
          {OUTCOME_LABEL[s.outcome]}
        </span>
      </div>
      <div className="sub">
        {FORMAT_LABEL[s.format]}, {coachName}{s.location ? `, ${s.location}` : ''}{s.imported ? ', from old documentation' : ''}
      </div>
      {!editing ? (
        <>
          {(s.topic || s.observations || s.improve) && (
            <dl>
              {s.topic && <><dt>Worked on</dt><dd>{s.topic}</dd></>}
              {s.observations && <><dt>How it went</dt><dd>{s.observations}</dd></>}
              {s.improve && <><dt>Next time</dt><dd>{s.improve}</dd></>}
            </dl>
          )}
          {canEdit && <button className="linkbtn mt" type="button" onClick={() => setEditing(true)}>Edit</button>}
        </>
      ) : (
        <div className="mt">
          <div className="seg outcomes" style={{ marginBottom: 12 }}>
            {OUTCOMES.map((o) => (
              <button key={o} type="button" aria-pressed={outcome === o} onClick={() => setOutcome(o)}>{OUTCOME_LABEL[o]}</button>
            ))}
          </div>
          <label className="field"><span>What you worked on</span><textarea value={topic} onChange={(e) => setTopic(e.target.value)} /></label>
          <label className="field"><span>How it went</span><textarea value={obs} onChange={(e) => setObs(e.target.value)} /></label>
          <label className="field"><span>Next session</span><textarea value={improve} onChange={(e) => setImprove(e.target.value)} /></label>
          {err && <div className="notice err">{err}</div>}
          <div className="row">
            <button className="btn small" type="button" onClick={save}>Save changes</button>
            <button className="btn small ghost" type="button" onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn small ghost" type="button" onClick={remove} style={{ color: 'var(--red)' }}>Delete session</button>
          </div>
        </div>
      )}
    </li>
  );
}
