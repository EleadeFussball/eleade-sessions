'use client';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { ClipUpload } from '@/components/ClipUpload';
import { PlayerDetails } from '@/components/PlayerDetails';
import { FeedbackHistory } from '@/components/FeedbackHistory';
import { creditClass } from '@/lib/usePlayers';
import { SessionItem } from '@/components/SessionItem';
import { RegularSessions } from '@/components/RegularSessions';
import { PackageCoverage } from '@/components/PackageCoverage';
import { AssessmentPayment } from '@/components/AssessmentPayment';
import { EnquiryInfo } from '@/components/EnquiryInfo';
import { fmtDate, fromISO, money, num, toISO, todayISO } from '@/lib/dates';
import { PAYMENT_LABEL, type PaymentMethod, type PlayerBalance, type SessionRow, PLAN_LABEL, CASUAL_METHOD_LABEL, type PaymentPlan } from '@/lib/types';

type Player = {
  id: string; name: string; family: string | null; billing_model: 'package' | 'pay_per_session';
  session_price: number | null; main_coach_id: string | null; active: boolean; opening_confirmed: boolean; profile_notes: string | null; drive_folder_id?: string | null;
  created_by: string | null; monthly_recurring?: boolean; pair_price?: number | null;
  payment_plan?: PaymentPlan; casual_method?: 'stripe' | 'cash' | 'bank' | 'other' | null; feedback_mode?: 'auto' | 'always' | 'never';
  parent_name?: string | null; dob?: string | null; email?: string | null; phone?: string | null; club?: string | null;
  position?: string | null; foot?: string | null; heard_from?: string | null; form_age_group?: string | null; enquiry_id?: string | null;
};
type Ledger = { id: string; kind: string; sessions_delta: number; analyses_delta: number; pairs_delta: number; package_name: string | null;
  amount_paid: number | null; reason: string; effective_date: string; expires_on: string | null; player_id: string;
  payment_status: 'awaiting' | 'confirmed'; payment_method: PaymentMethod | null; confirmed_at: string | null; edited_at?: string | null };
type Note = { id: string; body: string; author: string | null; created_at: string };

const KIND_LABEL: Record<string, string> = { opening: 'Opening balance', purchase: 'Package bought', free: 'Free session', correction: 'Correction', expiry: 'Expired' };

