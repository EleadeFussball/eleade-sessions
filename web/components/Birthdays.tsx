'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { addDays, fmtDate, todayISO } from '@/lib/dates';

type P = { id: string; name: string; dob: string; main_coach_id: string | null };

/** Your week: players whose birthday is today (and the next few days), for every coach. */
export function Birthdays() {
  const [rows, setRows] = useState<P[]>([]);
  useEffect(() => {
    supabase.from('players').select('id, name, dob, main_coach_id').eq('active', true).not('dob', 'is', null)
      .then(({ data }) => setRows((data as P[]) ?? []));
  }, []);
  const today = todayISO();
  const md = (d: string) => d.slice(5, 10);
  const soonDays = [1, 2, 3, 4, 5, 6].map((n) => addDays(today, n));
  const todays = rows.filter((p) => md(p.dob) === md(today));
  const soon = rows.filter((p) => soonDays.some((d) => md(d) === md(p.dob)))
    .map((p) => ({ ...p, on: soonDays.find((d) => md(d) === md(p.dob))! })).sort((a, b) => a.on.localeCompare(b.on));
  if (todays.length === 0 && soon.length === 0) return null;
  const turns = (dob: string, on: string) => Number(on.slice(0, 4)) - Number(dob.slice(0, 4));
  return (
    <section className={`panel mt${todays.length ? ' bday' : ''}`} aria-label="Birthdays">
      {todays.map((p) => (
        <p key={p.id} style={{ margin: '0 0 6px' }}>🎂 <strong><Link href={`/players/${p.id}`}>{p.name}</Link></strong> turns {turns(p.dob, today)} today. Wish them a happy birthday!</p>
      ))}
      {soon.length > 0 && (
        <p className="hint" style={{ margin: 0 }}>Coming up: {soon.map((p) => `${p.name} (${turns(p.dob, p.on)}) ${fmtDate(p.on, true)}`).join(' · ')}</p>
      )}
    </section>
  );
}
