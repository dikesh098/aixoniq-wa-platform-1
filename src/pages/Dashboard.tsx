import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { fmt, num, pct } from '../lib/api';
import { Badge, Empty, Notice } from '../components/ui';
import { useSettings } from '../hooks/useSettings';

interface Daily { day: string; sent: number; delivered: number; read_n: number; failed: number }
interface Stats {
  contacts_total: number; contacts_sendable: number; suppressed_total: number; campaigns_total: number;
  campaigns_active: number; sent_last_24h: number; daily: Daily[];
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [recent, setRecent] = useState<{ id: string; name: string; status: string; total_recipients: number; created_at: string }[]>([]);
  const [error, setError] = useState('');
  const { settings } = useSettings();

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.rpc('dashboard_stats', { p_days: 30 });
      if (error) setError(error.message); else setStats(data as Stats);
      const r = await supabase.from('campaigns').select('id,name,status,total_recipients,created_at').order('created_at', { ascending: false }).limit(5);
      setRecent(r.data ?? []);
    })();
  }, []);

  const daily = stats?.daily ?? [];
  const sum = (k: keyof Omit<Daily, 'day'>) => daily.reduce((a, d) => a + Number(d[k]), 0);
  const sent = sum('sent'), delivered = sum('delivered'), read = sum('read_n'), failed = sum('failed');
  const maxDay = Math.max(1, ...daily.map((d) => Number(d.sent)));
  const cap = settings?.daily_cap ?? 0;

  return (
    <>
      <h1>Dashboard</h1>
      <p className="sub">Campaign and delivery activity for the last 30 days.</p>
      {error && <Notice kind="error">{error}</Notice>}
      {!stats && !error && <Notice>Loading…</Notice>}
      {stats && (
        <>
          <div className="grid">
            <div className="kpi accent"><div className="v">{num(stats.contacts_sendable)}</div><div className="l">Contacts you can message</div></div>
            <div className="kpi"><div className="v">{num(stats.contacts_total)}</div><div className="l">Total contacts</div></div>
            <div className="kpi"><div className="v">{num(stats.suppressed_total)}</div><div className="l">Unsubscribed</div></div>
            <div className="kpi"><div className="v">{num(stats.campaigns_active)}</div><div className="l">Active campaigns ({num(stats.campaigns_total)} total)</div></div>
          </div>
          <div className="grid">
            <div className="kpi"><div className="v">{num(sent)}</div><div className="l">Sent</div></div>
            <div className="kpi"><div className="v">{pct(delivered, sent)}</div><div className="l">Delivered ({num(delivered)})</div></div>
            <div className="kpi"><div className="v">{pct(read, delivered)}</div><div className="l">Read of delivered ({num(read)})</div></div>
            <div className="kpi"><div className="v">{num(failed)}</div><div className="l">Failed</div></div>
          </div>

          <div className="two">
            <div className="card">
              <h2>Delivery funnel</h2>
              {[['Sent', sent], ['Delivered', delivered], ['Read', read], ['Failed', failed]].map(([l, v]) => (
                <div className="funnel" key={l as string}>
                  <span>{l}</span>
                  <div className="bar"><i style={{ width: `${sent ? Math.min(100, (Number(v) / sent) * 100) : 0}%` }} /></div>
                  <span>{num(Number(v))}</span>
                </div>
              ))}
              {settings && !settings.test_mode && (
                <p className="hint">Last 24 hours: {num(stats.sent_last_24h)} of your {num(cap)} daily cap used. Meta sets your real limit; keep this at or below your messaging tier.</p>
              )}
            </div>
            <div className="card">
              <h2>Recent campaigns</h2>
              {recent.length === 0 ? <Empty>No campaigns yet. <Link to="/campaigns/new">Create one</Link>.</Empty> : (
                <table className="data"><tbody>
                  {recent.map((c) => (
                    <tr key={c.id}><td><Link to={`/campaigns/${c.id}`}>{c.name}</Link><div className="hint">{fmt(c.created_at)}</div></td>
                      <td>{num(c.total_recipients)}</td><td><Badge value={c.status} /></td></tr>
                  ))}
                </tbody></table>
              )}
            </div>
          </div>

          <div className="card" style={{ marginTop: '1rem' }}>
            <h2>Daily activity</h2>
            {daily.length === 0 ? <Empty>No messages yet.</Empty> : (
              <div className="tablewrap"><table className="data">
                <thead><tr><th>Day</th><th>Sent</th><th></th><th>Delivered</th><th>Read</th><th>Failed</th></tr></thead>
                <tbody>
                  {[...daily].reverse().slice(0, 14).map((d) => (
                    <tr key={d.day}><td>{d.day}</td><td>{num(d.sent)}</td>
                      <td style={{ width: '30%' }}><div className="bar navy"><i style={{ width: `${(Number(d.sent) / maxDay) * 100}%` }} /></div></td>
                      <td>{num(d.delivered)}</td><td>{num(d.read_n)}</td><td>{num(d.failed)}</td></tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </div>
        </>
      )}
    </>
  );
}
