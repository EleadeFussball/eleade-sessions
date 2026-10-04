'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { addDays, fmtDate, money, todayISO } from '@/lib/dates';
import { normaliseTime } from '@/lib/time';

type Enquiry = {
  id: string; created_at: string; first_name: string | null; last_name: string | null; parent_name: string | null;
  email: string | null; phone: string | null; dob: string | null; gender: string | null; age_group: string | null;
  position: string | null; foot: string | null; club: string | null; heard_from: string | null; message: string | null;
  player_type: string | null; status: 'new' | 'assigned' | 'contacted' | 'booked' | 'done' | 'declined';
  coach_id: string | null; player_id: string | null; booking_id: string | null; note: string | null;
  bookings: { session_date: string; start_time: string; minutes: number; session_id: string | null; cancelled_at: string | null } | null;
};
type Paid = { player_id: string; amount_total: number; paid_at: string };

const STATUS_LABEL: Record<Enquiry['status'], string> = {
  new: 'New', assigned: 'Assigned', contacted: 'Parent contacted', booked: 'Booked', done: 'Done', declined: 'Declined',
};

function waNumber(phone: string): string {
  const p = phone.trim();
  const d = p.replace(/\D/g, '');
  if (p.startsWith('+')) return d;
  if (d.startsWith('00')) return d.slice(2);
  if (d.startsWith('0')) return `61${d.slice(1)}`;
  return d;
}

export default function EnquiriesPage() {
  const { isAdmin } = useAuth();
  const [rows, setRows] = useState<Enquiry[]>([]);
  const [paid, setPaid] = useState<Paid[]>([]);
  const [link, setLink] = useState('');
  const [tab, setTab] = useState<'todo' | 'done' | 'declined'>('todo');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [e, s] = await Promise.all([
      supabase.from('enquiries').select('*, bookings(session_date, start_time, minutes, session_id, cancelled_at)').order('created_at', { ascending: false }).limit(200),
      supabase.from('settings').select('value').eq('key', 'stripe_assessment_link').maybeSingle(),
    ]);
    const list = (e.data as unknown as Enquiry[]) ?? [];
    setRows(list);
    setLink(((s.data?.value as string) ?? '').trim());
    const ids = list.map((r) => r.player_id).filter(Boolean) as string[];
    if (ids.length) {
      const { data } = await supabase.from('stripe_payments').select('player_id, amount_total, paid_at').in('player_id', ids).eq('for_what', 'assessment');
      setPaid((data as Paid[]) ?? []);
    } else setPaid([]);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const isDone = (r: Enquiry) => r.status === 'done' || !!r.bookings?.session_id;
  const groups = useMemo(() => ({
    todo: rows.filter((r) => !isDone(r) && r.status !== 'declined'),
    done: rows.filter((r) => isDone(r) && r.status !== 'declined'),
    declined: rows.filter((r) => r.status === 'declined'),
  }), [rows]);
  const shown = groups[tab];

  return (
    <>
      <h1>Enquiries</h1>
      <p className="muted">
        {isAdmin
          ? 'New expressions of interest from the website. Assign a coach and the app sets up the player, the payment link and the assessment.'
          : 'Enquiries Jan has assigned to you. Work through the steps to organise the assessment.'}
      </p>
      <div className="seg" style={{ marginBottom: 12 }}>
        {(['todo', 'done', 'declined'] as const).map((k) => (
          <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>
            {k === 'todo' ? 'To do' : k === 'done' ? 'Done' : 'Declined'} ({groups[k].length})
          </button>
        ))}
      </div>
      {loading ? <p className="empty">Loading</p> : shown.length === 0 ? (
        <p className="empty">{tab === 'todo' ? (isAdmin ? 'No open enquiries. New ones from the website appear here.' : 'Nothing assigned to you right now.') : 'Nothing here.'}</p>
      ) : shown.map((r) => (
        <EnquiryCard key={r.id} e={r} link={link} payment={paid.find((p) => p.player_id === r.player_id)} onChanged={load} defaultOpen={tab === 'todo' && shown.length === 1} />
      ))}
    </>
  );
}

