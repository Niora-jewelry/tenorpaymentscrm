/**
 * Email a voicemail to the inbox the client named.
 *
 * Both documents say the same thing, twice each and in capitals both times:
 *
 *   "The voicemail should go to info@tapdash.co ONLY"
 *
 * Q9 settled the form: "BOTH" — the recording as an attachment that plays in
 * the email, AND a link. The attachment is what makes it usable on a phone
 * without signing in; the link is what still works in two years when the
 * mailbox has been archived and the attachment stripped.
 *
 * ── WHY DELIVERY IS RECORDED IN A TABLE ──────────────────────────────────
 * "It should go to info@tapdash.co" is a requirement that fails silently. If
 * the send throws, the voicemail still exists, the caller still hung up
 * satisfied, and nobody learns that the message never arrived until a merchant
 * asks why they were not called back. `ivr_voicemail_deliveries` makes that
 * answerable: one row per recording, carrying the error if there was one.
 */
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendVoicemailEmail } from '@/lib/email/send';
import { formatPhoneDisplay } from './normalize';

const BUCKET = 'phone-recordings';
/** Long enough to still work when somebody opens the email next week. */
const LINK_TTL_SECONDS = 60 * 60 * 24 * 30;
/**
 * Microsoft rejects messages over roughly 25MB. A three-minute voicemail is
 * well under a megabyte, but the cap exists so an unexpectedly long recording
 * degrades to a link instead of failing to send at all.
 */
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export async function deliverVoicemail(
  client: SupabaseClient,
  opts: {
    recordingId: string;
    storagePath: string;
    toEmail: string;
    callerE164: string | null;
    dialedE164: string | null;
    durationSeconds: number | null;
    appOrigin: string;
  },
): Promise<void> {
  // Claim the delivery first. The unique index on recording_id means a Twilio
  // retry that reaches here twice cannot send two emails.
  const { error: claimErr } = await client
    .from('ivr_voicemail_deliveries')
    .insert({ recording_id: opts.recordingId, to_email: opts.toEmail, attempts: 1 });

  if (claimErr) {
    if (claimErr.code === '23505') return; // already handled
    console.error('[voicemail] could not record the delivery attempt', claimErr);
    // Carry on regardless: emailing the voicemail matters more than logging it.
  }

  let attachment: { filename: string; content: Buffer } | undefined;
  let link: string | null = null;

  try {
    const { data: signed } = await client.storage
      .from(BUCKET)
      .createSignedUrl(opts.storagePath, LINK_TTL_SECONDS);
    link = signed?.signedUrl ?? null;

    const { data: file, error: dlErr } = await client.storage
      .from(BUCKET)
      .download(opts.storagePath);

    if (dlErr) {
      console.error('[voicemail] could not download for attachment', dlErr);
    } else if (file) {
      const bytes = Buffer.from(await file.arrayBuffer());
      if (bytes.byteLength <= MAX_ATTACHMENT_BYTES) {
        attachment = { filename: voicemailFilename(opts.callerE164), content: bytes };
      } else {
        // The link still works, so this is a downgrade rather than a failure.
        console.warn('[voicemail] too large to attach; sending the link only', {
          bytes: bytes.byteLength,
        });
      }
    }
  } catch (error) {
    console.error('[voicemail] preparing the email failed', error);
  }

  const result = await sendVoicemailEmail(opts.toEmail, {
    callerE164: opts.callerE164,
    dialedE164: opts.dialedE164,
    durationSeconds: opts.durationSeconds,
    link,
    attachment,
  });

  const { error: markErr } = await client
    .from('ivr_voicemail_deliveries')
    .update(
      result.ok
        ? { delivered_at: new Date().toISOString(), error: null }
        : { error: result.error },
    )
    .eq('recording_id', opts.recordingId);

  if (markErr) console.error('[voicemail] could not mark the delivery', markErr);
  if (!result.ok) {
    console.error('[voicemail] SEND FAILED — the message did not reach the inbox', {
      to: opts.toEmail,
      recordingId: opts.recordingId,
      error: result.error,
    });
  }
}

function voicemailFilename(callerE164: string | null): string {
  const who = (callerE164 ?? 'unknown').replace(/[^\d+]/g, '') || 'unknown';
  const when = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `voicemail-${who}-${when}.mp3`;
}

/** "2 min 14 sec", or a dash when Twilio did not say. */
export function spokenDuration(seconds: number | null): string {
  if (seconds === null || seconds < 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s} sec`;
  return `${m} min ${s} sec`;
}

export { formatPhoneDisplay };
