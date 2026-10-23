import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { downloadCsv, guessColumn, parseCsv, splitTags } from '../lib/csv';
import { normalizePhone } from '../lib/phone';
import { num } from '../lib/api';
import { Notice } from '../components/ui';
import { useAuth } from '../hooks/useAuth';
import { useSettings } from '../hooks/useSettings';

const CHUNK = 1000;
interface Prepared { phone: string; name: string; email: string; tags: string[] }

export default function ImportContacts() {
  const { canEdit } = useAuth();
  const { settings } = useSettings();
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [map, setMap] = useState({ phone: '', name: '', email: '', tags: '' });
  const [consent, setConsent] = useState(false);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{ inserted: number; updated: number; suppressed: number } | null>(null);
  const [error, setError] = useState('');

  async function pick(f: File | null) {
    setFile(f); setResult(null); setError('');
    if (!f) return;
    if (!/\.csv$/i.test(f.name) || f.size > 25 * 1024 * 1024) { setError('Choose a .csv file under 25 MB.'); setFile(null); return; }
    try {
      const p = await parseCsv(f);
      setHeaders(p.headers); setRows(p.rows);
      setMap({
        phone: guessColumn(p.headers, ['phone', 'mobile', 'whatsapp', 'number', 'contact']),
        name: guessColumn(p.headers, ['name']), email: guessColumn(p.headers, ['email', 'mail']), tags: guessColumn(p.headers, ['tag', 'segment', 'group']),
      });
    } catch { setError('That file could not be read as CSV.'); setFile(null); }
  }

  const prepared = useMemo(() => {
    const valid: Prepared[] = [], rejected: Record<string, string>[] = [];
    const seen = new Set<string>();
    let dupes = 0;
    if (!map.phone) return { valid, rejected, dupes };
    for (const r of rows) {
      const phone = normalizePhone(r[map.phone], settings?.default_country ?? 'IN');
      if (!phone) { rejected.push({ ...r, _reason: 'Invalid phone number' }); continue; }
      if (seen.has(phone)) { dupes++; rejected.push({ ...r, _reason: 'Duplicate in file' }); continue; }
      seen.add(phone);
      valid.push({ phone, name: map.name ? (r[map.name] ?? '').trim() : '', email: map.email ? (r[map.email] ?? '').trim() : '', tags: map.tags ? splitTags(r[map.tags] ?? '') : [] });
    }
    return { valid, rejected, dupes };
  }, [rows, map, settings?.default_country]);

  async function run() {
    setError(''); setBusy(true); setProgress(0);
    try {
      const { data: batch, error: be } = await supabase.from('import_batches').insert({
        filename: file?.name, consent_source: consent ? source.trim() : null, consent_confirmed: consent, total_rows: rows.length,
      }).select('id').single();
      if (be) throw be;
      const total = { inserted: 0, updated: 0, suppressed: 0 };
      for (let i = 0; i < prepared.valid.length; i += CHUNK) {
        const { data, error } = await supabase.rpc('import_contacts', {
          p_rows: prepared.valid.slice(i, i + CHUNK), p_consent_source: source.trim(), p_consent_confirmed: consent, p_batch_id: batch.id,
        });
        if (error) throw error;
        total.inserted += data.inserted; total.updated += data.updated; total.suppressed += data.suppressed;
        setProgress(Math.min(100, Math.round(((i + CHUNK) / prepared.valid.length) * 100)));
      }
      await supabase.from('import_batches').update({ inserted: total.inserted, updated: total.updated, rejected: prepared.rejected.length }).eq('id', batch.id);
      setResult(total);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  if (!canEdit) return <Notice kind="warn">Your role cannot import contacts.</Notice>;
  const ready = prepared.valid.length > 0 && !busy && (!consent || source.trim().length > 2);

  return (
    <>
      <h1>Import contacts</h1>
      <p className="sub">Upload a CSV with a phone column. Numbers are validated, converted to international format and de-duplicated against the file and your existing contacts. Unsubscribed numbers stay unsubscribed.</p>
      {error && <Notice kind="error">{error}</Notice>}
      {result && <Notice kind="success">Done. {num(result.inserted)} new, {num(result.updated)} existing updated, {num(result.suppressed)} on the unsubscribe list. <Link to="/contacts">View contacts</Link></Notice>}

      <div className="card">
        <div className="field"><label htmlFor="f">CSV file</label><input id="f" type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0] ?? null)} /></div>
        {file && (
          <>
            <div className="row">
              {(['phone', 'name', 'email', 'tags'] as const).map((k) => (
                <div key={k}><label htmlFor={`m-${k}`}>{k === 'phone' ? 'Phone column (required)' : `${k[0].toUpperCase()}${k.slice(1)} column`}</label>
                  <select id={`m-${k}`} value={map[k]} onChange={(e) => setMap({ ...map, [k]: e.target.value })}>
                    <option value="">{k === 'phone' ? 'Select…' : 'None'}</option>{headers.map((h) => <option key={h}>{h}</option>)}</select></div>
              ))}
            </div>
            <div className="grid">
              <div className="kpi"><div className="v">{num(rows.length)}</div><div className="l">Rows in file</div></div>
              <div className="kpi accent"><div className="v">{num(prepared.valid.length)}</div><div className="l">Ready to import</div></div>
              <div className="kpi"><div className="v">{num(prepared.rejected.length - prepared.dupes)}</div><div className="l">Invalid numbers</div></div>
              <div className="kpi"><div className="v">{num(prepared.dupes)}</div><div className="l">Duplicates in file</div></div>
            </div>
            {prepared.rejected.length > 0 && <button className="btn ghost" onClick={() => downloadCsv('rejected-rows.csv', prepared.rejected)}>Download rejected rows</button>}
          </>
        )}
      </div>

      {file && (
        <div className="card">
          <h2>Consent</h2>
          <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            I confirm everyone in this file agreed to receive WhatsApp marketing messages from Aixoniq Technologies.</label>
          <p className="hint">Without this box, contacts are imported with no consent and cannot be included in campaigns.</p>
          {consent && <div className="field"><label htmlFor="src">How and when was consent collected?</label>
            <input id="src" type="text" value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. Website signup form, Jan–Oct 2026" /></div>}
          {busy && <div className="bar" aria-label="Import progress"><i style={{ width: `${progress}%` }} /></div>}
          <button className="btn primary" disabled={!ready} onClick={run} style={{ marginTop: '.75rem' }}>{busy ? `Importing… ${progress}%` : `Import ${num(prepared.valid.length)} contacts`}</button>
        </div>
      )}
    </>
  );
}
