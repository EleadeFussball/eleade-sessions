'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import { usePlayers, creditClass } from '@/lib/usePlayers';
import { fmtDate, num } from '@/lib/dates';

type Filter = 'all' | 'mine' | 'low' | 'weekly';

export default function PlayersPage() {
  const { coach, coaches } = useAuth();
  const { players, loading, error } = usePlayers();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const coachName = (id: string | null) => coaches.find((c) => c.id === id)?.name ?? '';

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return players.filter((p) => {
      if (s && !p.name.toLowerCase().includes(s)) return false;
      if (filter === 'mine') return p.main_coach_id === coach?.id;
      if (filter === 'low') return p.billing_model === 'package' && Number(p.sessions_left ?? 0) <= 2;
      if (filter === 'weekly') return p.billing_model === 'pay_per_session';
      return true;
    });
  }, [players, q, filter, coach]);

  const counts = {
    all: players.length,
    mine: players.filter((p) => p.main_coach_id === coach?.id).length,
    low: players.filter((p) => p.billing_model === 'package' && Number(p.sessions_left ?? 0) <= 2).length,
    weekly: players.filter((p) => p.billing_model === 'pay_per_session').length,
  };

  return (
    <>
      <h1>Players</h1>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search players" aria-label="Search players" />
      <div className="seg mt" role="group" aria-label="Filter">
        {([['all', 'All'], ['mine', 'My players'], ['low', '2 or fewer left'], ['weekly', 'Pays weekly']] as [Filter, string][]).map(([k, l]) => (
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
                    {!p.opening_confirmed && p.billing_model === 'package' && <span className="tag amber">Balance to confirm</span>}
                    <br />
                    <span className="meta">
                      {coachName(p.main_coach_id) || 'No main coach'}
                      {p.last_session ? `, last session ${fmtDate(p.last_session)}` : ''}
                      {p.family ? `, ${p.family} family credits` : ''}
                    </span>
                  </span>
                  {p.billing_model === 'package'
                    ? <span className={`score ${cls}`} aria-label={`${num(p.sessions_left)} sessions left`}>{num(p.sessions_left)}</span>
                    : <span className="score none">Pays weekly</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
