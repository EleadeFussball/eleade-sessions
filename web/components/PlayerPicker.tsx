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
};

export function CreditBadge({ p }: { p: PlayerBalance }) {
  if (p.billing_model === 'pay_per_session') return <span className="tag">Pays weekly</span>;
  const cls = creditClass(p);
  return <span className={`tag ${cls === 'out' ? 'red' : cls === 'low' ? 'amber' : 'turf'}`}>{num(p.sessions_left)} left</span>;
}

export function PlayerPicker({ players, selected, max, onChange }: Props) {
  const [q, setQ] = useState('');
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
          {q.trim() && matches.length === 0 && <p className="hint mt">No active player matches “{q.trim()}”. New players are added by Jan.</p>}
        </>
      )}
    </div>
  );
}
