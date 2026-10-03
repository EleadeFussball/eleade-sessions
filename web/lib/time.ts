/** '630' -> '06:30', '6.30' -> '06:30', '1800' -> '18:00', '7' -> '07:00'. Empty or invalid -> ''. */
export function normaliseTime(raw: string): string {
  const t = raw.trim().replace(/[.,h ]/g, ':');
  if (!t) return '';
  let h: number, m: number;
  const parts = t.split(':').filter(Boolean);
  if (parts.length === 2) { h = Number(parts[0]); m = Number(parts[1]); }
  else if (/^\d{1,2}$/.test(t)) { h = Number(t); m = 0; }
  else if (/^\d{3,4}$/.test(t)) { h = Number(t.slice(0, t.length - 2)); m = Number(t.slice(-2)); }
  else return '';
  if (!Number.isInteger(h) || !Number.isInteger(m) || h > 23 || m > 59 || h < 0 || m < 0) return '';
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
