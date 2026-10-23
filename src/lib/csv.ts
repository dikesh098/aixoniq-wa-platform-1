import Papa from 'papaparse';

export function parseCsv(file: File): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.trim(),
      complete: (r) => resolve({ headers: r.meta.fields ?? [], rows: r.data }),
      error: (e) => reject(e),
    });
  });
}

export function guessColumn(headers: string[], hints: string[]): string {
  const lower = headers.map((h) => h.toLowerCase());
  for (const hint of hints) {
    const i = lower.findIndex((h) => h.includes(hint));
    if (i >= 0) return headers[i];
  }
  return '';
}

export function downloadCsv(filename: string, rows: object[]) {
  const blob = new Blob([Papa.unparse(rows)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export const splitTags = (s: string) => s.split(/[,;|]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