export default function PlayerPage() {
  const { id } = useParams<{ id: string }>();
  const { coaches, isAdmin, session } = useAuth();
  const [p, setP] = useState<Player | null>(null);
  const [bal, setBal] = useState<PlayerBalance | null>(null);
  const [expiry, setExpiry] = useState<{ player_id: string; family: string | null; expires_on: string; days_left: number; package_name: string | null }[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [ledger, setLedger] = useState<Ledger[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [noteText, setNoteText] = useState('');
  const [showOld, setShowOld] = useState(false);
  const [err, setErr] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [editingLedger, setEditingLedger] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');

  const load = useCallback(async () => {
    const [pl, b, ss, lg, nt] = await Promise.all([
      supabase.from('players').select('*').eq('id', id).single(),
      supabase.from('player_balances').select('*').eq('player_id', id).single(),
      supabase.from('sessions').select('*, session_players!inner(player_id, players(name))')
        .eq('session_players.player_id', id).order('session_date', { ascending: false }).order('logged_at', { ascending: false }),
      supabase.from('credit_ledger').select('*').eq('player_id', id).order('effective_date', { ascending: false }),
      supabase.from('player_notes').select('*').eq('player_id', id).order('created_at', { ascending: false }),
    ]);
    if (pl.error) setErr(pl.error.message);
    setP(pl.data as Player); setBal(b.data as PlayerBalance);
    setSessions((ss.data as SessionRow[]) ?? []); setLedger((lg.data as Ledger[]) ?? []); setNotes((nt.data as Note[]) ?? []);
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    supabase.from('expiring_packages').select('player_id, family, expires_on, days_left, package_name')
      .then(({ data }) => setExpiry((data as typeof expiry) ?? []));
  }, [id]);

  // the full participant list for group sessions (the inner join above only returns this player)
  const [groupNames, setGroupNames] = useState<Record<string, string>>({});
  useEffect(() => {
    const groupIds = sessions.filter((s) => s.format === '2:1' || s.format === '4:1').map((s) => s.id);
    if (!groupIds.length) return;
    supabase.from('session_players').select('session_id, players(name)').in('session_id', groupIds).then(({ data }) => {
      const m: Record<string, string[]> = {};
      (data ?? []).forEach((r: { session_id: string; players: { name: string } | { name: string }[] | null }) => {
        const n = Array.isArray(r.players) ? r.players[0]?.name : r.players?.name;
        (m[r.session_id] ||= []).push(n ?? '');
      });
      setGroupNames(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.sort().join(', ')])));
    });
  }, [sessions]);

  async function addNote(e: React.FormEvent) {
    e.preventDefault();
    if (!noteText.trim()) return;
    const { error } = await supabase.from('player_notes').insert({ player_id: id, body: noteText.trim() });
    if (error) setErr(errorText(error)); else { setNoteText(''); load(); }
  }
  async function saveName(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    const { error } = await supabase.rpc('rename_player', { p_player_id: id, p_name: nameDraft });
    if (error) setErr(errorText(error)); else { setEditingName(false); load(); }
  }

  async function confirmPackage(ledgerId: string) {
    const { error } = await supabase.from('credit_ledger').update({ payment_status: 'confirmed' }).eq('id', ledgerId);
    if (error) setErr(errorText(error)); else load();
  }
  async function deleteNote(n: Note) {
    const { error } = await supabase.from('player_notes').delete().eq('id', n.id);
    if (error) setErr(errorText(error)); else load();
  }

  if (!p || !bal) return <p className="empty">{err || 'Loading player'}</p>;
  const canManage = isAdmin || (!!p.created_by && p.created_by === session?.user.id);
  const coachName = (cid: string | null) => coaches.find((c) => c.id === cid)?.name ?? '';
  const live = sessions.filter((s) => !s.imported);
  const old = sessions.filter((s) => s.imported);
  const cls = creditClass(bal);
  const hasPairs = bal.pairs_left !== null && bal.pairs_left !== undefined;

  return (
    <>
      <p><Link href="/players">Players</Link></p>
      {err && editingName && <div className="notice err" role="alert">{err}</div>}
      {editingName ? (
        <form onSubmit={saveName} className="row" style={{ alignItems: 'flex-end', marginBottom: 12 }}>
          <label className="field" style={{ marginBottom: 0 }}><span>Player name</span>
            <input type="text" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} autoFocus /></label>
          <button className="btn small" style={{ flex: '0 0 auto' }}>Save</button>
          <button type="button" className="btn small ghost" style={{ flex: '0 0 auto' }} onClick={() => setEditingName(false)}>Cancel</button>
        </form>
      ) : (
        <h1>
          {p.name}{' '}
          {canManage && <button type="button" className="linkbtn" style={{ fontSize: '1rem', fontFamily: 'var(--body)' }}
                                onClick={() => { setNameDraft(p.name); setEditingName(true); }}>Edit name</button>}
        </h1>
      )}
      <p className="muted">
        {coachName(p.main_coach_id) ? `Main coach ${coachName(p.main_coach_id)}` : 'No main coach'}
        {p.family ? <>. Shares credits with the {p.family} family (<Link href="/families">see family account</Link>).</> : ''}
        {!p.active ? ' Not currently training.' : ''}
      </p>
      <PlayerDetails key={`${p.id}${p.dob}${p.club}${p.parent_name}${p.email}`} p={p} onSaved={load} />

      {p.billing_model === 'package' ? (
        <>
          <div className="scoreboard">
            <div><div className={`big ${cls}`}>{num(bal.sessions_left)}</div><div className="cap">{hasPairs ? '1:1 sessions left' : 'sessions left'}</div></div>
            {bal.pairs_left !== null && bal.pairs_left !== undefined && (
              <div><div className={`big${Number(bal.pairs_left) < 0 ? ' out' : ''}`}>{num(bal.pairs_left)}</div><div className="cap">{Number(bal.pairs_left) < 0 ? '2:1 sessions to pay' : '2:1 sessions left'}</div></div>
            )}
            <div><div className="big">{num(bal.analyses_left)}</div><div className="cap">game analyses left</div></div>
          </div>
          {!p.opening_confirmed && p.billing_model === 'package' && <div className="notice warn">Balance not checked yet.</div>}
          {p.opening_confirmed && !hasPairs && Number(bal.sessions_left ?? 0) <= 0 && <div className="notice err">New package needed: no sessions left.</div>}
          {p.opening_confirmed && hasPairs && Number(bal.sessions_left ?? 0) < 0 && <div className="notice err">1:1 sessions to pay: a new 1:1 package is needed.</div>}
          {p.opening_confirmed && hasPairs && Number(bal.pairs_left ?? 0) <= 0 && <div className="notice err">New 2:1 package needed: no 2:1 sessions left.</div>}
          {expiry.filter((e) => e.player_id === p.id || (p.family && e.family === p.family)).map((e) => (
            <div key={e.expires_on} className="notice warn">
              {e.days_left >= 0
                ? `${e.package_name ?? 'Package'} expires on ${fmtDate(e.expires_on)} (in ${e.days_left} day${e.days_left === 1 ? '' : 's'}) with credits still left. Book the remaining sessions, or Jan talks to the parents about renewing.`
                : `${e.package_name ?? 'Package'} expired on ${fmtDate(e.expires_on)} with credits still left. Jan decides whether to extend it.`}
            </div>
          ))}
          {cls === 'out' && <div className="notice warn">No credits left. Jan needs to talk to the parents about the next package.</div>}
        </>
      ) : (
        <div className="notice">{p.payment_plan === 'casual'
          ? `Casual: pays each session on its own${p.casual_method ? ` by ${CASUAL_METHOD_LABEL[p.casual_method].toLowerCase()}` : ''}`
          : 'Pays weekly by bank transfer'}{p.session_price ? `, ${money(p.session_price)} a session` : ''}. No credits to track.</div>
      )}

      {p.billing_model === 'package' && <PackageCoverage playerId={p.id} family={p.family} />}

      {isAdmin && (
        <p className="hint">Prices ex GST: 1:1 {money(p.session_price ?? 120)} a session, 2:1 {money(p.pair_price ?? 75)} per player a session{p.session_price === null && p.pair_price == null ? ' (standard)' : ''}.</p>
      )}
      {isAdmin && <PaymentSettings p={p} onSaved={load} />}
      {isAdmin && <FeedbackSetting p={p} onSaved={load} />}

      {p.profile_notes && <div className="notice ok"><strong>Arrangement:</strong> {p.profile_notes}</div>}

      <EnquiryInfo playerId={p.id} />
      <AssessmentPayment playerId={p.id} playerName={p.name} />

      <h2>Notes</h2>
      <form onSubmit={addNote}>
        <textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Anything the next coach should know about this player" style={{ minHeight: 64 }} />
        <button className="btn small mt" disabled={!noteText.trim()}>Add note</button>
      </form>
      {notes.length > 0 && (
        <ul className="list mt">
          {notes.map((n) => (
            <li key={n.id} className="session">
              <div className="sub">{fmtDate(n.created_at.slice(0, 10))}, {coaches.find((c) => c.user_id === n.author)?.name ?? 'Coach'}</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
              {(isAdmin || n.author === session?.user.id) && <button className="linkbtn" type="button" onClick={() => deleteNote(n)}>Delete</button>}
            </li>
          ))}
        </ul>
      )}

      {p.active && <RegularSessions playerId={p.id} />}

      <h2>Sessions</h2>
      {live.length === 0 && <p className="empty">No sessions logged in the new system yet.</p>}
      <ul className="list">
        {live.map((s) => (
          <SessionItem key={s.id} s={{ ...s, session_players: groupNames[s.id] ? groupNames[s.id].split(', ').map((n) => ({ player_id: '', players: { name: n } })) : [] }}
                       showPlayers={!!groupNames[s.id]} onChanged={load} />
        ))}
      </ul>
      {old.length > 0 && (
        <details className="panel" open={showOld} onToggle={(e) => setShowOld((e.target as HTMLDetailsElement).open)}>
          <summary>Earlier documentation, {old.length} sessions</summary>
          {showOld && <ul className="list">{old.map((s) => <SessionItem key={s.id} s={s} onChanged={load} />)}</ul>}
        </details>
      )}

      <h2>Credit history</h2>
      {ledger.length === 0 ? <p className="empty">No credits recorded{p.family ? ' on this player. Family credits may sit with a sibling.' : '.'}</p> : (
        <table className="t">
          <thead><tr><th>Date</th><th>What</th><th className="n">1:1 sessions</th><th className="n">2:1 sessions</th><th className="n">Analyses</th></tr></thead>
          <tbody>
            {ledger.map((l) => editingLedger === l.id ? (
              <tr key={l.id}><td colSpan={5}>
                <LedgerEdit l={l} onCancel={() => setEditingLedger(null)} onSaved={() => { setEditingLedger(null); load(); }} />
              </td></tr>
            ) : (
              <tr key={l.id}>
                <td>{fmtDate(l.effective_date)}</td>
                <td>
                  {KIND_LABEL[l.kind] ?? l.kind}{l.package_name ? `, ${l.package_name}` : ''}{l.amount_paid ? `, ${money(l.amount_paid)}` : ''}
                  <br /><span className="hint">{l.reason}{l.payment_method ? `, paid by ${PAYMENT_LABEL[l.payment_method].toLowerCase()}` : ''}{l.edited_at ? `, changed ${fmtDate(l.edited_at.slice(0, 10))}` : ''}</span>
                  {isAdmin && <button type="button" className="linkbtn" style={{ marginLeft: 8 }} onClick={() => setEditingLedger(l.id)}>Edit</button>}
                  {l.kind === 'purchase' && (
                    <div style={{ marginTop: 4 }}>
                      {l.payment_status === 'awaiting'
                        ? <span className="tag amber">Payment to check</span>
                        : <span className="tag turf">Payment checked</span>}
                      {isAdmin && l.payment_status === 'awaiting' && (
                        <button type="button" className="linkbtn" style={{ marginLeft: 10 }} onClick={() => confirmPackage(l.id)}>Confirm paid</button>
                      )}
                    </div>
                  )}
                </td>
                <td className="n">{Number(l.sessions_delta) > 0 ? '+' : ''}{num(l.sessions_delta)}</td>
                <td className="n">{Number(l.pairs_delta) > 0 ? '+' : ''}{num(l.pairs_delta)}</td>
                <td className="n">{Number(l.analyses_delta) > 0 ? '+' : ''}{num(l.analyses_delta)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ClipUpload playerId={p.id} playerName={p.name} folderId={p.drive_folder_id ?? null} />
      <FeedbackHistory playerId={p.id} />

      {(p.billing_model === 'package' || isAdmin) && <RecordPackage playerId={p.id} name={p.name} billing={p.billing_model} onSaved={load} />}
      {isAdmin && <AdminPanel p={p} onSaved={load} />}

      {err && <div className="notice err">{err}</div>}
    </>
  );
}

/** Jan only: change or remove a credit entry (package, correction, opening balance). */
function LedgerEdit({ l, onSaved, onCancel }: { l: Ledger; onSaved: () => void; onCancel: () => void }) {
  const [name, setName] = useState(l.package_name ?? '');
  const [s, setS] = useState(String(Number(l.sessions_delta)));
  const [p2, setP2] = useState(String(Number(l.pairs_delta ?? 0)));
  const [a, setA] = useState(String(Number(l.analyses_delta)));
  const [price, setPrice] = useState(l.amount_paid === null ? '' : String(Number(l.amount_paid)));
  const [date, setDate] = useState(l.effective_date);
  const [expires, setExpires] = useState(l.expires_on ?? '');
  const [reason, setReason] = useState(l.reason ?? '');
  const [paid, setPaid] = useState(l.payment_status === 'confirmed');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const n = (v: string) => Number(v.replace(',', '.'));

  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    if ([s, p2, a].some((v) => !Number.isFinite(n(v)))) { setErr('Sessions and analyses must be numbers (use a minus for credits taken off).'); return; }
    if (price.trim() && !(n(price) >= 0)) { setErr('Enter the price ex GST, or leave it empty.'); return; }
    setBusy(true);
    const { error } = await supabase.from('credit_ledger').update({
      package_name: name.trim() || null, sessions_delta: n(s), pairs_delta: n(p2), analyses_delta: n(a),
      amount_paid: price.trim() ? n(price) : null, effective_date: date, expires_on: expires || null,
      reason: reason.trim() || (name.trim() ? `Bought ${name.trim()}` : 'Correction'),
      ...(l.kind === 'purchase' ? { payment_status: paid ? 'confirmed' : 'awaiting' } : {}),
    }).eq('id', l.id);
    setBusy(false);
    if (error) setErr(errorText(error)); else onSaved();
  }

  async function remove() {
    if (!window.confirm('Remove this entry? The balance is recalculated straight away.')) return;
    setBusy(true);
    const { error } = await supabase.from('credit_ledger').delete().eq('id', l.id);
    setBusy(false);
    if (error) setErr(errorText(error)); else onSaved();
  }

  return (
    <form onSubmit={save} className="panel-form" style={{ margin: '4px 0' }}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="field" style={{ flex: '2 1 160px' }}><span>Package</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 10 pack" /></label>
        <label className="field" style={{ flex: '1 1 110px' }}><span>Price ex GST</span>
          <input type="text" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="field" style={{ flex: '1 1 80px' }}><span>1:1 sessions</span>
          <input type="text" inputMode="decimal" value={s} onChange={(e) => setS(e.target.value)} /></label>
        <label className="field" style={{ flex: '1 1 80px' }}><span>2:1 sessions</span>
          <input type="text" inputMode="decimal" value={p2} onChange={(e) => setP2(e.target.value)} /></label>
        <label className="field" style={{ flex: '1 1 80px' }}><span>Analyses</span>
          <input type="text" inputMode="decimal" value={a} onChange={(e) => setA(e.target.value)} /></label>
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="field" style={{ flex: '1 1 140px' }}><span>Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="field" style={{ flex: '1 1 140px' }}><span>Expires <span className="hint">(optional)</span></span>
          <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></label>
      </div>
      <label className="field"><span>Note</span><input type="text" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      {l.kind === 'purchase' && (
        <label className="check"><input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} /><span>Payment received</span></label>
      )}
      {err && <div className="notice err" role="alert">{err}</div>}
      <div className="row mt" style={{ flexWrap: 'wrap' }}>
        <button className="btn small" disabled={busy}>{busy ? 'Saving' : 'Save changes'}</button>
        <button type="button" className="btn small ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn small ghost" style={{ color: 'var(--red)' }} disabled={busy} onClick={remove}>Remove entry</button>
      </div>
      <p className="hint">Credits and balances update straight away. Use a minus for credits taken off.</p>
    </form>
  );
}

const TAILORED = '__tailored__';
const PACKAGES = [
  { name: '5 pack', s: 5, a: 0, price: 650, months: 3 },
  { name: '10 pack', s: 10, a: 1, price: 1250, months: 6 },
  { name: 'Monthly', s: 4, a: 1, price: 650, months: 0 },
];

function AdminPanel({ p, onSaved }: { p: Player; onSaved: () => void }) {
  const { coaches } = useAuth();
  const [kind, setKind] = useState('free');
  const [pkg, setPkg] = useState('');
  const [s, setS] = useState('');
  const [a, setA] = useState('0');
  const [pr, setPr] = useState('0');
  const [paid, setPaid] = useState('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(todayISO());
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [main, setMain] = useState(p.main_coach_id ?? '');
  const [family, setFamily] = useState(p.family ?? '');
  const [arr, setArr] = useState(p.profile_notes ?? '');
  const [active, setActive] = useState(p.active);
  const [confirmed, setConfirmed] = useState(p.opening_confirmed);

  function pickPackage(name: string) {
    setPkg(name);
    const k = PACKAGES.find((x) => x.name === name);
    if (k) { setS(String(k.s)); setA(String(k.a)); setPaid(String(k.price)); setReason(`Bought ${k.name}`); }
  }

  async function addCredits(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setMsg('');
    const k = PACKAGES.find((x) => x.name === pkg);
    let expires: string | null = null;
    if (kind === 'purchase' && k?.months) {
      const d = fromISO(date); d.setMonth(d.getMonth() + k.months); expires = toISO(d);
    }
    const { error } = await supabase.from('credit_ledger').insert({
      player_id: p.id, kind, sessions_delta: Number(s || 0), analyses_delta: Number(a || 0), pairs_delta: Number(pr || 0),
      package_name: kind === 'purchase' ? pkg || null : null, amount_paid: paid ? Number(paid) : null,
      reason: reason.trim(), effective_date: date, expires_on: expires,
    });
    if (error) setErr(errorText(error));
    else { setMsg('Credits saved.'); setS(''); setA('0'); setPr('0'); setPaid(''); setReason(''); setPkg(''); onSaved(); }
  }

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setMsg('');
    const { error } = await supabase.from('players').update({
      main_coach_id: main || null,
      family: family.trim() || null, profile_notes: arr.trim() || null, active, opening_confirmed: confirmed,
    }).eq('id', p.id);
    if (error) setErr(errorText(error)); else { setMsg('Player saved.'); onSaved(); }
  }

  return (
    <>
      <h2>Admin</h2>
      {msg && <div className="notice ok">{msg}</div>}
      {err && <div className="notice err">{err}</div>}
      <details className="panel">
        <summary>Free session or correction</summary>
        <form onSubmit={addCredits}>
          <div className="seg" style={{ marginBottom: 12 }}>
            {[['free', 'Free session'], ['correction', 'Correction']].map(([k, l]) => (
              <button key={k} type="button" aria-pressed={kind === k} onClick={() => { setKind(k); if (k !== 'purchase') setPkg(''); }}>{l}</button>
            ))}
          </div>
          {kind === 'purchase' && (
            <div className="seg" style={{ marginBottom: 12 }}>
              {PACKAGES.map((k) => <button key={k.name} type="button" aria-pressed={pkg === k.name} onClick={() => pickPackage(k.name)}>{k.name}</button>)}
            </div>
          )}
          <div className="row">
            <label className="field"><span>Sessions</span><input type="number" step="0.5" value={s} onChange={(e) => setS(e.target.value)} placeholder="e.g. 5 or -1" required /></label>
            <label className="field"><span>2:1 sessions</span><input type="number" step="0.5" value={pr} onChange={(e) => setPr(e.target.value)} /></label>
            <label className="field"><span>Analyses</span><input type="number" step="1" value={a} onChange={(e) => setA(e.target.value)} /></label>
          </div>
          <div className="row">
            {kind === 'purchase' && <label className="field"><span>Paid, ex GST</span><input type="number" value={paid} onChange={(e) => setPaid(e.target.value)} /></label>}
            <label className="field"><span>Date</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          </div>
          <label className="field"><span>Reason</span><input type="text" required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Free session for referral" /></label>
          <button className="btn small">Save credits</button>
        </form>
      </details>
      <details className="panel">
        <summary>Player settings</summary>
        <form onSubmit={saveSettings}>
          <div className="row">
            <label className="field"><span>Main coach</span>
              <select value={main} onChange={(e) => setMain(e.target.value)}>
                <option value="">None</option>
                {coaches.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></label>
            <label className="field"><span>Family <span className="hint">(shared credits)</span></span>
              <input type="text" value={family} onChange={(e) => setFamily(e.target.value)} /></label>
          </div>
          <label className="field"><span>Arrangement <span className="hint">(shown at the top of the profile)</span></span>
            <textarea value={arr} onChange={(e) => setArr(e.target.value)} placeholder="e.g. Brother discount, 1 free session per 10 pack" style={{ minHeight: 64 }} /></label>
          <label className="field" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ width: 22, height: 22 }} />
            <span style={{ margin: 0 }}>Starting balance confirmed</span></label>
          <label className="field" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} style={{ width: 22, height: 22 }} />
            <span style={{ margin: 0 }}>Currently training</span></label>
          <button className="btn small">Save player</button>
        </form>
      </details>
    </>
  );
}

