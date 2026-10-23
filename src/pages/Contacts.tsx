import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { fmt, num } from '../lib/api';
import { normalizePhone } from '../lib/phone';
import { splitTags } from '../lib/csv';
import { Badge, Empty, Notice, Pager } from '../components/ui';
import { useAuth } from '../hooks/useAuth';
import { useSettings } from '../hooks/useSettings';
import type { Contact } from '../types';

const PAGE = 50;

export default function Contacts() {
  const { canEdit, isAdmin } = useAuth();
  const { settings } = useSettings();
  const [rows, setRows] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');
  const [consent, setConsent] = useState('');
  const [tag, setTag] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ phone: '', name: '', email: '', tags: '', consent: false, source: '' });

  useEffect(() => { const t = setTimeout(() => { setDebounced(q); setPage(0); }, 300); return () => clearTimeout(t); }, [q]);

  const load = useCallback(async () => {
    let query = supabase.from('contacts').select('*', { count: 'exact' })
      .order('created_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
    const s = debounced.replace(/[%,()"\\*]/g, '').trim();
    if (s) query = query.or(`name.ilike.%${s}%,phone_e164.ilike.%${s}%,email.ilike.%${s}%`);
    if (status) query = query.eq('status', status);
    if (consent) query = query.eq('consent_status', consent);
    if (tag.trim()) query = query.contains('tags', [tag.trim().toLowerCase()]);
    const { data, count, error } = await query;
    if (error) setMsg({ kind: 'error', text: error.message });
    else { setRows((data ?? []) as Contact[]); setTotal(count ?? 0); }
  }, [page, debounced, status, consent, tag]);
  useEffect(() => { load(); }, [load]);

  async function add(e: FormEvent) {
    e.preventDefault(); setMsg(null);
    const phone = normalizePhone(form.phone, settings?.default_country ?? 'IN');
    if (!phone) return setMsg({ kind: 'error', text: 'That phone number is not valid.' });
    if (form.consent && !form.source.trim()) return setMsg({ kind: 'error', text: 'Describe how consent was obtained.' });
    const { data: supp } = await supabase.from('suppressions').select('phone_e164').eq('phone_e164', phone).maybeSingle();
    if (supp && form.consent) return setMsg({ kind: 'error', text: 'This number has unsubscribed and cannot be given consent here.' });
    const { error } = await supabase.from('contacts').insert({
      phone_e164: phone, name: form.name.trim() || null, email: form.email.trim().toLowerCase() || null,
      tags: splitTags(form.tags), status: supp ? 'unsubscribed' : 'active',
      consent_status: form.consent ? 'granted' : 'none', consent_at: form.consent ? new Date().toISOString() : null,
      consent_source: form.consent ? form.source.trim() : null,
    });
    if (error) return setMsg({ kind: 'error', text: error.code === '23505' ? 'A contact with this number already exists.' : error.message });
    setMsg({ kind: 'success', text: 'Contact added.' }); setAdding(false);
    setForm({ phone: '', name: '', email: '', tags: '', consent: false, source: '' }); load();
  }

  async function unsubscribe(c: Contact) {
    if (!confirm(`Add ${c.phone_e164} to the unsubscribe list? They will never be messaged until an admin removes them.`)) return;
    const { error } = await supabase.from('suppressions').insert({ phone_e164: c.phone_e164, reason: 'manual', source: 'dashboard' });
    if (error && error.code !== '23505') setMsg({ kind: 'error', text: error.message }); else load();
  }
  async function remove(c: Contact) {
    if (!confirm(`Delete ${c.phone_e164}? Their unsubscribe record (if any) is kept.`)) return;
    const { error } = await supabase.from('contacts').delete().eq('id', c.id);
    if (error) setMsg({ kind: 'error', text: error.message }); else load();
  }

  return (
    <>
      <h1>Contacts</h1>
      <p className="sub">{num(total)} contacts match. Only active contacts with recorded consent are ever messaged.</p>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <div className="toolbar">
        <input type="search" placeholder="Search name, phone or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search contacts" />
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }} aria-label="Status">
          <option value="">All statuses</option><option value="active">Active</option><option value="unsubscribed">Unsubscribed</option></select>
        <select value={consent} onChange={(e) => { setConsent(e.target.value); setPage(0); }} aria-label="Consent">
          <option value="">Any consent</option><option value="granted">Consent granted</option><option value="none">No consent</option></select>
        <input type="search" placeholder="Tag" value={tag} onChange={(e) => { setTag(e.target.value); setPage(0); }} aria-label="Tag" />
        {canEdit && <><button className="btn primary" onClick={() => setAdding(!adding)}>Add contact</button>
          <Link className="btn ghost" to="/import" style={{ textDecoration: 'none' }}>Import CSV</Link></>}
      </div>

      {adding && (
        <form className="card" onSubmit={add}>
          <div className="row">
            <div><label htmlFor="cp">Phone</label><input id="cp" type="text" required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+91 98765 43210" /></div>
            <div><label htmlFor="cn">Name</label><input id="cn" type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><label htmlFor="ce">Email</label><input id="ce" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
            <div><label htmlFor="ct">Tags</label><input id="ct" type="text" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="comma separated" /></div>
          </div>
          <label className="check"><input type="checkbox" checked={form.consent} onChange={(e) => setForm({ ...form, consent: e.target.checked })} />
            This person agreed to receive WhatsApp marketing messages from us.</label>
          {form.consent && <div className="field" style={{ marginTop: '.6rem' }}><label htmlFor="cs">How and when did they consent?</label>
            <input id="cs" type="text" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} placeholder="e.g. Website signup form, 12 Oct 2026" /></div>}
          <button className="btn primary">Save contact</button>
        </form>
      )}

      <div className="card"><div className="tablewrap">
        {rows.length === 0 ? <Empty>No contacts found. Import a CSV or add one to get started.</Empty> : (
          <table className="data">
            <thead><tr><th>Phone</th><th>Name</th><th>Email</th><th>Tags</th><th>Status</th><th>Consent</th><th>Added</th>{canEdit && <th></th>}</tr></thead>
            <tbody>{rows.map((c) => (
              <tr key={c.id}>
                <td>{c.phone_e164}</td><td>{c.name ?? '—'}</td><td>{c.email ?? '—'}</td>
                <td>{c.tags.map((t) => <span className="tag soft" key={t}>{t}</span>)}</td>
                <td><Badge value={c.status} /></td>
                <td><Badge value={c.consent_status} />{c.consent_source && <div className="hint">{c.consent_source}</div>}</td>
                <td>{fmt(c.created_at)}</td>
                {canEdit && <td style={{ whiteSpace: 'nowrap' }}>
                  {c.status === 'active' && <button className="btn ghost small" onClick={() => unsubscribe(c)}>Unsubscribe</button>}{' '}
                  {isAdmin && <button className="btn ghost small" onClick={() => remove(c)}>Delete</button>}</td>}
              </tr>))}
            </tbody>
          </table>)}
      </div>
        <Pager page={page} pageSize={PAGE} total={total} onChange={setPage} /></div>
    </>
  );
}
