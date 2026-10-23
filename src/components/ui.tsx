import type { ReactNode } from 'react';

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'error' | 'success' | 'warn'; children: ReactNode }) {
  return <div className={`notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

const TONES: Record<string, string> = {
  active: 'good', granted: 'good', approved: 'good', delivered: 'good', read: 'good', completed: 'good', sent: 'info',
  running: 'info', scheduled: 'info', queued: 'muted', sending: 'info', draft: 'muted', paused: 'warn',
  pending: 'warn', needs_review: 'warn', none: 'muted', skipped: 'muted', cancelled: 'muted',
  failed: 'bad', unsubscribed: 'bad', rejected: 'bad', disabled: 'bad',
};
export function Badge({ value }: { value: string }) {
  return <span className={`badge ${TONES[value] ?? 'muted'}`}>{value.replace('_', ' ')}</span>;
}

export function Pager({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pager">
      <button className="btn ghost" disabled={page <= 0} onClick={() => onChange(page - 1)}>Previous</button>
      <span>Page {page + 1} of {pages}</span>
      <button className="btn ghost" disabled={page + 1 >= pages} onClick={() => onChange(page + 1)}>Next</button>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
