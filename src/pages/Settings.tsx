import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { invokeFn } from '../lib/api';
import { normalizePhone } from '../lib/phone';
import { Badge, Notice } from '../components/ui';
import { useAuth } from '../hooks/useAuth';
import { useSettings } from '../hooks/useSettings';
import type { Settings as S, Template } from '../types';

interface Status { test_mode: boolean; secrets: Record<string, boolean>; settings: { waba_id: boolean; phone_number_id: boolean } }

export default function Settings() {
  const { isAdmin } = useAuth();
  const { settings, reload } = useSettings();
  const [f, setF] = useState<S | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success' | 'info'; text: string } | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [t, setT] = useState({ id: '', to: '', params: '', own: false });

  useEffect(() => { if (settings) setF(settings); }, [settings]);
  useEffect(() => {
    if (!isAdmin) return;
    invokeFn<Status>('send-test-message', { action: 'status' }).then(setStatus).catch((e) => setMsg({ kind: 'error', text: `Could not check server secrets: ${e.message}` }));
    supabase.from('templates').select('*').eq('status', 'approved').then(({ data }) => setTemplates((data ?? []) as Template[]));
  }, [isAdmin]);

  if (!f) return <Notice>Loading…</Notice>;
  const set = <K extends keyof S>(k: K, v: S[K]) => setF({ ...f, [k]: v });

  async function save(e: FormEvent) {
    e.preventDefault(); setMsg(null);
    if (!f) return;
    if (settings?.test_mode && !f.test_mode && !confirm('Turn OFF test mode? Campaigns will send real WhatsApp messages that Meta bills you for.')) return;
    const { error } = await supabase.from('business_settings').update({
      business_name: f.business_name.trim(), support_email: f.support_email?.trim() || null,
      waba_id: f.waba_id?.trim() || null, phone_number_id: f.phone_number_id?.trim() || null,
      api_version: f.api_version.trim(), test_mode: f.test_mode, daily_cap: Number(f.daily_cap),
      max_per_minute: Number(f.max_per_minute), default_country: f.default_country.trim().toUpperCase(),
    }).eq('id', 1);
    if (error) setMsg({ kind: 'error', text: error.message }); else { setMsg({ kind: 'success', text: 'Settings saved.' }); reload(); }
  }

  async function sendTest(e: FormEvent) {
    e.preventDefault(); setMsg(null);
    const to = normalizePhone(t.to, f?.default_country ?? 'IN');
    if (!to) return setMsg({ kind: 'error', text: 'Enter a valid phone number.' });
    try {
      const r = await invokeFn<{ simulated: boolean; message?: string; wa_message_id?: string }>('send-test-message', {
        action: 'send', template_id: t.id, to, params: t.params.split('|').map((p) => p.trim()).filter(Boolean), confirm_own_number: t.own,
      });
      setMsg({ kind: 'success', text: r.simulated ? r.message ?? 'Simulated.' : `Sent. Meta message id: ${r.wa_message_id}` });
    } catch (err) { setMsg({ kind: 'error', text: (err as Error).message }); }
  }

  const ro = !isAdmin;
  return (
    <>
      <h1>Settings</h1>
      <p className="sub">Business details and WhatsApp configuration. Access tokens are never stored here; they live in server-side secrets.</p>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      {ro && <Notice kind="info">Only administrators can change settings.</Notice>}

      <form className="card" onSubmit={save}>
        <h2>Business</h2>
        <div className="row">
          <div><label htmlFor="bn">Business name</label><input id="bn" type="text" required disabled={ro} value={f.business_name} onChange={(e) => set('business_name', e.target.value)} /></div>
          <div><label htmlFor="se">Support email</label><input id="se" type="email" disabled={ro} value={f.support_email ?? ''} onChange={(e) => set('support_email', e.target.value)} /></div>
          <div><label htmlFor="dc">Default country (ISO code)</label><input id="dc" type="text" maxLength={2} disabled={ro} value={f.default_country} onChange={(e) => set('default_country', e.target.value)} /></div>
        </div>
        <h2>WhatsApp Cloud API</h2>
        <div className="row">
          <div><label htmlFor="wa">WhatsApp Business Account ID</label><input id="wa" type="text" inputMode="numeric" disabled={ro} value={f.waba_id ?? ''} onChange={(e) => set('waba_id', e.target.value)} /></div>
          <div><label htmlFor="pn">Phone number ID</label><input id="pn" type="text" inputMode="numeric" disabled={ro} value={f.phone_number_id ?? ''} onChange={(e) => set('phone_number_id', e.target.value)} /></div>
          <div><label htmlFor="av">Graph API version</label><input id="av" type="text" disabled={ro} value={f.api_version} onChange={(e) => set('api_version', e.target.value)} />
            <div className="hint">Meta retires old versions. Check developers.facebook.com for the current one.</div></div>
        </div>
        <h2>Sending limits</h2>
        <div className="row">
          <div><label htmlFor="cap">Max messages per 24 hours</label><input id="cap" type="number" min={1} disabled={ro} value={f.daily_cap} onChange={(e) => set('daily_cap', Number(e.target.value))} />
            <div className="hint">Set this at or below your current Meta messaging tier.</div></div>
          <div><label htmlFor="mpm">Max messages per minute</label><input id="mpm" type="number" min={1} max={300} disabled={ro} value={f.max_per_minute} onChange={(e) => set('max_per_minute', Number(e.target.value))} /></div>
        </div>
        <label className="check"><input type="checkbox" disabled={ro} checked={f.test_mode} onChange={(e) => set('test_mode', e.target.checked)} />
          Test mode: simulate sending. No messages go to Meta.</label>
        {!ro && <button className="btn primary" style={{ marginTop: '1rem' }}>Save settings</button>}
      </form>

      {isAdmin && status && (
        <div className="card">
          <h2>Server configuration</h2>
          <p className="hint">Shows whether each secret exists on the server. Values are never displayed.</p>
          <table className="data"><tbody>
            {Object.entries(status.secrets).map(([k, v]) => <tr key={k}><td>{k}</td><td><Badge value={v ? 'active' : 'failed'} /> {v ? 'set' : 'missing'}</td></tr>)}
            <tr><td>WABA ID / Phone number ID</td><td>{status.settings.waba_id && status.settings.phone_number_id ? 'Saved' : 'Not saved yet'}</td></tr>
          </tbody></table>
        </div>
      )}

      {isAdmin && (
        <form className="card" onSubmit={sendTest}>
          <h2>Send one test message</h2>
          <p className="hint">{f.test_mode ? 'Test mode is on, so this only simulates a send.' : 'Live mode: this sends a real message to one number. Use your own or a consenting tester.'}</p>
          <div className="row">
            <div><label htmlFor="tt">Template</label><select id="tt" required value={t.id} onChange={(e) => setT({ ...t, id: e.target.value })}>
              <option value="">Select…</option>{templates.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.language}, {x.variable_count} vars)</option>)}</select></div>
            <div><label htmlFor="to">Phone</label><input id="to" type="text" required value={t.to} onChange={(e) => setT({ ...t, to: e.target.value })} /></div>
            <div><label htmlFor="pp">Variables (separate with |)</label><input id="pp" type="text" value={t.params} onChange={(e) => setT({ ...t, params: e.target.value })} placeholder="Aarav | 20% off" /></div>
          </div>
          <label className="check"><input type="checkbox" checked={t.own} onChange={(e) => setT({ ...t, own: e.target.checked })} />This number belongs to me or someone who agreed to receive a test.</label>
          <button className="btn" style={{ marginTop: '.75rem' }} disabled={!t.own}>Send test</button>
        </form>
      )}
    </>
  );
}
