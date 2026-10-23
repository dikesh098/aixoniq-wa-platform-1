import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { fmt, num } from '../lib/api';
import { normalizePhone } from '../lib/phone';
import { Badge, Empty, Notice, Pager } from '../components/ui';
import { useAuth } from '../hooks/useAuth';
import { useSettings } from '../hooks/useSettings';

const PAGE = 50;
interface Row { phone_e164: string; reason: string; source: string | null; created_at: string }

export default function Unsubscribes() {
  const { canEdit, isAdmin } = useAuth();
  const { settings } = useSettings();
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [phone, setPhone] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const load = useCallback(async () => {
    const { data, count, error } = await supabase.from('suppressions').select('*', { count: 'exact' })
      .order('created_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) setMsg({ kind: 'error', text: error.message }); else { setRows((data ?? []) as Row[]); setTotal(count ?? 0); }
  }, [page]);
  useEffect(() => { load(); }, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    const p = normalizePhone(phone, settings?.default_country ?? 'IN');
    if (!p) return setMsg({ kind: 'error', text: 'That phone number is not valid.' });
    const { error } = await supabase.from('suppressions').insert({ phone_e164: p, reason: 'manual', source: 'dashboard' });
    if (error) return setMsg({ kind: 'error', text: error.code === '23505' ? 'Already on the list.' : error.message });
    setPhone(''); setMsg({ kind: 'success', text: 'Added. Any queued messages to this number were cancelled.' }); load();
  }
  async function remove(p: string) {
    if (!confirm(`Remove ${p}? Their consent will be cleared and they cannot be messaged until new consent is recorded.`)) return;
    const { error } = await supabase.from('suppressions').delete().eq('phone_e164', p);
    if (error) setMsg({ kind: 'error', text: error.message }); else load();
  }

  return (
    <>
      <h1>Unsubscribes</h1>
      <p className="sub">{num(total)} numbers will never be messaged. People who reply STOP on WhatsApp are added automatically once the webhook is connected.</p>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      {canEdit && (
        <form className="card row" onSubmit={add}>
          <div><label htmlFor="up">Add a number</label><input id="up" type="text" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" /></div>
          <button className="btn primary" style={{ alignSelf: 'flex-end' }}>Add to list</button>
        </form>
      )}
      <div className="card"><div className="tablewrap">
        {rows.length === 0 ? <Empty>No unsubscribes yet.</Empty> : (
          <table className="data"><thead><tr><th>Phone</th><th>Reason</th><th>Source</th><th>Date</th>{isAdmin && <th></th>}</tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.phone_e164}><td>{r.phone_e164}</td><td><Badge value={r.reason} /></td><td>{r.source ?? '—'}</td><td>{fmt(r.created_at)}</td>
                {isAdmin && <td><button className="btn ghost small" onClick={() => remove(r.phone_e164)}>Remove</button></td>}</tr>))}
            </tbody></table>)}
      </div><Pager page={page} pageSize={PAGE} total={total} onChange={setPage} /></div>
    </>
  );
}
