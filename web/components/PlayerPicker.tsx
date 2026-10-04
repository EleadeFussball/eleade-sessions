'use client';
import { useMemo, useState } from 'react';
import type { PlayerBalance } from '@/lib/types';
import { num } from '@/lib/dates';
import { creditClass } from '@/lib/usePlayers';

type Props = {
  players: PlayerBalance[];
  selected: string[];
  max: number;
  onChange: (ids: string[]) => void;
  onCreate?: (name: string) => Promise<void>;
};

export function CreditBadge({ p }: { p: PlayerBalance }) {
  if (p.billing_model === 'pay_per_session') return <span className="tag">Pays weekly</span>;
  if (!p.last_session && !p.last_purchase && Number(p.sessions_left ?? 0) === 0) return <span className="tag">New</span>;
  const cls = creditClass(p);
  return <span className={`tag ${cls === 'out' ? 'red' : cls === 'low' ? 'amber' : 'turf'}`}>{num(p.sessions_left)} left</span>;
}

export function PlayerPicker({ players, selected, max, onChange, onCreate }: Props) {
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const chosen = selected.map((id) => players.find((p) => p.player_id === id)).filter(Boolean) as PlayerBalance[];
  const full = selected.length >= max;

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return players
      .filter((p) => !selected.includes(p.player_id))
      .filter((p) => p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(s)) || p.name.toLowerCase().includes(s))
      .slice(0, 8);
  }, [q, players, selected]);

  return (
    <div className="picker">
      {chosen.length > 0 && (
        <div className="chips">
          {chosen.map((p) => (
            <span className="chip" key={p.player_id}>
              {p.name} <CreditBadge p={p} />
              <button type="button" aria-label={`Remove ${p.name}`} onClick={() => onChange(selected.filter((x) => x !== p.player_id))}>×</button>
            </span>
          ))}
        </div>
      )}
      {!full && (
        <>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off"
                 placeholder={chosen.length ? 'Add another player' : 'Type a player name'} aria-label="Search players" />
          {matches.length > 0 && (
            <ul className="results">
              {matches.map((p) => (
                <li key={p.player_id}>
                  <button type="button" onClick={() => {
                    onChange(max === 1 ? [p.player_id] : [...selected, p.player_id]);
                    setQ('');
                  }}>
                    <span>{p.name}</span>
                    <CreditBadge p={p} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {q.trim() && matches.length === 0 && (
            onCreate ? (
              <div className="newplayer">
                <p className="hint" style={{ marginBottom: 8 }}>
                  No player called “{q.trim()}” yet.
                  {q.trim().split(/\s+/).length < 2 && ' Add their surname too, so nobody is mixed up.'}
                </p>
                <button type="button" className="btn small" disabled={adding || q.trim().split(/\s+/).length < 2}
                        onClick={async () => { setAdding(true); await onCreate(titleCase(q.trim())); setAdding(false); setQ(''); }}>
                  {adding ? 'Adding' : `+ Add ${titleCase(q.trim())} as a new player`}
                </button>
              </div>
            ) : <p className="hint mt">No active player matches “{q.trim()}”.</p>
          )}
        </>
      )}
    </div>
  );
}

function titleCase(s: string): string {
  return s.replace(/\s+/g, ' ').split(' ').map((w) => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}
