'use client';
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { creditClass } from '@/lib/usePlayers';
import { SessionItem } from '@/components/SessionItem';
import { RegularSessions } from '@/components/RegularSessions';
import { fmtDate, fromISO, money, num, toISO, todayISO } from '@/lib/dates';
import { PAYMENT_LABEL, type PaymentMethod, type PlayerBalance, type SessionRow } from '@/lib/types';

type Player = {
  id: string; name: string; family: string | null; billing_model: 'package' | 'pay_per_session';
  session_price: number | null; main_coach_id: string | null; active: boolean; opening_confirmed: boolean; profile_notes: string | null;
  created_by: string | null;
};
type Ledger = { id: string; kind: string; sessions_delta: number; analyses_delta: number; package_name: string | null;
  amount_paid: number | null; reason: string; effective_date: string; expires_on: string | null; player_id: string;
  payment_status: 'awaiting' | 'confirmed'; payment_method: PaymentMethod | null; confirmed_at: string | null };
type Note = { id: string; body: string; author: string | null; created_at: string };

const KIND_LABEL: Record<string, string> = { opening: 'Opening balance', purchase: 'Package bought', free: 'Free session', correction: 'Correction', expiry: 'Expired' };

export default function PlayerPage() {
  const { id } = useParams<{ id: string }>();
  const { coaches, isAdmin, session } = useAuth();
  const [p, setP] = useState<Player | null>(null);
  const [bal, setBal] = useState<PlayerBalance | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [ledger, setLedger] = useState<Ledger[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [noteText, setNoteText] = useState('');
  const [showOld, setShowOld] = useState(false);
  const [err, setErr] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const router = useRouter();

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

  async function deletePlayer() {
    if (!p) return;
    if (!window.confirm(`Delete ${p.name}? This can't be undone.`)) return;
    const { error } = await supabase.rpc('delete_player', { p_player_id: id });
    if (error) setErr(errorText(error)); else router.replace('/players');
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
        {p.family ? `. Shares credits with the ${p.family} family.` : ''}
        {!p.active ? ' Not currently training.' : ''}
      </p>

      {p.billing_model === 'package' ? (
        <>
          <div className="scoreboard">
            <div><div className={`big ${cls}`}>{num(bal.sessions_left)}</div><div className="cap">sessions left</div></div>
            <div><div className="big">{num(bal.analyses_left)}</div><div className="cap">game analyses left</div></div>
          </div>
          {!p.opening_confirmed && <div className="notice warn">Starting balance taken from the old spreadsheet and not yet confirmed by Jan.</div>}
          {cls === 'out' && <div className="notice warn">No credits left. Jan needs to talk to the parents about the next package.</div>}
        </>
      ) : (
        <div className="notice">Pays per session by weekly bank transfer{p.session_price ? `, ${money(p.session_price)} a session` : ''}. No credits to track.</div>
      )}

      {p.profile_notes && <div className="notice ok"><strong>Arrangement:</strong> {p.profile_notes}</div>}

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
          <thead><tr><th>Date</th><th>What</th><th className="n">Sessions</th><th className="n">Analyses</th></tr></thead>
          <tbody>
            {ledger.map((l) => (
              <tr key={l.id}>
                <td>{fmtDate(l.effective_date)}</td>
                <td>
                  {KIND_LABEL[l.kind] ?? l.kind}{l.package_name ? `, ${l.package_name}` : ''}{l.amount_paid ? `, ${money(l.amount_paid)}` : ''}
                  <br /><span className="hint">{l.reason}{l.payment_method ? `, paid by ${PAYMENT_LABEL[l.payment_method].toLowerCase()}` : ''}</span>
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
                <td className="n">{Number(l.analyses_delta) > 0 ? '+' : ''}{num(l.analyses_delta)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {p.billing_model === 'package' && <RecordPackage playerId={p.id} name={p.name} onSaved={load} />}
      {isAdmin && <AdminPanel p={p} onSaved={load} />}
      {canManage && (
        <p className="mt">
          <button type="button" className="linkbtn" style={{ color: 'var(--red)' }} onClick={deletePlayer}>Delete this player</button>
          <br /><span className="hint">Only possible while the player has no sessions and no credit history, for example a name added by mistake.</span>
        </p>
      )}
      {err && <div className="notice err">{err}</div>}
    </>
  );
}

const PACKAGES = [
  { name: '5 pack', s: 5, a: 0, price: 650, months: 3 },
  { name: '10 pack', s: 10, a: 2, price: 1300, months: 6 },
  { name: 'Monthly', s: 4, a: 1, price: 650, months: 0 },
];

function AdminPanel({ p, onSaved }: { p: Player; onSaved: () => void }) {
  const { coaches } = useAuth();
  const [kind, setKind] = useState('free');
  const [pkg, setPkg] = useState('');
  const [s, setS] = useState('');
  const [a, setA] = useState('0');
  const [paid, setPaid] = useState('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(todayISO());
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [model, setModel] = useState(p.billing_model);
  const [price, setPrice] = useState(p.session_price?.toString() ?? '');
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
      player_id: p.id, kind, sessions_delta: Number(s || 0), analyses_delta: Number(a || 0),
      package_name: kind === 'purchase' ? pkg || null : null, amount_paid: paid ? Number(paid) : null,
      reason: reason.trim(), effective_date: date, expires_on: expires,
    });
    if (error) setErr(errorText(error));
    else { setMsg('Credits saved.'); setS(''); setA('0'); setPaid(''); setReason(''); setPkg(''); onSaved(); }
  }

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setMsg('');
    const { error } = await supabase.from('players').update({
      billing_model: model, session_price: price ? Number(price) : null, main_coach_id: main || null,
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
          <div className="seg" style={{ marginBottom: 12 }}>
            <button type="button" aria-pressed={model === 'package'} onClick={() => setModel('package')}>Package</button>
            <button type="button" aria-pressed={model === 'pay_per_session'} onClick={() => setModel('pay_per_session')}>Pays per session</button>
          </div>
          {model === 'pay_per_session' && (
            <label className="field"><span>Price per session, ex GST <span className="hint">(blank uses the default)</span></span>
              <input type="number" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
          )}
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

function RecordPackage({ playerId, name, onSaved }: { playerId: string; name: string; onSaved: () => void }) {
  const { isAdmin } = useAuth();
  const [pkg, setPkg] = useState('');
  const [method, setMethod] = useState<PaymentMethod | ''>('');
  const [date, setDate] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const k = PACKAGES.find((x) => x.name === pkg);

  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setMsg('');
    if (!k) { setErr('Pick the package first.'); return; }
    setBusy(true);
    let expires: string | null = null;
    if (k.months) { const d = fromISO(date); d.setMonth(d.getMonth() + k.months); expires = toISO(d); }
    const { error } = await supabase.from('credit_ledger').insert({
      player_id: playerId, kind: 'purchase', sessions_delta: k.s, analyses_delta: k.a,
      package_name: k.name, amount_paid: k.price, payment_method: method || null,
      payment_status: isAdmin && method ? 'confirmed' : 'awaiting',
      reason: `Bought ${k.name}`, effective_date: date, expires_on: expires,
    });
    setBusy(false);
    if (error) { setErr(errorText(error)); return; }
    setMsg(isAdmin
      ? `${k.name} added for ${name}${method ? ', payment checked.' : '. Confirm the payment in the credit history once it arrives.'}`
      : `${k.name} added for ${name}. The credits work straight away, and Jan will check the payment.`);
    setPkg(''); setMethod(''); onSaved();
  }

  return (
    <details className="panel">
      <summary>Record a package bought</summary>
      <form onSubmit={save}>
        <div className="field">
          <span className="fieldlabel">Package</span>
          <div className="seg">
            {PACKAGES.map((x) => (
              <button key={x.name} type="button" aria-pressed={pkg === x.name} onClick={() => setPkg(x.name)}>
                {x.name}
              </button>
            ))}
          </div>
          {k && <p className="hint mt">{k.s} sessions{k.a ? ` and ${k.a} game ${k.a === 1 ? 'analysis' : 'analyses'}` : ''}, {money(k.price)} ex GST{k.months ? `, valid ${k.months} months` : ', per month'}.</p>}
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
