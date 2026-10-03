// All dates are plain local calendar dates (YYYY-MM-DD). Coaches are in Sydney.

export function todayISO(): string {
  const d = new Date();
  return toISO(d);
}

export function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function fromISO(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s: string, n: number): string {
  const d = fromISO(s);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

/** Monday of the week containing s. */
export function weekStart(s: string): string {
  const d = fromISO(s);
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - dow);
  return toISO(d);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function fmtDate(s: string | null, withDay = false): string {
  if (!s) return '';
  const d = fromISO(s.slice(0, 10));
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const year = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '';
  return (withDay ? `${DAYS[d.getDay()]} ` : '') + base + year;
}

export function fmtWeek(start: string): string {
  return `${fmtDate(start)} to ${fmtDate(addDays(start, 6))}`;
}

export function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function num(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  const v = Number(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}
