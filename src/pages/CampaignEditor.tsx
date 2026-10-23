import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { num } from '../lib/api';
import { splitTags } from '../lib/csv';
import { Notice } from '../components/ui';
import { useAuth } from '../hooks/useAuth';
import { useSettings } from '../hooks/useSettings';
import type { Template, VarMap } from '../types';

const SAMPLE = { name: 'Aarav', email: 'aarav@example.com' };

export default function CampaignEditor() {
  const { canEdit } = useAuth();
  const { settings } = useSettings();
  const nav = useNavigate();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [mapping, setMapping] = useState<VarMap[]>([]);
  const [tags, setTags] = useState('');
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  const [audience, setAudience] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.from('templates').select('*').eq('status', 'approved').eq('supported', true).order('name')
      .then(({ data }) => setTemplates((data ?? []) as Template[]));
  }, []);
  const usable = templates.filter((t) => settings?.test_mode || t.source === 'meta');
  const tpl = usable.find((t) => t.id === templateId);

  useEffect(() => {
    if (!tpl) return setMapping([]);
    setMapping(Array.from({ length: tpl.variable_count }, (): VarMap => ({ source: 'name', fallback: 'there' })));
  }, [tpl?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const tagList = useMemo(() => splitTags(tags), [tags]);
  useEffect(() => {
    const t = setTimeout(async () => {
      const { data } = await supabase.rpc('audience_count', { p_tags: tagList });
      setAudience(typeof data === 'number' ? data : null);
    }, 300);
    return () => clearTimeout(t);
  }, [tagList]);

  const body = tpl?.components.find((c) => c.type === 'BODY')?.text ?? '';
  const preview = body.replace(/\{\{(\d+)\}\}/g, (_m, n) => {
    const v = mapping[Number(n) - 1];
    return !v ? '' : v.source === 'name' ? SAMPLE.name : v.source === 'email' ? SAMPLE.email : v.value || '…';
  });

  function setVar(i: number, patch: Partial<VarMap>) { setMapping(mapping.map((m, j) => (j === i ? { ...m, ...patch } : m))); }

  async function save(launch: boolean) {
    setError('');
    if (!name.trim()) return setError('Give the campaign a name.');
    if (!tpl) return setError('Choose an approved template.');
    if (mapping.some((m) => m.source === 'static' && !m.value?.trim())) return setError('Fill in every fixed-text variable.');
    let scheduled: string | null = null;
    if (when === 'later') {
      const d = new Date(at);
      if (!at || isNaN(d.getTime()) || d.getTime() < Date.now() + 60_000) return setError('Pick a schedule time at least a minute in the future.');
      scheduled = d.toISOString();
    }
    if (launch && !confirm(`${settings?.test_mode ? 'TEST MODE: messages will be simulated.\n\n' : 'LIVE: real WhatsApp messages will be sent.\n\n'}Launch "${name}" to about ${num(audience)} contacts${scheduled ? ' at the scheduled time' : ' now'}?`)) return;
    setBusy(true);
    const { data, error: e } = await supabase.from('campaigns').insert({
      name: name.trim(), template_id: tpl.id, audience_tags: tagList, variable_mapping: mapping, scheduled_at: scheduled,
    }).select('id').single();
    if (e) { setBusy(false); return setError(e.message); }
    if (launch) {
      const r = await supabase.rpc('launch_campaign', { p_campaign_id: data.id });
      if (r.error) { setBusy(false); setError(`Saved as draft, but could not launch: ${r.error.message}`); return; }
    }
    nav(`/campaigns/${data.id}`);
  }

  if (!canEdit) return <Notice kind="warn">Your role cannot create campaigns.</Notice>;

  return (
    <>
      <h1>New campaign</h1>
      <p className="sub">Only active contacts with recorded consent who are not on the unsubscribe list are included.</p>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="card">
        <div className="row">
          <div><label htmlFor="n">Campaign name</label><input id="n" type="text" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div><label htmlFor="t">Template</label>
            <select id="t" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Select an approved template…</option>
              {usable.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.language}){t.source === 'sample' ? ' – sample' : ''}</option>)}</select></div>
        </div>
        {usable.length === 0 && <p className="hint">No usable templates. Sync from Meta on the Templates page.</p>}
        {tpl && mapping.length > 0 && (
          <div className="field"><label>Fill the template variables</label>
            {mapping.map((m, i) => (
              <div className="row" key={i}>
                <span className="tag">{`{{${i + 1}}}`}</span>
                <select aria-label={`Variable ${i + 1} source`} value={m.source} onChange={(e) => setVar(i, { source: e.target.value as VarMap['source'] })}>
                  <option value="name">Contact name</option><option value="email">Contact email</option><option value="static">Fixed text</option></select>
                {m.source === 'static' && <input type="text" aria-label={`Variable ${i + 1} text`} value={m.value ?? ''} onChange={(e) => setVar(i, { value: e.target.value })} placeholder="Text for everyone" />}
                <input type="text" aria-label={`Variable ${i + 1} fallback`} value={m.fallback ?? ''} onChange={(e) => setVar(i, { fallback: e.target.value })} placeholder="Fallback if empty" />
              </div>))}
            <p className="hint">Contacts missing a value and a fallback are skipped, because Meta rejects empty variables.</p>
          </div>)}
        {tpl && <div className="field"><label>Preview</label><div className="preview">{preview}</div></div>}
      </div>
      <div className="card">
        <div className="row">
          <div><label htmlFor="tg">Audience tags (optional)</label><input id="tg" type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Leave empty for all opted-in contacts" />
            <div className="hint">{audience === null ? '' : `${num(audience)} eligible contacts`}</div></div>
          <div><label htmlFor="w">When</label><select id="w" value={when} onChange={(e) => setWhen(e.target.value as 'now' | 'later')}>
            <option value="now">Start sending now</option><option value="later">Schedule</option></select></div>
          {when === 'later' && <div><label htmlFor="at">Send at (your local time)</label><input id="at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></div>}
        </div>
        <p className="hint">Sending is paced at up to {settings?.max_per_minute ?? 30} messages per minute and {num(settings?.daily_cap ?? 250)} per 24 hours. Large audiences take several days if your Meta tier is small.</p>
      </div>
      <div className="toolbar">
        <button className="btn ghost" disabled={busy} onClick={() => save(false)}>Save draft</button>
        <button className="btn primary" disabled={busy} onClick={() => save(true)}>{when === 'later' ? 'Schedule campaign' : 'Launch campaign'}</button>
      </div>
    </>
  );
}
