'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import { usePlayers, creditClass } from '@/lib/usePlayers';
import { fmtDate, num } from '@/lib/dates';
import { planTag } from '@/lib/types';
import { ageGroup } from '@/lib/age';
import { errorText } from '@/lib/supabase';

type Filter = 'all' | 'mine' | 'low' | 'monthly' | 'weekly' | 'casual';

export default function PlayersPage() {
  const { coach, coaches } = useAuth();
  const { players, loading, error, createPlayer } = usePlayers(true);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [addMsg, setAddMsg] = useState('');
  const [addErr, setAddErr] = useState('');
  const coachName = (id: string | null) => coaches.find((c) => c.id === id)?.name ?? '';

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return players.filter((p) => {
      if (p.active === false && !s) return false;
      if (s && !p.name.toLowerCase().includes(s)) return false;
      if (filter === 'mine') return p.main_coach_id === coach?.id;
      if (filter === 'low') return p.billing_model === 'package' && Number(p.sessions_left ?? 0) <= 2;
      if (filter === 'monthly') return p.payment_plan === 'monthly';
      if (filter === 'weekly') return p.payment_plan === 'weekly';
      if (filter === 'casual') return p.payment_plan === 'casual';
      return true;
    });
  }, [players, q, filter, coach]);

  const activeNow = players.filter((p) => p.active !== false);
  const counts = {
    all: activeNow.length,
    mine: activeNow.filter((p) => p.main_coach_id === coach?.id).length,
    low: activeNow.filter((p) => p.billing_model === 'package' && Number(p.sessions_left ?? 0) <= 2).length,
    monthly: activeNow.filter((p) => p.payment_plan === 'monthly').length,
    weekly: activeNow.filter((p) => p.payment_plan === 'weekly').length,
    casual: activeNow.filter((p) => p.payment_plan === 'casual').length,
  };

  return (
    <>
      <h1>Players</h1>
      <details className="panel" style={{ marginBottom: 12 }}>
        <summary>Add a new player</summary>
        <form onSubmit={async (e) => {
          e.preventDefault(); setAddErr(''); setAddMsg('');
          const name = newName.replace(/\s+/g, ' ').trim();
          if (name.split(' ').length < 2) { setAddErr('Type their first name and surname.'); return; }
          setAdding(true);
          try {
            await createPlayer(name.split(' ').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '), coach?.id);
            setAddMsg(`${name} was added. Find them in the list below.`); setNewName(''); setQ(name);
          } catch (err) { setAddErr(errorText(err)); }
          setAdding(false);
        }}>
          <label className="field"><span>First name and surname</span>
            <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} autoComplete="off" /></label>
          {addErr && <div className="notice err" role="alert">{addErr}</div>}
          {addMsg && <div className="notice ok" role="status">{addMsg}</div>}
          <button className="btn small" disabled={adding}>{adding ? 'Adding' : 'Add player'}</button>
        </form>
      </details>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search players" aria-label="Search players" />
      <div className="seg mt" role="group" aria-label="Filter">
        {([['all', 'All'], ['mine', 'My players'], ['low', '2 or fewer left'], ['monthly', 'Monthly'], ['weekly', 'Pays weekly'], ['casual', 'Casual']] as [Filter, string][]).map(([k, l]) => (
          <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{l} ({counts[k]})</button>
        ))}
      </div>
      {error && <div className="notice err">{error}</div>}
      {loading ? <p className="empty">Loading players</p> : shown.length === 0 ? (
        <p className="empty">No players match. Clear the search or pick another filter.</p>
      ) : (
        <ul className="list mt">
          {shown.map((p) => {
            const cls = creditClass(p);
            return (
              <li key={p.player_id}>
                <Link href={`/players/${p.player_id}`} className="plink">
                  <span>
                    <strong>{p.name}</strong>{' '}
                    {!p.opening_confirmed && p.billing_model === 'package' && <span className="tag amber">Balance to check</span>}
                    {p.opening_confirmed && p.billing_model === 'package' && Number(p.sessions_left ?? 0) <= 0 && <span className="tag red">New package needed</span>}
                    <br />
                    <span className="meta">
                      {p.dob ? `${ageGroup(p.dob)}, ` : ''}{coachName(p.main_coach_id) || 'No main coach'}{p.club ? `, ${p.club}` : ''}
                      {p.last_session ? `, last session ${fmtDate(p.last_session)}` : ''}
                      {p.family ? `, ${p.family} family credits` : ''}
                    </span>
                  </span>
                  {p.billing_model === 'package' ? (
                    <span className="scores">
                      <span className={`score ${cls}`} aria-label={`${num(p.sessions_left)} sessions left`}>{num(p.sessions_left)}<small>sessions</small></span>
                      {p.pairs_left !== null && p.pairs_left !== undefined && (
                        <span className={`score${Number(p.pairs_left) < 0 ? ' out' : ''}`} aria-label={`${num(p.pairs_left)} 2:1 sessions left`}>{num(p.pairs_left)}<small>2:1</small></span>
                      )}
                      <span className="score ga" aria-label={`${num(p.analyses_left)} game analyses left`}>{num(p.analyses_left)}<small>analysis</small></span>
                    </span>
                  ) : <span className="score none">{planTag(p)}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
