'use client';
import { useState } from 'react';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/dates';
import { StripeLink } from '@/components/StripeLink';
import { EditSession, canEditSession } from '@/components/EditSession';
import { FORMAT_LABEL, OUTCOME_LABEL, PAYMENT_LABEL, type SessionRow } from '@/lib/types';

export function SessionItem({ s, onChanged, showPlayers = false }: { s: SessionRow; onChanged: () => void; showPlayers?: boolean }) {
  const { coach, coaches, isAdmin } = useAuth();
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState('');

  const canEdit = canEditSession(s, isAdmin, coach?.id);
  const coachName = coaches.find((c) => c.id === s.coach_id)?.name ?? '';
  const names = (s.session_players ?? []).map((sp) => sp.players?.name).filter(Boolean).join(', ');

  async function remove() {
    if (!window.confirm('Delete this session? Credits and coach pay are recalculated.')) return;
    await supabase.from('bookings').update({ session_id: null, cancelled_at: new Date().toISOString() }).eq('session_id', s.id);
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
      {s.payment_status && (
        <div style={{ marginTop: 4 }}>
          {(() => {
            const what = s.format === 'assessment' ? '$130 payment'
              : s.payment_method ? `${PAYMENT_LABEL[s.payment_method]} payment` : 'Payment';
            if (s.payment_method === 'cash' && s.payment_status === 'confirmed' && coaches.find((c) => c.id === s.coach_id)?.salaried === false) {
              return <span className="tag turf">Cash kept, taken off invoice</span>;
            }
            return s.payment_status === 'awaiting'
              ? <span className="tag amber">{what} to check</span>
              : <span className="tag turf">{what} checked</span>;
          })()}
        </div>
      )}
      {s.payment_status === 'awaiting' && !s.imported && <StripeLink sessionId={s.id} onLinked={onChanged} />}
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
        <EditSession sessionId={s.id} onCancel={() => setEditing(false)} onDone={() => { setEditing(false); onChanged(); }} onDelete={remove} />
      )}
      {err && <div className="notice err" role="alert">{err}</div>}
    </li>
  );
}
