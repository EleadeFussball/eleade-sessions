import { todayISO } from './dates';

/** Junior football age group: the age the player turns in the season year (born 2014 = U12 in 2026). */
export function ageGroup(dob: string | null | undefined, year = Number(todayISO().slice(0, 4))): string {
  if (!dob) return '';
  const n = year - Number(dob.slice(0, 4));
  if (!(n > 0)) return '';
  return n >= 21 ? 'Senior' : `U${n}`;
}

/** "U12" during the season; from October also next season's group, e.g. "U12 · U13 in 2027". */
export function ageGroupLabel(dob: string | null | undefined): string {
  const g = ageGroup(dob);
  if (!g) return '';
  const [y, m] = todayISO().split('-').map(Number);
  const next = ageGroup(dob, y + 1);
  return m >= 10 && next !== g ? `${g} · ${next} in ${y + 1}` : g;
}

export function ageYears(dob: string | null | undefined): number | null {
  if (!dob) return null;
  const t = todayISO();
  let a = Number(t.slice(0, 4)) - Number(dob.slice(0, 4));
  if (t.slice(5) < dob.slice(5, 10)) a -= 1;
  return a;
}
