import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { fmt, num, pct } from '../lib/api';
import { Badge, Empty, Notice } from '../components/ui';
import { useAuth } from '../hooks/useAuth';
import type { Campaign, CampaignStats } from '../types';

export default function Campaigns() {
  const { canEdit } = useAuth();
  const [rows, setRows] = useState<Campaign[]>([]);
  const [stats, setStats] = useState<Record<string, CampaignStats>>({});
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from('campaigns').select('*').order('created_at', { ascending: false }).limit(200);
      if (error) return setError(error.message);
      const list = (data ?? []) as Campaign[];
      setRows(list);
      if (list.length) {
        const s = await supabase.from('campaign_stats').select('*').in('campaign_id', list.map((c) => c.id));
        setStats(Object.fromEntries(((s.data ?? []) as CampaignStats[]).map((x) => [x.campaign_id, x])));
      }
    })();
  }, []);

  return (
    <>
      <h1>Campaigns</h1>
      <p className="sub">Each campaign sends one approved template to opted-in contacts through the throttled queue.</p>
      {error && <Notice kind="error">{error}</Notice>}
      {canEdit && <div className="toolbar"><Link className="btn primary" to="/campaigns/new" style={{ textDecoration: 'none' }}>New campaign</Link></div>}
      <div className="card"><div className="tablewrap">
        {rows.length === 0 ? <Empty>No campaigns yet.</Empty> : (
          <table className="data"><thead><tr><th>Name</th><th>Status</th><th>Recipients</th><th>Delivered</th><th>Read</th><th>Failed</th><th>Created</th></tr></thead>
            <tbody>{rows.map((c) => { const s = stats[c.id]; return (
              <tr key={c.id}><td><Link to={`/campaigns/${c.id}`}>{c.name}</Link>{c.scheduled_at && <div className="hint">Scheduled {fmt(c.scheduled_at)}</div>}</td>
                <td><Badge value={c.status} /></td><td>{num(c.total_recipients)}</td>
                <td>{s ? pct(s.delivered, s.sent) : '—'}</td><td>{s ? pct(s.read_n, s.delivered) : '—'}</td><td>{s ? num(s.failed) : '—'}</td><td>{fmt(c.created_at)}</td></tr>); })}
            </tbody></table>)}
      </div></div>
    </>
  );
}