function RecordPackage({ playerId, name, billing, onSaved }: { playerId: string; name: string; billing: Player['billing_model']; onSaved: () => void }) {
  const { isAdmin } = useAuth();
  const [pkg, setPkg] = useState('');
  const [method, setMethod] = useState<PaymentMethod | ''>('');
  const [date, setDate] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [tS, setTS] = useState('');
  const [tA, setTA] = useState('0');
  const [tP, setTP] = useState('0');
  const [tPrice, setTPrice] = useState('');
  const tailored = pkg === TAILORED;
  const k = tailored
    ? { name: 'Tailored package', s: Number(tS || 0), a: Number(tA || 0), p: Number(tP || 0), price: Number(tPrice || 0), months: 0 }
    : (() => { const x = PACKAGES.find((y) => y.name === pkg); return x ? { ...x, p: 0 } : undefined; })();

  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setMsg('');
    if (!k) { setErr('Pick the package first.'); return; }
    if (tailored) {
      if (!Number.isInteger(k.s) || !Number.isInteger(k.a) || !Number.isInteger(k.p) || k.s < 0 || k.a < 0 || k.p < 0 || k.s + k.a + k.p === 0) {
        setErr('Enter the number of 1:1 sessions, 2:1 sessions and/or game analyses (whole numbers).'); return;
      }
      if (!tPrice.trim() || !(k.price >= 0)) { setErr('Enter the price, ex GST.'); return; }
    }
    setBusy(true);
    let expires: string | null = null;
    if (k.months) { const d = fromISO(date); d.setMonth(d.getMonth() + k.months); expires = toISO(d); }
    if (billing === 'pay_per_session' && isAdmin) {
      const sw = await supabase.from('players').update({ billing_model: 'package' }).eq('id', playerId);
      if (sw.error) { setBusy(false); setErr(errorText(sw.error)); return; }
    }
    const { error } = await supabase.from('credit_ledger').insert({
      player_id: playerId, kind: 'purchase', sessions_delta: k.s, analyses_delta: k.a, pairs_delta: k.p,
      package_name: k.name, amount_paid: k.price, payment_method: method || null,
      payment_status: isAdmin && method ? 'confirmed' : 'awaiting',
      reason: tailored
        ? `Tailored package: ${k.s} session${k.s === 1 ? '' : 's'}${k.p ? `, ${k.p} 2:1 session${k.p === 1 ? '' : 's'}` : ''}${k.a ? `, ${k.a} game ${k.a === 1 ? 'analysis' : 'analyses'}` : ''}`
        : `Bought ${k.name}`,
      effective_date: date, expires_on: expires,
    });
    setBusy(false);
    if (error) { setErr(errorText(error)); return; }
    setMsg(isAdmin
      ? `${k.name} added for ${name}${billing === 'pay_per_session' ? ', who is now on a package' : ''}${method ? ', payment checked.' : '. Confirm the payment in the credit history once it arrives.'}`
      : `${k.name} added for ${name}. The credits work straight away, and Jan will check the payment.`);
    setPkg(''); setMethod(''); setTS(''); setTA('0'); setTP('0'); setTPrice(''); onSaved();
  }

  return (
    <details className="panel">
      <summary>{billing === 'pay_per_session' ? 'Record a package bought (switches to package)' : 'Record a package bought'}</summary>
      <form onSubmit={save}>
        <div className="field">
          <span className="fieldlabel">Package</span>
          <div className="seg">
            {PACKAGES.map((x) => (
              <button key={x.name} type="button" aria-pressed={pkg === x.name} onClick={() => setPkg(x.name)}>
                {x.name}
              </button>
            ))}
            <button type="button" aria-pressed={tailored} onClick={() => setPkg(TAILORED)}>Tailored package</button>
          </div>
          {tailored && (
            <div className="row mt" style={{ flexWrap: 'wrap' }}>
              <label className="field" style={{ flex: '1 1 90px' }}><span>1:1 sessions</span>
                <input type="number" inputMode="numeric" min={0} step={1} value={tS} onChange={(e) => setTS(e.target.value)} placeholder="e.g. 8" /></label>
              <label className="field" style={{ flex: '1 1 90px' }}><span>2:1 sessions</span>
                <input type="number" inputMode="numeric" min={0} step={1} value={tP} onChange={(e) => setTP(e.target.value)} /></label>
              <label className="field" style={{ flex: '1 1 90px' }}><span>Game analyses</span>
                <input type="number" inputMode="numeric" min={0} step={1} value={tA} onChange={(e) => setTA(e.target.value)} /></label>
              <label className="field" style={{ flex: '1 1 110px' }}><span>Price, ex GST ($)</span>
                <input type="number" inputMode="decimal" min={0} step="0.01" value={tPrice} onChange={(e) => setTPrice(e.target.value)} placeholder="e.g. 1000" /></label>
            </div>
          )}
          {k && !tailored && <p className="hint mt">{k.s} sessions{k.a ? ` and ${k.a} game ${k.a === 1 ? 'analysis' : 'analyses'}` : ''}, {money(k.price)} ex GST{k.months ? `, valid ${k.months} months` : ', per month'}.</p>}
        </div>
        <div className="field">
          <span className="fieldlabel">How did they pay?</span>
          <div className="seg">
            {(['stripe', 'bank', 'cash'] as PaymentMethod[]).map((m) => (
              <button key={m} type="button" aria-pressed={method === m} onClick={() => setMethod(method === m ? '' : m)}>{PAYMENT_LABEL[m]}</button>
            ))}
            <button type="button" aria-pressed={method === ''} onClick={() => setMethod('')}>Not paid yet</button>
          </div>
        </div>
        <label className="field"><span>Date bought</span><input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} /></label>
        {err && <div className="notice err" role="alert">{err}</div>}
        {msg && <div className="notice ok" role="status">{msg}</div>}
        <button className="btn small" disabled={busy}>{busy ? 'Saving' : 'Add package'}</button>
      </form>
    </details>
  );
}

