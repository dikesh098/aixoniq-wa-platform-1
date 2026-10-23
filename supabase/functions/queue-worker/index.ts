// Called every minute by pg_cron. Claims a small, throttled batch and sends it.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { admin, json, loadSettings, timingSafeEqual } from '../_shared/common.ts';
import { metaToken, sendTemplate, type MetaConfig } from '../_shared/meta.ts';

const MAX_ATTEMPTS = 5;
const BACKOFF_MINUTES = [2, 10, 30, 120];
const CONCURRENCY = 5;
const RUN_BUDGET_MS = 45_000;

interface VarMap { source: 'name' | 'email' | 'static'; value?: string; fallback?: string }
interface Claimed {
  message_id: string; campaign_id: string; contact_id: string | null; phone_e164: string; attempts: number;
  template_name: string; template_language: string; template_source: string; variable_mapping: VarMap[];
  contact_name: string | null; contact_email: string | null; contact_status: string | null;
  consent_status: string | null; suppressed: boolean;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

function buildParams(map: VarMap[], r: Claimed): string[] | null {
  const out: string[] = [];
  for (const v of map) {
    let val = v.source === 'name' ? r.contact_name ?? '' : v.source === 'email' ? r.contact_email ?? '' : v.value ?? '';
    val = clean(val);
    if (!val) val = clean(v.fallback ?? '');
    if (!val) return null; // Meta rejects empty parameters
    out.push(val.slice(0, 1000));
  }
  return out;
}

async function setMsg(db: SupabaseClient, id: string, patch: Record<string, unknown>) {
  const { error } = await db.from('messages')
    .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).eq('status', 'sending');
  if (error) console.error('Failed to update message', id, error.message); // stays 'sending' -> flagged for review
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const secret = Deno.env.get('WORKER_SECRET');
  if (!secret || !timingSafeEqual(req.headers.get('x-worker-secret') ?? '', secret)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const db = admin();
  const settings = await loadSettings(db);
  const token = metaToken();
  const live = !settings.test_mode;
  if (live && (!token || !settings.phone_number_id)) {
    return json({ processed: 0, note: 'Live mode requires META_ACCESS_TOKEN and a phone number ID.' });
  }
  const cfg: MetaConfig = {
    token: token ?? '', apiVersion: settings.api_version,
    phoneNumberId: settings.phone_number_id ?? '', wabaId: settings.waba_id ?? '',
  };

  // Daily cap (rolling 24h, counted separately for test and live messages).
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { count: used } = await db.from('messages').select('id', { count: 'exact', head: true })
    .gte('sent_at', since).eq('is_simulated', settings.test_mode);
  const remaining = settings.daily_cap - (used ?? 0);
  const limit = Math.min(settings.max_per_minute, remaining);
  if (limit <= 0) return json({ processed: 0, note: 'Daily cap reached; queue is paused until capacity frees up.' });

  const { data, error } = await db.rpc('claim_messages', { p_limit: limit });
  if (error) { console.error(error); return json({ error: 'Claim failed' }, 500); }
  const rows = (data ?? []) as Claimed[];

  const deadline = Date.now() + RUN_BUDGET_MS;
  const done = new Set<string>();
  const tally: Record<string, number> = {};
  const bump = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };
  let abort = false;
  let idx = 0;

  async function processOne(r: Claimed) {
    // Compliance re-check at send time.
    if (r.suppressed || r.contact_status !== 'active' || r.consent_status !== 'granted') {
      await setMsg(db, r.message_id, { status: 'skipped', skip_reason: r.suppressed ? 'unsubscribed' : 'no_consent' });
      return bump('skipped');
    }
    const params = buildParams(r.variable_mapping, r);
    if (!params) {
      await setMsg(db, r.message_id, { status: 'skipped', skip_reason: 'missing_variable' });
      return bump('skipped');
    }
    const now = new Date().toISOString();

    if (settings.test_mode) {
      // Simulation only. Nothing is sent to Meta; rows are flagged is_simulated.
      await setMsg(db, r.message_id, {
        status: 'delivered', is_simulated: true, wa_message_id: `sim_${r.message_id}`,
        sent_at: now, delivered_at: now, error_code: null, error_message: null,
      });
      return bump('simulated');
    }
    if (r.template_source !== 'meta') {
      await setMsg(db, r.message_id, {
        status: 'failed', failed_at: now, error_code: 'SAMPLE_TEMPLATE', error_message: 'Sample templates cannot be sent in live mode.',
      });
      return bump('failed');
    }

    const res = await sendTemplate(cfg, r.phone_e164.replace('+', ''), r.template_name, r.template_language, params);
    if (res.ok) {
      await setMsg(db, r.message_id, { status: 'sent', wa_message_id: res.waMessageId, sent_at: now, error_code: null, error_message: null });
      return bump('sent');
    }
    const err = { error_code: res.code ?? null, error_message: res.message };
    switch (res.kind) {
      case 'permanent':
        await setMsg(db, r.message_id, { status: 'failed', failed_at: now, ...err });
        return bump('failed');
      case 'ambiguous':
        await setMsg(db, r.message_id, { status: 'needs_review', ...err });
        return bump('needs_review');
      case 'fatal':
        // Credentials/permission problem: put it back untouched and stop this run.
        abort = true;
        console.error('Fatal Meta error, check token and permissions:', res.code, res.message);
        await setMsg(db, r.message_id, {
          status: 'queued', attempts: Math.max(r.attempts - 1, 0),
          next_attempt_at: new Date(Date.now() + 15 * 60_000).toISOString(), ...err,
        });
        return bump('fatal');
      case 'retryable': {
        if (r.attempts >= MAX_ATTEMPTS) {
          await setMsg(db, r.message_id, { status: 'failed', failed_at: now, ...err, error_message: `Gave up after ${r.attempts} attempts: ${res.message}` });
          return bump('failed');
        }
        const mins = BACKOFF_MINUTES[Math.min(r.attempts - 1, BACKOFF_MINUTES.length - 1)];
        await setMsg(db, r.message_id, { status: 'queued', next_attempt_at: new Date(Date.now() + mins * 60_000).toISOString(), ...err });
        return bump('retry_scheduled');
      }
    }
  }

  async function loop() {
    while (!abort && Date.now() < deadline) {
      const i = idx++;
      if (i >= rows.length) return;
      try { await processOne(rows[i]); } catch (e) { console.error('processOne error', e); }
      done.add(rows[i].message_id);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, loop));

  // Anything claimed but untouched (time budget or abort) goes back to the queue unchanged.
  for (const r of rows) {
    if (!done.has(r.message_id)) {
      await db.from('messages').update({ status: 'queued', claimed_at: null, attempts: Math.max(r.attempts - 1, 0) })
        .eq('id', r.message_id).eq('status', 'sending');
      bump('released');
    }
  }
  return json({ claimed: rows.length, mode: settings.test_mode ? 'test' : 'live', ...tally });
});
