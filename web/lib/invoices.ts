import { supabase } from '@/lib/supabase';
import { addDays, fromISO } from '@/lib/dates';
import { sydneyNow } from '@/lib/schedule';
import type { CoachInvoice } from '@/lib/types';

/** Sunday of the invoice's week: coaches can change the invoice until 8pm that day (Sydney). */
export function editDeadline(i: Pick<CoachInvoice, 'period_end'>): string {
  const dow = (fromISO(i.period_end).getDay() + 6) % 7; // 0 = Monday
  return addDays(i.period_end, 6 - dow);
}

export function invoiceEditable(i: Pick<CoachInvoice, 'period_end' | 'status'>, isAdmin: boolean): boolean {
  if (i.status === 'paid') return false;
  if (isAdmin) return true;
  const now = sydneyNow();
  const sun = editDeadline(i);
  return now.date < sun || (now.date === sun && now.mins < 20 * 60);
}

/** Rebuild the invoice from the logged sessions. Returns the invoice id, or null when nothing is left and it was withdrawn. */
export async function updateInvoice(id: string) {
  const { data, error } = await supabase.rpc('update_invoice', { p_invoice_id: id });
  return { id: (data as string | null) ?? null, error };
}