const FEEDBACK_LABEL = { auto: 'Automatic', always: 'Always', never: 'Never' } as const;

/** Jan only: does this player get the two-monthly feedback? Automatic means regular players only. */
function FeedbackSetting({ p, onSaved }: { p: Player; onSaved: () => void }) {
  const current = p.feedback_mode ?? 'auto';
  const [err, setErr] = useState('');
  async function pick(mode: 'auto' | 'always' | 'never') {
    setErr('');
    const { error } = await supabase.from('players').update({ feedback_mode: mode }).eq('id', p.id);
    if (error) setErr(errorText(error)); else onSaved();
  }
  return (
    <details className="panel">
      <summary>Feedback every two months: {FEEDBACK_LABEL[current]}</summary>
      <div className="seg" style={{ marginBottom: 12 }}>
        {(['auto', 'always', 'never'] as const).map((m) => (
          <button key={m} type="button" aria-pressed={current === m} onClick={() => pick(m)}>{FEEDBACK_LABEL[m]}</button>
        ))}
      </div>
      <p className="hint">
        <strong>Automatic:</strong> only for regular players, meaning a regular weekly session or at least 4 sessions in the two months (late cancellations count).
        <strong> Always</strong> asks the coach every period. <strong>Never</strong> leaves {p.name.split(' ')[0]} out, for example a casual or one-off player.
      </p>
      {err && <div className="notice err">{err}</div>}
    </details>
  );
}

