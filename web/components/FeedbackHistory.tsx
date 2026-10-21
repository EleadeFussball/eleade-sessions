'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { periodLabel } from '@/components/FeedbackDue';

type F = { id: string; period_start: string; period_end: string; progress: string | null; focus: string | null; homework: string | null; sent_at: string | null };

/** Player page: the feedback written every two months. */
export function FeedbackHistory({ playerId }: { playerId: string }) {
  const [rows, setRows] = useState<F[]>([]);
  useEffect(() => {
    supabase.from('player_feedback').select('id, period_start, period_end, progress, focus, homework, sent_at')
      .eq('player_id', playerId).order('period_start', { ascending: false }).then(({ data }) => setRows((data as F[]) ?? []));
  }, [playerId]);
  if (rows.length === 0) return null;
  return (
    <section className="mt">
      <h2>Feedback</h2>
      {rows.map((f) => (
        <details key={f.id} className="panel" open={f === rows[0]}>
          <summary>{periodLabel(f.period_start, f.period_end)} {f.sent_at ? <span className="tag turf">Sent</span> : <span className="tag amber">Not sent yet</span>}</summary>
          {f.progress && <><h4>✅ Progress</h4><p style={{ whiteSpace: 'pre-wrap' }}>{f.progress}</p></>}
          {f.focus && <><h4>🎯 Focus</h4><p style={{ whiteSpace: 'pre-wrap' }}>{f.focus}</p></>}
          {f.homework && <><h4>🏠 Homework</h4><p style={{ whiteSpace: 'pre-wrap' }}>{f.homework}</p></>}
        </details>
      ))}
    </section>
  );
}
