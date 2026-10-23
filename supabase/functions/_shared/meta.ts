// Thin client for the official WhatsApp Business Cloud API (Meta Graph API).
// The access token is read from Edge Function secrets and never leaves the server.

export interface MetaConfig { token: string; apiVersion: string; phoneNumberId: string; wabaId: string }

export type SendResult =
  | { ok: true; waMessageId: string }
  | { ok: false; kind: 'retryable' | 'permanent' | 'ambiguous' | 'fatal'; code?: string; message: string };

// Meta error codes. Verify against the current Cloud API error-code docs when upgrading API versions.
const RETRYABLE = new Set([1, 2, 4, 17, 32, 613, 80007, 130429, 131000, 131016, 131056]);
const FATAL = new Set([0, 10, 190, 200, 368]); // auth / permission / account problems
export function metaToken(): string | null { return Deno.env.get('META_ACCESS_TOKEN') ?? null; }

function classify(status: number, err: { code?: number; message?: string } | undefined) {
  const code = err?.code;
  if (code !== undefined && FATAL.has(code) || status === 401) return 'fatal' as const;
  if (status === 429 || (code !== undefined && RETRYABLE.has(code))) return 'retryable' as const;
  if (status >= 500) return err ? ('retryable' as const) : ('ambiguous' as const);
  return 'permanent' as const;
}

export async function sendTemplate(
  cfg: MetaConfig, toDigits: string, name: string, language: string, params: string[],
): Promise<SendResult> {
  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    to: toDigits,
    type: 'template',
    template: {
      name,
      language: { code: language },
      ...(params.length
        ? { components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] }
        : {}),
    },
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    // No response: Meta may or may not have accepted it. Never auto-retry (could duplicate).
    return { ok: false, kind: 'ambiguous', message: `No response from Meta (${(e as Error).name}). Outcome unknown.` };
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }

  if (res.ok) {
    const id = parsed?.messages?.[0]?.id;
    if (typeof id === 'string') return { ok: true, waMessageId: id };
    return { ok: false, kind: 'ambiguous', message: 'Meta returned success without a message id.' };
  }
  const err = parsed?.error;
  return {
    ok: false,
    kind: classify(res.status, err),
    code: err?.code !== undefined ? String(err.code) : String(res.status),
    message: String(err?.error_data?.details ?? err?.message ?? `HTTP ${res.status}`).slice(0, 500),
  };
}

export interface MetaTemplate {
  id: string; name: string; language: string; status: string; category: string; components: any[];
}

export async function listTemplates(cfg: MetaConfig): Promise<MetaTemplate[]> {
  const out: MetaTemplate[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const url = new URL(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.wabaId}/message_templates`);
    url.searchParams.set('fields', 'id,name,language,status,category,components');
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.token}` } });
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(j?.error?.message ?? `Meta returned HTTP ${res.status}`);
    out.push(...(j.data ?? []));
    after = j.paging?.cursors?.after;
    if (!j.paging?.next || !after) break;
  }
  return out;
}

export async function verifySignature(rawBody: string, header: string | null, appSecret: string): Promise<boolean> {
  if (!header?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const given = header.slice(7);
  if (given.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}
