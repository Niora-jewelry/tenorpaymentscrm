/**
 * The one answer to "what is the Twilio token right now?".
 *
 * A value saved in CRM Settings wins; without one the environment still applies,
 * so an empty table changes nothing and a deployment keeps working while keys are
 * being moved over.
 *
 * This never throws. Sign-in codes and phone webhooks depend on it, so if the
 * database cannot be read the last known values stand, and failing that the
 * environment's. Each server instance keeps the answer for 30 seconds, so a saved
 * change reaches every instance within that time.
 */
import 'server-only';
import { integrationEnv, mailBaseConfigured, mailProvider, serverEnv, type IntegrationEnvKey } from '@/lib/env.server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { SETTING_KEYS } from './catalog';
import { openSetting } from './crypto';

const TTL_MS = 30_000;
const READ_TIMEOUT_MS = 3_000;

export type IntegrationValues = Partial<Record<IntegrationEnvKey, string>>;

export type IntegrationSnapshot = {
  values: IntegrationValues;
  /** Keys whose value came from CRM Settings rather than the environment. */
  fromCrm: ReadonlySet<string>;
  /** Saved keys that would not open: LOGIN_ENC_KEY changed since they were saved. */
  unreadable: readonly string[];
};

type Row = { key: string; sealed: string; iv: string };

export function envValues(): IntegrationValues {
  const out: IntegrationValues = {};
  for (const key of SETTING_KEYS as IntegrationEnvKey[]) {
    const v = integrationEnv[key];
    if (v !== undefined && v !== null && String(v) !== '') out[key] = String(v);
  }
  return out;
}

/** The saved rows laid over the environment. Pure apart from decryption. */
export function merge(rows: Row[], env: IntegrationValues, open: (key: string, r: Row) => string): IntegrationSnapshot {
  const values: IntegrationValues = { ...env };
  const fromCrm = new Set<string>();
  const unreadable: string[] = [];
  for (const row of rows) {
    if (!SETTING_KEYS.includes(row.key)) continue;
    try {
      values[row.key as IntegrationEnvKey] = open(row.key, row);
      fromCrm.add(row.key);
    } catch {
      unreadable.push(row.key);
      console.error('[integrations] a saved value would not open', { key: row.key });
    }
  }
  return { values, fromCrm, unreadable };
}

let held: { snap: IntegrationSnapshot; at: number } | null = null;
let loading: Promise<IntegrationSnapshot> | null = null;

async function load(): Promise<IntegrationSnapshot> {
  try {
    const { data, error } = await supabaseAdmin()
      .from('integration_settings')
      .select('key, sealed, iv')
      .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS));
    if (error) throw error;
    const snap = merge((data ?? []) as Row[], envValues(), openSetting);
    held = { snap, at: Date.now() };
    return snap;
  } catch (cause) {
    console.error('[integrations] could not read saved settings, keeping what is known', { code: (cause as { code?: string } | null)?.code ?? 'error' });
    if (held) {
      // Try again soon, not on every request while the database is unwell.
      held = { snap: held.snap, at: Date.now() - TTL_MS + 5_000 };
      return held.snap;
    }
    return { values: envValues(), fromCrm: new Set(), unreadable: [] };
  }
}

export async function integrationSnapshot(): Promise<IntegrationSnapshot> {
  if (held && Date.now() - held.at < TTL_MS) return held.snap;
  loading ??= load().finally(() => {
    loading = null;
  });
  return loading;
}

export const integrationValues = async (): Promise<IntegrationValues> => (await integrationSnapshot()).values;

/** After a save, so this instance does not act on the old key for 30 seconds. */
export function forgetIntegrationValues(): void {
  held = null;
  loading = null;
}

/* ── is each service usable? One definition each, so a half-configured service
 *    is off everywhere rather than half working. ─────────────────────────── */

export const phoneReadyFrom = (v: IntegrationValues): boolean =>
  Boolean(v.TWILIO_ACCOUNT_SID && v.TWILIO_API_KEY_SID && v.TWILIO_API_KEY_SECRET && v.TWILIO_TWIML_APP_SID && v.TWILIO_AUTH_TOKEN);

export const agreementsReadyFrom = (v: IntegrationValues): boolean => Boolean(v.SIGNWELL_API_KEY && v.SIGNWELL_WEBHOOK_ID);

export function mailReadyFrom(v: IntegrationValues): boolean {
  if (!mailBaseConfigured) return false;
  return mailProvider === 'mock' ? Boolean(serverEnv.MAIL_MOCK_BASE_URL) : Boolean(v.MAIL_CLIENT_ID && v.MAIL_CLIENT_SECRET);
}

export const phoneReady = async (): Promise<boolean> => phoneReadyFrom(await integrationValues());
export const agreementsReady = async (): Promise<boolean> => agreementsReadyFrom(await integrationValues());
export const mailReady = async (): Promise<boolean> => mailReadyFrom(await integrationValues());

/** Test mode unless production says otherwise with SIGNWELL_TEST_MODE=false. */
export const signwellTestModeFrom = (v: IntegrationValues): boolean => serverEnv.NODE_ENV !== 'production' || v.SIGNWELL_TEST_MODE !== 'false';
export const signwellTestMode = async (): Promise<boolean> => signwellTestModeFrom(await integrationValues());