/** How this player pays. Jan can change it at any time; credits and history are kept. */
function PaymentSettings({ p, onSaved }: { p: Player; onSaved: () => void }) {
  const current: PaymentPlan = p.payment_plan ?? (p.billing_model === 'package' ? (p.monthly_recurring ? 'monthly' : 'package') : 'weekly');
  const [plan, setPlan] = useState<PaymentPlan>(current);
  const [method, setMethod] = useState<'stripe' | 'cash' | 'bank' | 'other'>(p.casual_method ?? 'stripe');
  const [price, setPrice] = useState(p.session_price?.toString() ?? '');
  const [pairPrice, setPairPrice] = useState(p.pair_price?.toString() ?? '');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { setPlan(current); setMethod(p.casual_method ?? 'stripe'); setPrice(p.session_price?.toString() ?? ''); setPairPrice(p.pair_price?.toString() ?? ''); }, [current, p.casual_method, p.session_price, p.pair_price]);

  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setMsg('');
    const { error } = await supabase.from('players').update({
      payment_plan: plan, casual_method: plan === 'casual' ? method : null,
      session_price: price.trim() ? Number(price) : null, pair_price: pairPrice.trim() ? Number(pairPrice) : null,
    }).eq('id', p.id);
    if (error) setErr(errorText(error)); else { setMsg('Payment settings saved.'); onSaved(); }
  }

  return (
    <details className="panel">
      <summary>How {p.name.split(' ')[0]} pays: {PLAN_LABEL[current]}{current === 'casual' && p.casual_method ? `, ${CASUAL_METHOD_LABEL[p.casual_method]}` : ''}</summary>
      <form onSubmit={save}>
        <div className="seg" style={{ marginBottom: 12 }}>
          {(['monthly', 'package', 'weekly', 'casual'] as PaymentPlan[]).map((k) => (
            <button key={k} type="button" aria-pressed={plan === k} onClick={() => setPlan(k)}>{PLAN_LABEL[k]}</button>
          ))}
        </div>
        {plan === 'monthly' && <p className="hint"><strong>Monthly package:</strong> 4 sessions and 1 game analysis a month ($650 + GST). The MYOB reminder comes 5 days before each new month. Credits count down with each session.</p>}
        {plan === 'package' && <p className="hint"><strong>Casual package:</strong> a 5 or 10 pack (or tailored). Credits count down with each session, and the MYOB reminder comes when one credit or less is left.</p>}
        {plan === 'weekly' && <p className="hint"><strong>Pays weekly:</strong> no credits. Sessions are added up each week and paid by bank transfer; you mark the week as paid on the Admin page.</p>}
        {plan === 'casual' && (
          <>
            <p className="hint"><strong>Casual:</strong> no credits and never package credit. Each session is paid on its own; this way of paying is preselected when a coach logs the session, and a session logged without it gets it automatically. Choose <em>Pays Jan directly</em> when the player pays you (cash or transfer) and the coach is paid through the invoice: the session shows as awaiting payment until you confirm it.</p>
            <div className="seg" style={{ marginBottom: 12 }}>
              {(['stripe', 'cash', 'bank', 'other'] as const).map((m) => <button key={m} type="button" aria-pressed={method === m} onClick={() => setMethod(m)}>{CASUAL_METHOD_LABEL[m]}</button>)}
            </div>
          </>
        )}
        {plan !== current && <p className="hint">Changing how a player pays keeps all credits and history. Unused package credits carry over.</p>}
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <label className="field" style={{ flex: '1 1 140px' }}><span>1:1 price per session, ex GST</span>
            <input type="number" inputMode="decimal" value={price} placeholder="120" onChange={(e) => setPrice(e.target.value)} /></label>
          <label className="field" style={{ flex: '1 1 140px' }}><span>2:1 price per session, per player, ex GST</span>
            <input type="number" inputMode="decimal" value={pairPrice} placeholder="75" onChange={(e) => setPairPrice(e.target.value)} /></label>
        </div>
        <p className="hint">Leave empty for the standard prices ($120 for 1:1, $75 per player for 2:1). Used for weekly payers, sessions paid on their own and cash a coach keeps.</p>
        <p className="hint">Single sessions and assessments can also be paid one by one: the coach picks Stripe link, bank transfer or cash when logging the session. Changing the setting keeps all credits and history. Recording a package for a weekly player switches them to a package.</p>
        {msg && <div className="notice ok">{msg}</div>}
        {err && <div className="notice err">{err}</div>}
        <button className="btn small">Save payment settings</button>
      </form>
    </details>
  );
}
