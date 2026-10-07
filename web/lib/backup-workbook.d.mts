export function buildBackupWorkbook(
  ExcelJS: any,
  fetchTable: (table: string) => Promise<Record<string, unknown>[]>,
  stamp: string,
): Promise<{ xlsx: { writeBuffer(): Promise<ArrayBuffer> } }>;
