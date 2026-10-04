import { supabase } from '@/lib/supabase';
import type { Format, Outcome } from '@/lib/types';

/** One planned session: a weekly regular one, or a one-off booking. */
export type ScheduleEntry = {
  kind: 'regular' | 'once' | 'logged';
  ref_id: string;
  plan_date: string | null;
  session_date: string;
  start_time: string | null;
  minutes: number;
  coach_id: string;
  format: Format;
  location: string | null;
  note: string | null;
  player_ids: string[] | null;
  players: string | null;
  moved: boolean;
  session_id: string | null;
  outcome: Outcome | null;
};

export const hhmm = (t: string | null) => (t ? t.slice(0, 5) : '');

/** "16:30 – 17:30" */
export function timeRange(t: string | null, minutes: number): string {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const end = h * 60 + m + minutes;
  return `${hhmm(t)} – ${String(Math.floor(end / 60) % 24).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
}
export const entryKey = (o: ScheduleEntry) => `${o.kind}-${o.ref_id}-${o.plan_date ?? o.session_date}`;

export async function loadSchedule(from: string, to: string): Promise<ScheduleEntry[]> {
  const { data } = await supabase.rpc('calendar', { p_from: from, p_to: to });
  return (data as ScheduleEntry[]) ?? [];
}

export function confirmEntry(o: ScheduleEntry, outcome: Outcome, notes: { topic?: string; obs?: string; improve?: string; method?: '' | 'cash' | 'stripe' }) {
  const payment = notes.method && outcome !== 'cancelled_in_time' ? notes.method : null;
  return o.kind === 'regular'
    ? supabase.rpc('confirm_plan_session', {
        p_plan_id: o.ref_id, p_plan_date: o.plan_date, p_outcome: outcome,
        p_topic: outcome === 'attended' ? notes.topic ?? null : null,
        p_observations: notes.obs ?? null,
        p_improve: outcome === 'attended' ? notes.improve ?? null : null,
        p_payment_method: payment,
      })
    : supabase.rpc('confirm_booking', {
        p_booking_id: o.ref_id, p_outcome: outcome,
        p_topic: outcome === 'attended' ? notes.topic ?? null : null,
        p_observations: notes.obs ?? null,
        p_improve: outcome === 'attended' ? notes.improve ?? null : null,
        p_payment_method: payment,
      });
}

export function moveEntry(o: ScheduleEntry, date: string, time: string, minutes?: number) {
  return supabase.rpc('reschedule', {
    p_kind: o.kind, p_ref_id: o.ref_id, p_plan_date: o.plan_date,
    p_new_date: date, p_new_time: time, p_minutes: minutes ?? null,
  });
}

/** Minutes since midnight, for placing a session on the grid. */
export const minutesOf = (t: string | null) => {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

export const timeOf = (mins: number) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

export function cancelEntry(o: ScheduleEntry) {
  return supabase.rpc('cancel_booking', { p_booking_id: o.ref_id });
}

/** Date and minutes since midnight in Sydney, whatever the phone's own clock zone is. */
export function sydneyNow(): { date: string; mins: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const g = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  return { date: `${g('year')}-${g('month')}-${g('day')}`, mins: (Number(g('hour')) % 24) * 60 + Number(g('minute')) };
}

/** The time from which a session can be marked as completed: five minutes after it ends. */
export function completeFrom(o: Pick<ScheduleEntry, 'start_time' | 'minutes'>): string {
  const s = minutesOf(o.start_time);
  return s === null ? '' : timeOf((s + o.minutes + 5) % 1440);
}

/** A planned session can be marked completed once it is over (Jan any time on or after the day). */
export function canComplete(o: ScheduleEntry, isAdmin: boolean): boolean {
  if (o.session_id || o.kind === 'logged') return false;
  const now = sydneyNow();
  if (o.session_date > now.date) return false;
  if (isAdmin || !o.start_time || o.session_date < now.date) return true;
  return now.mins >= (minutesOf(o.start_time) ?? 0) + o.minutes + 5;
}

/** Where this player was last coached, or an empty string. */
export async function lastLocation(playerId: string): Promise<string> {
  const { data } = await supabase.rpc('last_location', { p_player_id: playerId });
  return typeof data === 'string' ? data : '';
}
