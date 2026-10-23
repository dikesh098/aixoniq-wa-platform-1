import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { fmt, num, pct } from '../lib/api';
import { Badge, Empty, Notice, Pager } from '../components/ui';
import { useAuth } from '../hooks/useAuth';
import type { Campaign, CampaignStats, MessageRow } from '../types';

const PAGE = 50;

export default function CampaignDetail() {
  const { id } = useParams();
  const { canEdit } = useAuth();
  const [c, setC] = useState<Campaign | null>(null);
  const [s, setS] = useState<CampaignStats | null>(null);
  const [rows, setRows] = useState<MessageRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const load = useCallback(async () => {
    const camp = await supabase.from('campaigns').select('*').eq('id', id).maybeSingle();
    if (camp.error || !camp.data) return setMsg({ kind: 'error', text: camp.error?.message ?? 'Campaign not found.' });
    setC(camp.data as Campaign);
    const st = await supabase.from('campaign_stats').select('*').eq('campaign_id', id).maybeSingle();
    setS((st.data as CampaignStats) ?? null);
    let q = supabase.from('messages').select('id,phone_e164,status,attempts,error_code,error_message,skip_reason,is_simulated,sent_at,delivered_at,read_at,next_attempt_at', { count: 'exact' })
      .eq('campaign_id', id).order('created_at').range(page * PAGE, page * PAGE + PAGE - 1);
    if (filter) q = q.eq('status', filter);
    const m = await q;
    setRows((m.data ?? []) as MessageRow[]); setTotal(m.count ?? 0);
  }, [id, page, filter]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!c || !['running', 'scheduled'].includes(c.status)) return;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [c, load]);

  async function act(fn: string, args: Record<string, unknown>, ok: string, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    const { error } = await supabase.rpc(fn, args);
    if (error) setMsg({ kind: 'error', text: error.message }); else { setMsg({ kind: 'success', text: ok }); load(); }
  }

  if (!c) return msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : <Notice>Loading…</Notice>;
  const sent = s?.sent ?? 0;

  return (
    <>
      <h1>{c.name} <Badge value={c.status} /></h1>
      <p className="sub">{c.scheduled_at ? `Scheduled for ${fmt(c.scheduled_at)}. ` : ''}Created {fmt(c.created_at)}.</p>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      {canEdit && (
        <div className="toolbar">
          {c.status === 'draft' && <button className="btn primary" onClick={() => act('launch_campaign', { p_campaign_id: c.id }, 'Campaign launched.', 'Launch this campaign now?')}>Launch</button>}
          {['running', 'scheduled'].includes(c.status) && <button className="btn ghost" onClick={() => act('set_campaign_status', { p_id: c.id, p_status: 'paused' }, 'Paused.')}>Pause</button>}
          {c.status === 'paused' && <button className="btn primary" onClick={() => act('set_campaign_status', { p_id: c.id, p_status: 'running' }, 'Resumed.')}>Resume</button>}
          {['running', 'scheduled', 'paused'].includes(c.status) && <button className="btn danger" onClick={() => act('set_campaign_status', { p_id: c.id, p_status: 'cancelled' }, 'Cancelled. Queued messages were skipped.', 'Cancel this campaign? Messages not yet sent will be skipped permanently.')}>Cancel</button>}
        </div>
      )}
      <div className="grid">
        <div className="kpi accent"><div className="v">{num(c.total_recipients)}</div><div className="l">Recipients</div></div>
        <div className="kpi"><div className="v">{num(s?.queued)}</div><div className="l">Waiting in queue</div></div>
        <div className="kpi"><div className="v">{num(sent)}</div><div className="l">Sent</div></div>
        <div className="kpi"><div className="v">{pct(s?.delivered ?? 0, sent)}</div><div className="l">Delivered ({num(s?.delivered)})</div></div>
        <div className="kpi"><div className="v">{pct(s?.read_n ?? 0, s?.delivered ?? 0)}</div><div className="l">Read ({num(s?.read_n)})</div></div>
        <div className="kpi"><div className="v">{num(s?.failed)}</div><div className="l">Failed</div></div>
        <div className="kpi"><div className="v">{num(s?.skipped)}</div><div className="l">Skipped</div></div>
        <div className="kpi"><div className="v">{num(s?.needs_review)}</div><div className="l">Needs review</div></div>
      </div>
      {(s?.needs_review ?? 0) > 0 && <Notice kind="warn">Some messages have an unknown outcome (no response from Meta). They are never resent automatically, because that could message someone twice. Check the recipient or your WhatsApp Manager logs, then requeue if appropriate.</Notice>}

      <div className="card">
        <div className="toolbar"><h2 style={{ margin: 0, flex: '1 1 auto' }}>Messages</h2>
          <select value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); }} aria-label="Filter by status">
            <option value="">All statuses</option>
            {['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped', 'needs_review'].map((x) => <option key={x} value={x}>{x.replace('_', ' ')}</option>)}</select></div>
        <div className="tablewrap">{rows.length === 0 ? <Empty>No messages.</Empty> : (
          <table className="data"><thead><tr><th>Phone</th><th>Status</th><th>Attempts</th><th>Sent</th><th>Delivered</th><th>Read</th><th>Details</th>{canEdit && <th></th>}</tr></thead>
            <tbody>{rows.map((m) => (
              <tr key={m.id}><td>{m.phone_e164}</td>
                <td><Badge value={m.status} />{m.is_simulated && <div><span className="tag soft">simulated</span></div>}</td>
                <td>{m.attempts}</td><td>{fmt(m.sent_at)}</td><td>{fmt(m.delivered_at)}</td><td>{fmt(m.read_at)}</td>
                <td style={{ maxWidth: 320 }}>{m.error_code && <strong>{m.error_code}: </strong>}{m.error_message ?? m.skip_reason ?? ''}
                  {m.status === 'queued' && m.attempts > 0 && <div className="hint">Retry at {fmt(m.next_attempt_at)}</div>}</td>
                {canEdit && <td>{['failed', 'needs_review'].includes(m.status) && <button className="btn ghost small" onClick={() => act('requeue_message', { p_id: m.id }, 'Requeued.', 'Requeue this message? If Meta already accepted it, the person may receive it twice.')}>Requeue</button>}</td>}</tr>))}
            </tbody></table>)}</div>
        <Pager page={page} pageSize={PAGE} total={total} onChange={setPage} />
      </div>
    </>
  );
}
