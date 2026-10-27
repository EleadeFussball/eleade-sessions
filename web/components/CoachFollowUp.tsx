'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { todayISO } from '@/lib/dates';
import { useAdminTask } from '@/components/AdminFold';

type Row = { id: string; name: string; docs: number; videos: number };

/** Jan: each coach's sessions without notes and overdue training videos. */
export function CoachFollowUp() {
  const { coaches } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    const active = coaches.filter((c) => c.active);
    Promise.all(active.map(async (c) => {
      const [d, v] = await Promise.all([
        supabase.rpc('undocumented_sessions', { p_coach_id: c.id }),
        supabase.rpc('videos_due', { p_coach_id: c.id }),
      ]);
      const today = todayISO();
      return { id: c.id, name: c.name, docs: (d.data as unknown[] ?? []).length,
        videos: ((v.data as { due_on: string }[]) ?? []).filter((x) => x.due_on <= today).length };
    })).then(setRows);
  }, [coaches]);
  useAdminTask('followup', 'fold-followup', 'Coach follow-up: notes and videos overdue', rows.reduce((t, r) => t + r.docs + r.videos, 0), 50);
  if (rows.length === 0) return null;
  return (
    <section>
      <h2>Coach follow-up</h2>
      <table className="t">
        <thead><tr><th>Coach</th><th className="n">Sessions without notes</th><th className="n">Videos due</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}><td>{r.name}</td>
            <td className="n">{r.docs ? <span className="tag amber">{r.docs}</span> : '0'}</td>
            <td className="n">{r.videos ? <span className="tag amber">{r.videos}</span> : '0'}</td></tr>
        ))}</tbody>
      </table>
    </section>
  );
}
