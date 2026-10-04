'use client';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { ScheduleItem } from '@/components/ScheduleItem';
import { addDays, todayISO } from '@/lib/dates';
import { entryKey, loadSchedule, type ScheduleEntry } from '@/lib/schedule';

/** The coach's planned sessions: today's, plus any from the last 7 days not yet confirmed. */
export function PlannedSessions({ onChanged }: { onChanged?: () => void }) {
  const { coach } = useAuth();
  const [items, setItems] = useState<ScheduleEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!coach) return;
    const today = todayISO();
    const all = await loadSchedule(addDays(today, -7), today);
    setItems(all.filter((o) => o.coach_id === coach.id));
    setLoaded(true);
  }, [coach]);
  useEffect(() => { load(); }, [load]);

  const today = todayISO();
  const todays = items.filter((o) => o.session_date === today);
  const overdue = items.filter((o) => o.session_date < today && !o.session_id);
  if (!loaded || (todays.length === 0 && overdue.length === 0)) return null;

  const refresh = () => { load(); onChanged?.(); };
  return (
    <section className="planned" aria-label="Planned sessions">
      <h2 style={{ marginTop: 0 }}>Today</h2>
      {todays.length === 0 ? <p className="empty">Nothing planned for today.</p> : (
        <ul className="list">{todays.map((o) => <ScheduleItem key={entryKey(o)} o={o} onDone={refresh} />)}</ul>
      )}
      {overdue.length > 0 && (
        <>
          <h3 className="mt">Still to confirm</h3>
          <ul className="list">{overdue.map((o) => <ScheduleItem key={entryKey(o)} o={o} onDone={refresh} showDay />)}</ul>
        </>
      )}
    </section>
  );
}
