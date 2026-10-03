// Australian bank details: ABN check and the ABA (Cemtex) payment file that NAB Internet Banking imports.

export function validAbn(raw: string): boolean {
  const d = raw.replace(/\s/g, '');
  if (!/^\d{11}$/.test(d)) return false;
  const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const sum = d.split('').reduce((t, c, i) => t + (Number(c) - (i === 0 ? 1 : 0)) * w[i], 0);
  return sum % 89 === 0;
}

export const digits = (s: string) => s.replace(/\D/g, '');
export const fmtBsb = (b: string) => (b.length === 6 ? `${b.slice(0, 3)}-${b.slice(3)}` : b);
export const fmtAbn = (a: string) => (a.length === 11 ? `${a.slice(0, 2)} ${a.slice(2, 5)} ${a.slice(5, 8)} ${a.slice(8)}` : a);

const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9 &'\-./]/g, ' ');
const left = (s: string, n: number) => clean(s).slice(0, n).padEnd(n, ' ');
const right = (s: string, n: number, fill = ' ') => s.slice(-n).padStart(n, fill);
const cents = (n: number, w = 10) => right(String(Math.round(n * 100)), w, '0');

export type AbaPayer = { bsb: string; account_number: string; account_name: string; user_id_number: string; remitter_name: string };
export type AbaPayment = { bsb: string; account_number: string; account_name: string; amount: number; reference: string };

/** One credit line per payment, no balancing line (what NAB Internet Banking expects). */
export function buildAba(payer: AbaPayer, pays: AbaPayment[], processDate: Date, description = 'COACH PAY'): string {
  const dd = String(processDate.getDate()).padStart(2, '0');
  const mm = String(processDate.getMonth() + 1).padStart(2, '0');
  const yy = String(processDate.getFullYear()).slice(-2);
  const lines: string[] = [];
  lines.push('0' + ' '.repeat(17) + '01' + 'NAB' + ' '.repeat(7) + left(payer.account_name, 26) +
    right(payer.user_id_number, 6, '0') + left(description, 12) + dd + mm + yy + ' '.repeat(40));
  let total = 0;
  for (const p of pays) {
    total += Math.round(p.amount * 100);
    lines.push('1' + fmtBsb(p.bsb) + right(p.account_number, 9) + ' ' + '50' + cents(p.amount) +
      left(p.account_name, 32) + left(p.reference, 18) + fmtBsb(payer.bsb) + right(payer.account_number, 9) +
      left(payer.remitter_name, 16) + '00000000');
  }
  const t = right(String(total), 10, '0');
  lines.push('7' + '999-999' + ' '.repeat(12) + t + t + '0'.repeat(10) + ' '.repeat(24) +
    right(String(pays.length), 6, '0') + ' '.repeat(40));
  if (lines.some((l) => l.length !== 120)) throw new Error('Bank file line has the wrong length');
  return lines.join('\r\n') + '\r\n';
}