function EnquiryCard({ e, link, payment, onChanged, defaultOpen }: {
  e: Enquiry; link: string; payment?: Paid; onChanged: () => void; defaultOpen: boolean;
}) {
  const { isAdmin, coaches } = useAuth();
  const [open, setOpen] = useState(defaultOpen || e.status === 'new');
  const [coachId, setCoachId] = useState(e.coach_id ?? '');
  const [date, setDate] = useState(e.bookings?.session_date ?? addDays(todayISO(), 2));
  const [time, setTime] = useState(e.bookings?.start_time?.slice(0, 5) ?? '');
  const [minutes, setMinutes] = useState(e.bookings?.minutes ?? 60);
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);

  const coach = coaches.find((c) => c.id === e.coach_id);
  const player = [e.first_name, e.last_name].filter(Boolean).join(' ') || 'Unnamed player';
  const first = e.first_name ?? 'your son or daughter';
  const booked = !!e.bookings && !e.bookings.cancelled_at;
  const logged = !!e.bookings?.session_id;
  const url = link && e.player_id ? `${link}${link.includes('?') ? '&' : '?'}client_reference_id=assessment_${e.player_id}` : '';
  const parent = e.parent_name ?? '';
  const message = [
    `Hi${parent ? ` ${parent.split(' ')[0]}` : ''} 👋 Thank you for your interest in Eleade!`,
    `${coach ? `${coach.name} will` : 'We will'} run ${first}'s assessment ($130 + GST).`,
    url ? `To confirm the booking, please pay here:\n${url}` : '',
    'Which days and times suit you in the coming week? We will then lock in a time.',
    'Thank you! ⚽',
  ].filter(Boolean).join('\n\n');
  const [text, setText] = useState(message);
  useEffect(() => { setText(message); }, [message]);

  async function run(fn: () => PromiseLike<{ error: unknown }>) {
    setBusy(true); setErr('');
    const { error } = await fn();
    setBusy(false);
    if (error) setErr(errorText(error)); else onChanged();
  }
  const assign = () => {
    if (!coachId) { setErr('Choose a coach.'); return Promise.resolve(); }
    return run(() => supabase.rpc('assign_enquiry', { p_id: e.id, p_coach_id: coachId }));
  };
  const makePlayer = () => run(() => supabase.rpc('enquiry_make_player', { p_id: e.id }));
  const setStatus = (status: Enquiry['status']) => run(() => supabase.rpc('set_enquiry_status', { p_id: e.id, p_status: status }));
  async function contacted() { if (e.status === 'assigned') await supabase.rpc('set_enquiry_status', { p_id: e.id, p_status: 'contacted' }); onChanged(); }
  async function book() {
    const t = normaliseTime(time);
    if (!t) { setErr('Add a start time, like 430, 4:30 or 1630.'); return; }
    await run(() => supabase.rpc('enquiry_book', { p_id: e.id, p_date: date, p_time: t, p_minutes: minutes, p_location: location }));
  }
  async function copy() { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2500); }

  const canWork = isAdmin || !!e.coach_id;
  const statusTag = logged ? 'Assessment logged' : STATUS_LABEL[e.status];

  return (
    <div className="panel enquiry">
      <button type="button" className="enq-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>
          <strong>{player}</strong>{e.age_group ? ` · ${e.age_group}` : ''}
          <br /><span className="hint">{fmtDate(e.created_at.slice(0, 10), true)}{coach ? ` · ${coach.name}` : ''}</span>
        </span>
        <span className={e.status === 'new' ? 'tag amber' : logged || e.status === 'done' ? 'tag turf' : 'tag'}>{statusTag}</span>
      </button>

      {open && (
        <div className="enq-body">
          <dl>
            {e.parent_name && <><dt>Parent</dt><dd>{e.parent_name}</dd></>}
            {e.email && <><dt>Email</dt><dd><a href={`mailto:${e.email}`}>{e.email}</a></dd></>}
            {e.phone && <><dt>Phone</dt><dd><a href={`tel:${e.phone.replace(/\s/g, '')}`}>{e.phone}</a></dd></>}
            {e.dob && <><dt>Date of birth</dt><dd>{e.dob}</dd></>}
            {e.gender && <><dt>Gender</dt><dd>{e.gender}</dd></>}
            {e.position && <><dt>Position</dt><dd>{e.position}</dd></>}
            {e.foot && <><dt>Foot</dt><dd>{e.foot}</dd></>}
            {e.club && <><dt>Club or academy</dt><dd>{e.club}</dd></>}
            {e.player_type && <><dt>Player type</dt><dd>{e.player_type}</dd></>}
            {e.heard_from && <><dt>Heard about us</dt><dd>{e.heard_from}</dd></>}
            {e.message && <><dt>Message</dt><dd>{e.message}</dd></>}
          </dl>

          <div className="step">
            <h4>1. Coach</h4>
            {isAdmin ? (
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <select value={coachId} onChange={(ev) => setCoachId(ev.target.value)} aria-label="Coach" style={{ flex: '1 1 160px' }}>
                  <option value="">Choose a coach</option>
                  {coaches.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <button type="button" className="btn small" disabled={busy || coachId === (e.coach_id ?? '')} onClick={assign}>
                  {e.coach_id ? 'Change coach' : 'Assign coach'}
                </button>
              </div>
            ) : <p>{coach?.name ?? 'Not assigned'}</p>}
            {!e.coach_id && isAdmin && <p className="hint">Assigning also creates the player in the app and prepares the payment link.</p>}
          </div>

          {canWork && e.coach_id && (
            <>
              <div className="step">
                <h4>2. Player in the app</h4>
                {e.player_id
                  ? <p><Link href={`/players/${e.player_id}`}>Open {player}</Link> <span className="hint">· all details above stay linked to the player</span></p>
                  : <button type="button" className="btn small" disabled={busy} onClick={makePlayer}>Create player</button>}
              </div>

              <div className="step">
                <h4>3. Message to the parent</h4>
                {!e.player_id ? <p className="hint">Create the player first, so the payment link is tagged for them.</p>
                  : !link ? <div className="notice warn">Add the Stripe assessment link on the Team page to include the payment link.</div>
                  : (
                    <>
                      <textarea value={text} onChange={(ev) => setText(ev.target.value)} style={{ minHeight: 170 }} aria-label="Message to the parent" />
                      <div className="row mt" style={{ flexWrap: 'wrap' }}>
                        {e.phone && (
                          <a className="btn small" target="_blank" rel="noreferrer" onClick={contacted}
                             href={`https://wa.me/${waNumber(e.phone)}?text=${encodeURIComponent(text)}`}>WhatsApp</a>
                        )}
                        {e.email && (
                          <a className="btn small ghost" onClick={contacted}
                             href={`mailto:${e.email}?subject=${encodeURIComponent(`Eleade assessment for ${first}`)}&body=${encodeURIComponent(text)}`}>Email</a>
                        )}
                        <button type="button" className="btn small ghost" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
                      </div>
                    </>
                  )}
              </div>

              <div className="step">
                <h4>4. Payment</h4>
                {payment
                  ? <p><span className="tag turf">Paid</span> {money(payment.amount_total)} on {fmtDate(payment.paid_at.slice(0, 10))}. The assessment counts as paid.</p>
                  : <p><span className="tag amber">Waiting</span> <span className="hint">It appears here by itself when the parent pays the link above.</span></p>}
              </div>

              <div className="step">
                <h4>5. Book the assessment</h4>
                {logged ? <p><span className="tag turf">Done</span> The assessment was held and logged.</p> : (
                  <>
                    {booked && e.bookings && (
                      <p><span className="tag turf">Booked</span> {fmtDate(e.bookings.session_date, true)} at {e.bookings.start_time.slice(0, 5)}.{' '}
                        <Link href="/calendar">Open calendar</Link></p>
                    )}
                    {e.player_id ? (
                      <>
                        <div className="row" style={{ flexWrap: 'wrap' }}>
                          <label className="field" style={{ flex: '1 1 150px' }}><span>Day</span>
                            <input type="date" value={date} onChange={(ev) => setDate(ev.target.value)} /></label>
                          <label className="field" style={{ flex: '0 0 100px' }}><span>Start</span>
                            <input type="text" inputMode="numeric" value={time} placeholder="e.g. 430" onChange={(ev) => setTime(ev.target.value)}
                                   onBlur={() => setTime(normaliseTime(time) || time)} /></label>
                          <label className="field" style={{ flex: '1 1 150px' }}><span>Location</span>
                            <input type="text" value={location} onChange={(ev) => setLocation(ev.target.value)} placeholder="e.g. Moore Park" /></label>
                        </div>
                        <button type="button" className="btn small" disabled={busy} onClick={book}>{booked ? 'Move in calendar' : 'Add to calendar'}</button>
                        <p className="hint">It appears in {coach?.name ?? 'the coach'}&apos;s calendar. After the session, tap Completed there.</p>
                      </>
                    ) : <p className="hint">Create the player first.</p>}
                  </>
                )}
              </div>
            </>
          )}

          {err && <div className="notice err" role="alert">{err}</div>}
          <div className="row mt" style={{ flexWrap: 'wrap' }}>
            {e.status === 'declined'
              ? <button type="button" className="btn small ghost" disabled={busy} onClick={() => setStatus(e.coach_id ? 'assigned' : 'new')}>Reopen</button>
              : (isAdmin || e.coach_id) && <button type="button" className="btn small ghost" disabled={busy} onClick={() => setStatus('declined')}>Decline enquiry</button>}
            {e.status !== 'done' && !logged && e.status !== 'declined' && e.coach_id && (
              <button type="button" className="btn small ghost" disabled={busy} onClick={() => setStatus('done')}>Mark as done</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
