import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { fmt, invokeFn } from '../lib/api';
import { Badge, Empty, Notice } from '../components/ui';
import { useAuth } from '../hooks/useAuth';
import { useSettings } from '../hooks/useSettings';
import type { Template } from '../types';

const bodyOf = (t: Template) => t.components.find((c) => c.type === 'BODY')?.text ?? '';

export default function Templates() {
  const { canEdit, isAdmin } = useAuth();
  const { settings } = useSettings();
  const [rows, setRows] = useState<Template[]>([]);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success' | 'info'; text: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [sample, setSample] = useState({ name: '', language: 'en', body: '' });

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('templates').select('*').order('name');
    if (error) setMsg({ kind: 'error', text: error.message }); else setRows((data ?? []) as Template[]);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function sync() {
    setSyncing(true); setMsg(null);
    try { const r = await invokeFn<{ synced: number }>('sync-templates'); setMsg({ kind: 'success', text: `Synced ${r.synced} templates from Meta.` }); load(); }
    catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
    setSyncing(false);
  }

  async function addSample(e: FormEvent) {
    e.preventDefault();
    const nums = [...sample.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    const { error } = await supabase.from('templates').insert({
      name: sample.name.trim().toLowerCase(), language: sample.language.trim(), category: 'MARKETING', status: 'approved',
      components: [{ type: 'BODY', text: sample.body }], variable_count: nums.length ? Math.max(...nums) : 0, supported: true, source: 'sample',
    });
    if (error) return setMsg({ kind: 'error', text: error.code === '23505' ? 'A template with that name and language exists.' : error.message });
    setSample({ name: '', language: 'en', body: '' }); load();
  }

  async function removeSample(id: string) {
    const { error } = await supabase.from('templates').delete().eq('id', id);
    if (error) setMsg({ kind: 'error', text: error.message.includes('foreign key') ? 'This template is used by a campaign.' : error.message }); else load();
  }

  return (
    <>
      <h1>Templates</h1>
      <p className="sub">Marketing messages can only use templates approved by Meta. Create and submit templates in WhatsApp Manager, then sync them here.</p>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      {canEdit && <div className="toolbar"><button className="btn primary" onClick={sync} disabled={syncing}>{syncing ? 'Syncing…' : 'Sync from Meta'}</button></div>}

      {rows.length === 0 ? <div className="card"><Empty>No templates yet. Sync from Meta, or add a sample template to try test mode.</Empty></div> : (
        <div className="card"><div className="tablewrap"><table className="data">
          <thead><tr><th>Name</th><th>Language</th><th>Category</th><th>Status</th><th>Variables</th><th>Message</th><th></th></tr></thead>
          <tbody>{rows.map((t) => (
            <tr key={t.id}>
              <td>{t.name}{t.source === 'sample' && <div><span className="tag soft">sample</span></div>}</td>
              <td>{t.language}</td><td>{t.category}</td><td><Badge value={t.status} /></td>
              <td>{t.variable_count}{!t.supported && <div className="hint">Not supported here (media, named or button variables)</div>}</td>
              <td style={{ maxWidth: 380, whiteSpace: 'pre-wrap' }}>{bodyOf(t)}<div className="hint">{t.synced_at ? `Synced ${fmt(t.synced_at)}` : ''}</div></td>
              <td>{isAdmin && t.source === 'sample' && <button className="btn ghost small" onClick={() => removeSample(t.id)}>Delete</button>}</td>
            </tr>))}</tbody></table></div></div>
      )}

      {isAdmin && settings?.test_mode && (
        <form className="card" onSubmit={addSample}>
          <h2>Add a sample template (test mode only)</h2>
          <p className="hint">Sample templates are never sent to Meta and cannot be used once test mode is off.</p>
          <div className="row">
            <div><label htmlFor="sn">Name</label><input id="sn" type="text" required pattern="[a-z0-9_]+" value={sample.name} onChange={(e) => setSample({ ...sample, name: e.target.value })} placeholder="diwali_offer" /></div>
            <div><label htmlFor="sl">Language</label><input id="sl" type="text" required value={sample.language} onChange={(e) => setSample({ ...sample, language: e.target.value })} /></div>
          </div>
          <div className="field"><label htmlFor="sb">Message body</label><textarea id="sb" required value={sample.body} onChange={(e) => setSample({ ...sample, body: e.target.value })} placeholder="Hi {{1}}, our Diwali offer is live!" /></div>
          <button className="btn">Add sample</button>
        </form>
      )}
    </>
  );
}
