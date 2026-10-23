export type Role = 'admin' | 'editor' | 'viewer';

export interface Contact {
  id: string; phone_e164: string; name: string | null; email: string | null; tags: string[];
  status: 'active' | 'unsubscribed'; consent_status: 'granted' | 'none';
  consent_at: string | null; consent_source: string | null; created_at: string;
}
export interface Template {
  id: string; name: string; language: string; category: string; status: string;
  components: { type: string; text?: string }[]; variable_count: number; supported: boolean;
  source: 'meta' | 'sample'; synced_at: string | null;
}
export interface VarMap { source: 'name' | 'email' | 'static'; value?: string; fallback?: string }
export interface Campaign {
  id: string; name: string; template_id: string; status: string; scheduled_at: string | null;
  audience_tags: string[]; variable_mapping: VarMap[]; total_recipients: number;
  created_at: string; launched_at: string | null; completed_at: string | null;
}
export interface CampaignStats {
  campaign_id: string; total: number; queued: number; sending: number; sent: number; delivered: number;
  read_n: number; failed: number; skipped: number; needs_review: number;
}
export interface MessageRow {
  id: string; phone_e164: string; status: string; attempts: number; error_code: string | null;
  error_message: string | null; skip_reason: string | null; is_simulated: boolean;
  sent_at: string | null; delivered_at: string | null; read_at: string | null; next_attempt_at: string;
}
export interface Settings {
  business_name: string; support_email: string | null; waba_id: string | null; phone_number_id: string | null;
  api_version: string; test_mode: boolean; daily_cap: number; max_per_minute: number; default_country: string;
}
