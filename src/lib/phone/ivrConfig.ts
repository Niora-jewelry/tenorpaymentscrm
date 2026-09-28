/**
 * Loading the phone menu's configuration.
 *
 * Separate from `ivr.ts` on purpose: that module is pure and testable, this
 * one talks to the database. Keeping the line between them sharp is what lets
 * every branch of the menu be unit-tested without a Twilio account.
 *
 * Read with the service role throughout — a webhook has no `auth.uid()`, and
 * these tables are admin-only under RLS.
 */
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { IvrConfig, IvrPromptSlug, IvrTarget } from './ivr';

/** Used when a row is missing, so a half-configured menu still speaks. */
const FALLBACK_PROMPTS: Record<IvrPromptSlug, string> = {
  greeting_open: 'Thank you for calling TapDash Payments.',
  greeting_closed: 'Thank you for calling TapDash Payments. Our office is currently closed.',
  transfer_open: 'Please hold while we transfer your call.',
  transfer_closed: 'Please hold while we check for a representative.',
  high_volume:
    'We are currently experiencing high call volume. To leave a voicemail, press 1. ' +
    'Otherwise remain on the line.',
  voicemail_prompt: 'Please leave your message after the beep.',
  voicemail_closed: 'We are unable to take your call. Please leave a message after the beep.',
  support_transfer: 'Transferring you to merchant support.',
  discover: 'Visit tapdash.co forward slash discover.',
  invalid_entry: 'That is an invalid entry.',
  record_notice: 'This call may be recorded.',
};

export type IvrState = {
  /** False means behave exactly as the phone module did before the menu. */
  enabled: boolean;
  open: boolean;
  config: IvrConfig;
  /** Who should ring right now — already filtered for the time of day. */
  targets: IvrTarget[];
  /** Every extension with direct-dial digits, whatever the hour. */
  extensions: IvrTarget[];
  mainNumberE164: string | null;
  voicemailEmail: string;
};

type ExtensionRow = {
  label: string;
  digits: string | null;
  user_id: string | null;
  external_e164: string | null;
  ring_during_hours: boolean;
  ring_after_hours: boolean;
};

export async function loadIvrState(
  client: SupabaseClient,
  origin: string,
): Promise<IvrState> {
  const [settingsRes, promptsRes, extensionsRes, openRes] = await Promise.all([
    client.from('ivr_settings').select('*').eq('singleton', true).maybeSingle(),
    client.from('ivr_prompts').select('slug, body'),
    client
      .from('ivr_extensions')
      .select('label, digits, user_id, external_e164, ring_during_hours, ring_after_hours')
      .eq('is_active', true)
      .order('position', { ascending: true }),
    client.rpc('ivr_is_open'),
  ]);

  const s = settingsRes.data as Record<string, unknown> | null;

  const prompts = { ...FALLBACK_PROMPTS };
  for (const row of (promptsRes.data ?? []) as { slug: string; body: string }[]) {
    if (row.slug in prompts) prompts[row.slug as IvrPromptSlug] = row.body;
  }

  const config: IvrConfig = {
    voice: (s?.voice as string) ?? 'Polly.Joanna-Neural',
    language: (s?.language as string) ?? 'en-US',
    holdMusicUrl:
      (s?.hold_music_url as string) ??
      'http://com.twilio.music.classical.s3.amazonaws.com/BusyStrings.mp3',
    recordNotice: (s?.record_notice as boolean) ?? true,
    ringSeconds: (s?.ring_seconds as number) ?? 60,
    voicemailMaxSeconds: (s?.voicemail_max_seconds as number) ?? 180,
    prompts,
    origin,
  };

  const rows = (extensionsRes.data ?? []) as ExtensionRow[];
  const toTarget = (r: ExtensionRow): IvrTarget => ({
    label: r.label,
    userId: r.user_id,
    externalE164: r.external_e164,
    digits: r.digits,
  });

  /*
   * `ivr_is_open` decides this, not JavaScript. Two implementations of "are we
   * open" would disagree by an hour twice a year when the clocks change, and
   * the first anyone would know is a caller reaching the wrong greeting.
   *
   * A failed RPC is treated as CLOSED. That is the safe direction: the closed
   * path always ends at voicemail, whereas the open path can leave a caller
   * holding for people who are not there.
   */
  const open = openRes.error ? false : Boolean(openRes.data);
  if (openRes.error) {
    console.error('[ivr] ivr_is_open failed; treating the office as closed', openRes.error);
  }

  return {
    enabled: Boolean(s?.enabled),
    open,
    config,
    targets: rows.filter((r) => (open ? r.ring_during_hours : r.ring_after_hours)).map(toTarget),
    extensions: rows.filter((r) => r.digits).map(toTarget),
    mainNumberE164: (s?.main_number_e164 as string) ?? null,
    voicemailEmail: (s?.voicemail_email as string) ?? 'info@tapdash.co',
  };
}

/**
 * Should the menu answer this particular call?
 *
 * Two gates, both deliberate:
 *   • the master switch, so it can be turned off without a deploy
 *   • the number, so turning it on does not hijack every inbound line
 *
 * A null `main_number_e164` means no number has been chosen yet — which is the
 * honest state until 732-479-3050 finishes porting — and the menu stays out of
 * the way until one is.
 */
export function ivrAnswersThisCall(state: IvrState, dialedE164: string): boolean {
  if (!state.enabled) return false;
  if (!state.mainNumberE164) return false;
  return state.mainNumberE164 === dialedE164;
}
