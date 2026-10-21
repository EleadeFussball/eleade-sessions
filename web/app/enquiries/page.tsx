'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { addDays, fmtDate, money, todayISO } from '@/lib/dates';
import { normaliseTime } from '@/lib/time';
import { pitchLines, usePitches } from '@/lib/locations';
import { ageGroupLabel } from '@/lib/age';

// The form sends "2008-04-05" or "29 January 2007".
function dobAge(t: string): string {
  const iso = /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : (() => { const d = new Date(t); return isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  return iso ? ageGroupLabel(iso) : '';
}

type Status = 'new' | 'assigned' | 'contacted' | 'booked' | 'done' | 'declined';
type Outcome = 'package5' | 'package10' | 'handover' | 'not_continuing';
type Enquiry = {
  id: string; created_at: string; first_name: string | null; last_name: string | null; parent_name: string | null;
  parent_email: string | null; parent_phone: string | null;
  email: string | null; phone: string | null; dob: string | null; gender: string | null; age_group: string | null;
  position: string | null; foot: string | null; club: string | null; heard_from: string | null; message: string | null;
  player_type: string | null; status: Status; coach_id: string | null; player_id: string | null; booking_id: string | null;
  note: string | null; called_at: string | null; called_by: string | null; outcome: Outcome | null; outcome_at: string | null;
  preferred_location: string | null; ideal_times: string | null; whatsapp_group_at: string | null;
  raw: { answers?: [string, string][] } | null;
  bookings: { session_date: string; start_time: string; minutes: number; location: string | null; session_id: string | null; cancelled_at: string | null } | null;
};
type Paid = { player_id: string; amount_total: number; paid_at: string };
type Notes = { id: string; topic: string | null; observations: string | null; improve: string | null };

const OUTCOME_LABEL: Record<Outcome, string> = {
  package5: 'Committed to 5 sessions', package10: 'Committed to 10 sessions',
  handover: 'Handed to Jan for the sales call', not_continuing: 'Not continuing',
};
const STATUS_LABEL: Record<Status, string> = {
  new: 'New', assigned: 'Coach assigned', contacted: 'Parent contacted', booked: 'Booked', done: 'Done', declined: 'Declined',
};

function waNumber(phone: string): string {
  const p = phone.trim();
  const d = p.replace(/\D/g, '');
  if (p.startsWith('+')) return d;
  if (d.startsWith('00')) return d.slice(2);
  if (d.startsWith('0')) return `61${d.slice(1)}`;
  return d;
}

type Tab = 'todo' | 'sales' | 'done' | 'declined';

export default function EnquiriesPage() {
  const { isAdmin } = useAuth();
  const [rows, setRows] = useState<Enquiry[]>([]);
  const [paid, setPaid] = useState<Paid[]>([]);
  const [notes, setNotes] = useState<Notes[]>([]);
  const [link, setLink] = useState('');
  const [tab, setTab] = useState<Tab>('todo');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const [e, s] = await Promise.all([
      supabase.from('enquiries').select('*, bookings(session_date, start_time, minutes, location, session_id, cancelled_at)').order('created_at', { ascending: false }).limit(200),
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
    const sids = list.map((r) => r.bookings?.session_id).filter(Boolean) as string[];
    if (sids.length) {
      const { data } = await supabase.from('sessions').select('id, topic, observations, improve').in('id', sids);
      setNotes((data as Notes[]) ?? []);
    } else setNotes([]);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const groups = useMemo(() => ({
    todo: rows.filter((r) => r.status !== 'done' && r.status !== 'declined'),
    sales: rows.filter((r) => r.status === 'done' && r.outcome === 'handover'),
    done: rows.filter((r) => r.status === 'done' && (r.outcome !== 'handover' || !isAdmin)),
    declined: rows.filter((r) => r.status === 'declined'),
  }), [rows, isAdmin]);
  const tabs: Tab[] = isAdmin ? ['todo', 'sales', 'done', 'declined'] : ['todo', 'done', 'declined'];
  const tabLabel: Record<Tab, string> = { todo: 'To do', sales: 'Sales calls', done: 'Done', declined: 'Declined' };
  const shown = groups[tab];

  return (
    <>
      <h1>Enquiries</h1>
      <p className="muted">
        Expressions of interest from the website. Call the parents, note the best pitch and times, assign a coach, set up the WhatsApp group and book the assessment. The app prepares every message, including the pitch with its Google Maps link.
      </p>
      <div className="seg" style={{ marginBottom: 12 }}>
        {tabs.map((k) => (
          <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>{tabLabel[k]} ({groups[k].length})</button>
        ))}
      </div>
      {(
        <div style={{ marginBottom: 12 }}>
          {adding
            ? <AddEnquiry onClose={() => setAdding(false)} onSaved={() => { setAdding(false); setTab('todo'); load(); }} />
            : <button type="button" className="btn small ghost" onClick={() => setAdding(true)}>Add an enquiry by hand</button>}
        </div>
      )}
      {loading ? <p className="empty">Loading</p> : shown.length === 0 ? (
        <p className="empty">
          {tab === 'todo' ? 'No open enquiries. New ones from the website appear here.'
            : tab === 'sales' ? 'No sales calls waiting. Players handed over after their assessment appear here.' : 'Nothing here.'}
        </p>
      ) : shown.map((r) => (
        <EnquiryCard key={r.id} e={r} link={link} payment={paid.find((p) => p.player_id === r.player_id)}
          notes={notes.find((n) => n.id === r.bookings?.session_id)} onChanged={load}
          defaultOpen={(tab === 'todo' && shown.length === 1) || tab === 'sales'} />
      ))}
    </>
  );
}

function AddEnquiry({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k: string) => (ev: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: ev.target.value });
  async function save() {
    if (!f.first_name?.trim() && !f.parent_name?.trim()) { setErr('Add at least the player or parent name.'); return; }
    setBusy(true); setErr('');
    const { error } = await supabase.rpc('add_enquiry', { p_fields: f });
    setBusy(false);
    if (error) setErr(errorText(error)); else onSaved();
  }
  const input = (k: string, label: string, ph = '') => (
    <label className="field" style={{ flex: '1 1 170px' }}><span>{label}</span>
      <input type="text" value={f[k] ?? ''} onChange={set(k)} placeholder={ph} /></label>
  );
  return (
    <div className="panel">
      <h3>Add an enquiry by hand</h3>
      <p className="hint">For a form received only by email. Copy the details from the PDF.</p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {input('first_name', 'Player first name')}{input('last_name', 'Player last name')}
        {input('parent_name', 'Parent name')}{input('parent_phone', 'Parent phone')}
        {input('parent_email', 'Parent email')}{input('age_group', 'Age group')}
        {input('dob', 'Date of birth')}{input('position', 'Position')}{input('club', 'Club or academy')}
      </div>
      {err && <div className="notice err" role="alert">{err}</div>}
      <div className="row mt">
        <button type="button" className="btn small" disabled={busy} onClick={save}>Save enquiry</button>
        <button type="button" className="btn small ghost" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

function EnquiryCard({ e, link, payment, notes, onChanged, defaultOpen }: {
  e: Enquiry; link: string; payment?: Paid; notes?: Notes; onChanged: () => void; defaultOpen: boolean;
}) {
  const { isAdmin, coaches } = useAuth();
  const pitches = usePitches();
  const [open, setOpen] = useState(defaultOpen || e.status === 'new');
  const [prefLoc, setPrefLoc] = useState(e.preferred_location ?? '');
  const [times, setTimes] = useState(e.ideal_times ?? '');
  const [coachId, setCoachId] = useState(e.coach_id ?? '');
  const [date, setDate] = useState(e.bookings?.session_date ?? addDays(todayISO(), 2));
  const [time, setTime] = useState(e.bookings?.start_time?.slice(0, 5) ?? '');
  const [minutes, setMinutes] = useState(e.bookings?.minutes ?? 60);
  const [location, setLocation] = useState(e.bookings?.location ?? e.preferred_location ?? '');
  const [callNote, setCallNote] = useState(e.note ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState('');

  const coach = coaches.find((c) => c.id === e.coach_id);
  const player = [e.first_name, e.last_name].filter(Boolean).join(' ') || 'Unnamed player';
  const first = e.first_name ?? 'your son or daughter';
  const booked = !!e.bookings && !e.bookings.cancelled_at;
  const logged = !!e.bookings?.session_id;
  const phone = e.parent_phone || e.phone || '';
  const mail = e.parent_email || e.email || '';
  const parentFirst = (e.parent_name ?? '').split(' ')[0];
  const url = link && e.player_id ? `${link}${link.includes('?') ? '&' : '?'}client_reference_id=assessment_${e.player_id}` : '';
  const canWork = true;
  const caller = coaches.find((c) => c.user_id === e.called_by);
  const finished = e.status === 'done' || e.status === 'declined';

  const when = booked && e.bookings ? `${fmtDate(e.bookings.session_date, true)} at ${e.bookings.start_time.slice(0, 5)}` : '';
  const payMessage = [
    `Hi${parentFirst ? ` ${parentFirst}` : ''} 👋 Thank you for speaking with us.`,
    `${first}'s assessment with ${coach ? coach.name : 'our coach'} is booked for ${when || 'the agreed time'}.`,
    pitchLines(e.bookings?.location, pitches),
    url ? `To confirm the booking, please pay the assessment fee ($130 + GST) here:\n${url}` : '',
    'See you there! ⚽',
  ].filter(Boolean).join('\n\n');

  const groupName = `Eleade | ${player}`;
  const coachFirst = coach?.name.split(' ')[0] ?? '';
  const welcomeMessage = [
    `Hi${parentFirst ? ` ${parentFirst}` : ''} 👋 Welcome to Eleade!`,
    `This is ${first}'s group with ${coach ? `${coach.name}, ${first}'s coach` : 'our coach'}. We will use it to organise sessions and share updates.`,
    pitchLines(e.preferred_location, pitches),
    e.ideal_times ? `🕒 Times that suit you: ${e.ideal_times}` : '',
    `${coachFirst || 'Your coach'} will confirm the first session here shortly. ⚽`,
  ].filter(Boolean).join('\n\n');
  const [welcome, setWelcome] = useState(welcomeMessage);
  useEffect(() => { setWelcome(welcomeMessage); }, [welcomeMessage]);
  const [pay, setPay] = useState(payMessage);
  useEffect(() => { setPay(payMessage); }, [payMessage]);

  const summaryDraft = [
    `Hi${parentFirst ? ` ${parentFirst}` : ''}, thank you for bringing ${first} to the assessment today.`,
    notes?.topic ? `What we worked on: ${notes.topic}` : '',
    notes?.observations ? `How it went: ${notes.observations}` : '',
    notes?.improve ? `Next steps: ${notes.improve}` : '',
    'We would love to work with you. The next step is to commit to an initial block of 5 or 10 sessions. Let us know which suits you best, or Jan can call you to talk it through.',
  ].filter(Boolean).join('\n\n');
  const [summary, setSummary] = useState(summaryDraft);
  useEffect(() => { setSummary(summaryDraft); }, [summaryDraft]);

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
  const setStatus = (status: Status) => run(() => supabase.rpc('set_enquiry_status', { p_id: e.id, p_status: status }));
  const called = () => run(() => supabase.rpc('enquiry_called', { p_id: e.id, p_note: callNote, p_location: prefLoc, p_times: times }));
  const groupDone = (done: boolean) => run(() => supabase.rpc('enquiry_whatsapp_group', { p_id: e.id, p_done: done }));
  const outcome = (o: Outcome) => run(() => supabase.rpc('set_enquiry_outcome', { p_id: e.id, p_outcome: o }));
  async function book() {
    const t = normaliseTime(time);
    if (!t) { setErr('Add a start time, like 430, 4:30 or 1630.'); return; }
    await run(() => supabase.rpc('enquiry_book', { p_id: e.id, p_date: date, p_time: t, p_minutes: minutes, p_location: location }));
  }
  async function copy(text: string, which: string) { await navigator.clipboard.writeText(text); setCopied(which); setTimeout(() => setCopied(''), 2500); }

  const tag = e.outcome ? OUTCOME_LABEL[e.outcome] : logged ? 'Assessment held' : booked && e.status !== 'done' ? 'Booked' : e.called_at && e.status === 'new' ? 'Parent called' : STATUS_LABEL[e.status];
  const tagClass = e.status === 'new' ? 'tag amber' : e.outcome === 'handover' ? 'tag amber' : e.status === 'done' || logged ? 'tag turf' : 'tag';
  const answers = e.raw?.answers ?? [];

  return (
    <div className="panel enquiry">
      <button type="button" className="enq-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>
          <strong>{player}</strong>{e.age_group ? ` · ${e.age_group}` : ''}
          <br /><span className="hint">{fmtDate(e.created_at.slice(0, 10), true)}{coach ? ` · ${coach.name}` : ''}</span>
        </span>
        <span className={tagClass}>{tag}</span>
      </button>

      {open && (
        <div className="enq-body">
          <dl>
            {e.parent_name && <><dt>Parent</dt><dd>{e.parent_name}</dd></>}
            {phone && <><dt>Parent phone</dt><dd><a href={`tel:${phone.replace(/\s/g, '')}`}>{phone}</a></dd></>}
            {mail && <><dt>Parent email</dt><dd><a href={`mailto:${mail}`}>{mail}</a></dd></>}
            {e.dob && <><dt>Date of birth</dt><dd>{e.dob}{dobAge(e.dob) ? ` (${dobAge(e.dob)})` : ''}</dd></>}
            {e.age_group && <><dt>Age group</dt><dd>{e.age_group}</dd></>}
            {e.position && <><dt>Position</dt><dd>{e.position}</dd></>}
            {e.foot && <><dt>Foot</dt><dd>{e.foot}</dd></>}
            {e.club && <><dt>Club or academy</dt><dd>{e.club}</dd></>}
            {e.heard_from && <><dt>Heard about us</dt><dd>{e.heard_from}</dd></>}
          </dl>
          {answers.length > 0 && (
            <details>
              <summary>All answers on the form ({answers.length})</summary>
              <dl>{answers.map(([l, v], i) => <div key={i}><dt>{l}</dt><dd>{v}</dd></div>)}</dl>
            </details>
          )}

          {!finished && (
            <>
              <div className="step">
                <h4>1. Review and call the parents</h4>
                {phone && (
                  <div className="row" style={{ flexWrap: 'wrap' }}>
                    <a className="btn small" href={`tel:${phone.replace(/\s/g, '')}`}>Call {e.parent_name ? parentFirst : 'parent'}</a>
                    <a className="btn small ghost" target="_blank" rel="noreferrer" href={`https://wa.me/${waNumber(phone)}`}>WhatsApp</a>
                  </div>
                )}
                {e.called_at && <p className="hint">Call done on {fmtDate(e.called_at.slice(0, 10))}{caller ? ` by ${caller.name}` : ''}.</p>}
                <div className="row mt" style={{ flexWrap: 'wrap' }}>
                  <label className="field" style={{ flex: '1 1 170px' }}><span>Best pitch for the family</span>
                    <select value={prefLoc} onChange={(ev) => setPrefLoc(ev.target.value)}>
                      <option value="">Choose a pitch</option>
                      {pitches.filter((p) => p.active || p.name === prefLoc).map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
                      {prefLoc && !pitches.some((p) => p.name === prefLoc) && <option value={prefLoc}>{prefLoc}</option>}
                    </select></label>
                  <label className="field" style={{ flex: '1 1 170px' }}><span>Ideal times</span>
                    <input type="text" value={times} onChange={(ev) => setTimes(ev.target.value)} placeholder="e.g. Tue or Thu after 4pm" /></label>
                </div>
                <textarea value={callNote} onChange={(ev) => setCallNote(ev.target.value)} aria-label="Notes from the call"
                  placeholder="Notes from the call: goals, experience, what you explained" style={{ minHeight: 70 }} />
                <button type="button" className="btn small mt" disabled={busy} onClick={called}>{e.called_at ? 'Update call notes' : 'Call done, save notes'}</button>
              </div>

              <div className="step">
                <h4>2. Assign a coach</h4>
                {(
                  <div className="row" style={{ flexWrap: 'wrap' }}>
                    <select value={coachId} onChange={(ev) => setCoachId(ev.target.value)} aria-label="Coach" style={{ flex: '1 1 160px' }}>
                      <option value="">Choose a coach</option>
                      {coaches.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <button type="button" className="btn small" disabled={busy || coachId === (e.coach_id ?? '')} onClick={assign}>
                      {e.coach_id ? 'Change coach' : 'Assign coach'}
                    </button>
                  </div>
                )}
                {!e.coach_id && <p className="hint">Assigning creates the player in the app and puts the assessment in that coach&apos;s calendar. Do this once the call went well.</p>}
              </div>

              {e.coach_id && (
                <div className="step">
                  <h4>3. WhatsApp group</h4>
                  {e.whatsapp_group_at ? (
                    <p><span className="tag turf">Group created</span> <span className="hint">on {fmtDate(e.whatsapp_group_at.slice(0, 10))}.</span>{' '}
                      <button type="button" className="linkbtn" disabled={busy} onClick={() => groupDone(false)}>Undo</button></p>
                  ) : (
                    <>
                      <p className="hint">In WhatsApp: New group, add {e.parent_name ? parentFirst : 'the parent'}{phone ? ` (${phone})` : ''} and {coach?.name ?? 'the coach'}, name it as below, then paste the welcome message.</p>
                      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                        <code style={{ padding: '6px 8px', background: 'var(--turf-soft)', borderRadius: 6 }}>{groupName}</code>
                        <button type="button" className="btn small ghost" onClick={() => copy(groupName, 'group')}>{copied === 'group' ? 'Copied' : 'Copy name'}</button>
                      </div>
                      <textarea className="mt" value={welcome} onChange={(ev) => setWelcome(ev.target.value)} style={{ minHeight: 170 }} aria-label="Welcome message for the WhatsApp group" />
                      {!e.preferred_location && <p className="hint">Save the best pitch in step 1 to include it with its Google Maps link.</p>}
                      <div className="row mt" style={{ flexWrap: 'wrap' }}>
                        <button type="button" className="btn small ghost" onClick={() => copy(welcome, 'welcome')}>{copied === 'welcome' ? 'Copied' : 'Copy message'}</button>
                        <button type="button" className="btn small" disabled={busy} onClick={() => groupDone(true)}>Group created</button>
                      </div>
                    </>
                  )}
                </div>
              )}

              <div className="step">
                <h4>{e.coach_id ? '4' : '3'}. Assessment time</h4>
                {!e.coach_id && <p className="hint">Assign a coach first.</p>}
                {canWork && e.coach_id && e.player_id && !logged && (
                  <>
                    {booked && <p><span className="tag turf">Booked</span> {when}. <Link href="/calendar">Open calendar</Link></p>}
                    <div className="row" style={{ flexWrap: 'wrap' }}>
                      <label className="field" style={{ flex: '1 1 150px' }}><span>Day</span>
                        <input type="date" value={date} onChange={(ev) => setDate(ev.target.value)} /></label>
                      <label className="field" style={{ flex: '0 0 100px' }}><span>Start</span>
                        <input type="text" inputMode="numeric" value={time} placeholder="e.g. 430" onChange={(ev) => setTime(ev.target.value)}
                               onBlur={() => setTime(normaliseTime(time) || time)} /></label>
                      <label className="field" style={{ flex: '1 1 150px' }}><span>Pitch</span>
                        <input type="text" list="pitches" value={location} onChange={(ev) => setLocation(ev.target.value)} placeholder="Choose or type a pitch" /></label>
                    </div>
                    <button type="button" className="btn small" disabled={busy} onClick={book}>{booked ? 'Move in calendar' : 'Add to calendar'}</button>
                    <p className="hint">It appears in {coach?.name ?? 'the coach'}&apos;s calendar. After the session, tap Completed there.</p>
                  </>
                )}
              </div>

              {canWork && e.coach_id && e.player_id && (
                <div className="step">
                  <h4>5. Payment link</h4>
                  {!booked && !logged ? <p className="hint">Book the assessment first. The message then includes the day, time and place.</p>
                    : !link ? <div className="notice warn">Add the Stripe assessment link on the Team page to include the payment link.</div>
                    : (
                      <>
                        <textarea value={pay} onChange={(ev) => setPay(ev.target.value)} style={{ minHeight: 170 }} aria-label="Payment message to the parent" />
                        <div className="row mt" style={{ flexWrap: 'wrap' }}>
                          {phone && <a className="btn small" target="_blank" rel="noreferrer" href={`https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(pay)}`}>WhatsApp</a>}
                          {mail && <a className="btn small ghost" href={`mailto:${mail}?subject=${encodeURIComponent(`Eleade assessment for ${first}`)}&body=${encodeURIComponent(pay)}`}>Email</a>}
                          <button type="button" className="btn small ghost" onClick={() => copy(pay, 'pay')}>{copied === 'pay' ? 'Copied' : 'Copy'}</button>
                        </div>
                      </>
                    )}
                  {payment
                    ? <p className="mt"><span className="tag turf">Paid</span> {money(payment.amount_total)} on {fmtDate(payment.paid_at.slice(0, 10))}.</p>
                    : <p className="mt"><span className="tag amber">Waiting</span> <span className="hint">Shows as paid by itself when the parent pays.</span></p>}
                </div>
              )}

              {canWork && e.coach_id && e.player_id && (booked || logged) && (
                <div className="step">
                  <h4>6. After the assessment</h4>
                  {!logged && <p className="hint">Tap Completed in the calendar first. The notes you write there fill the message below.</p>}
                  <textarea value={summary} onChange={(ev) => setSummary(ev.target.value)} style={{ minHeight: 190 }} aria-label="Summary message to the parent" />
                  <div className="row mt" style={{ flexWrap: 'wrap' }}>
                    {phone && <a className="btn small" target="_blank" rel="noreferrer" href={`https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(summary)}`}>WhatsApp</a>}
                    {mail && <a className="btn small ghost" href={`mailto:${mail}?subject=${encodeURIComponent(`${first}'s assessment with Eleade`)}&body=${encodeURIComponent(summary)}`}>Email</a>}
                    <button type="button" className="btn small ghost" onClick={() => copy(summary, 'sum')}>{copied === 'sum' ? 'Copied' : 'Copy'}</button>
                  </div>
                  <p className="hint mt">What did the parents decide?</p>
                  <div className="row" style={{ flexWrap: 'wrap' }}>
                    <button type="button" className="btn small" disabled={busy} onClick={() => outcome('package5')}>Committed to 5</button>
                    <button type="button" className="btn small" disabled={busy} onClick={() => outcome('package10')}>Committed to 10</button>
                    <button type="button" className="btn small ghost" disabled={busy} onClick={() => outcome('handover')}>Hand over to Jan</button>
                    <button type="button" className="btn small ghost" disabled={busy} onClick={() => outcome('not_continuing')}>Not continuing</button>
                  </div>
                </div>
              )}
            </>
          )}

          {e.status === 'done' && (
            <div className="step">
              <h4>Outcome</h4>
              <p>{e.outcome ? OUTCOME_LABEL[e.outcome] : 'Marked as done'}{e.outcome_at ? ` on ${fmtDate(e.outcome_at.slice(0, 10))}` : ''}.</p>
              {e.outcome === 'handover' && isAdmin && <p className="hint">Call the parents{phone ? ` on ${phone}` : ''}, then record the package on the player page.</p>}
              {(e.outcome === 'package5' || e.outcome === 'package10') && isAdmin && <p className="hint">Record the package on the player page so the credits are available.</p>}
              {e.player_id && <p><Link href={`/players/${e.player_id}`}>Open {player}</Link></p>}
              {isAdmin && <button type="button" className="btn small ghost" disabled={busy} onClick={() => setStatus(e.booking_id ? 'booked' : 'assigned')}>Reopen</button>}
            </div>
          )}

          {e.player_id && !finished && <p className="hint"><Link href={`/players/${e.player_id}`}>Open {player} in the app</Link></p>}
          {err && <div className="notice err" role="alert">{err}</div>}
          <div className="row mt" style={{ flexWrap: 'wrap' }}>
            {e.status === 'declined'
              ? <button type="button" className="btn small ghost" disabled={busy} onClick={() => setStatus(e.coach_id ? 'assigned' : 'new')}>Reopen</button>
              : e.status !== 'done' && <button type="button" className="btn small ghost" disabled={busy} onClick={() => setStatus('declined')}>Not a fit, decline</button>}
          </div>
        </div>
      )}
    </div>
  );
}
