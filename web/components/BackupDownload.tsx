'use client';
import { useState } from 'react';
import { supabase, errorText } from '@/lib/supabase';

export function BackupDownload() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function run() {
    setBusy(true); setMsg('');
    try {
      const [{ default: ExcelJS }, { buildBackupWorkbook }] = await Promise.all([import('exceljs'), import('@/lib/backup-workbook.mjs')]);
      const fetchTable = async (table: string) => {
        const rows: Record<string, unknown>[] = [];
        for (let from = 0; ; from += 1000) {
          const { data, error } = await supabase.from(table).select('*').range(from, from + 999);
          if (error) throw new Error(`${table}: ${errorText(error)}`);
          rows.push(...((data as Record<string, unknown>[]) ?? []));
          if (!data || data.length < 1000) return rows;
        }
      };
      const stamp = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'full', timeStyle: 'short' });
      const wb = await buildBackupWorkbook(ExcelJS, fetchTable, stamp);
      const buf = await wb.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a');
      a.href = url; a.download = `Eleade backup ${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      setMsg('Downloaded.');
    } catch (e) { setMsg(`Could not build the backup: ${errorText(e)}`); }
    setBusy(false);
  }

  return (
    <>
      <h2>Backup</h2>
      <p className="hint">Every night a copy of all players, sessions, documentation, credits and invoices is saved to Google Drive. Download one now before big changes.</p>
      <button className="btn small ghost" type="button" disabled={busy} onClick={run}>{busy ? 'Building the file...' : 'Download everything (Excel)'}</button>
      {msg && <p className="hint mt">{msg}</p>}
    </>
  );
}
