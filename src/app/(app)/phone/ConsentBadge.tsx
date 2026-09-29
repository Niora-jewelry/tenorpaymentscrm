'use client';

/**
 * Whether this number may be texted — shown where the text is being written.
 *
 * ── WHY IT WARNS AND DOES NOT BLOCK ──────────────────────────────────────
 * The honest position is that this CRM does not know everything. A merchant
 * may have consented on paperwork nobody has entered yet, and a rep who is
 * looking at that signed page should not be stopped by a system that has not
 * caught up. Blocking would mean the fastest route past it is to type consent
 * in falsely — which is worse than the risk it prevents, because it puts
 * fiction into the one record that exists to be evidence.
 *
 * So it says plainly what is known, makes recording real consent a single
 * click, and leaves the judgement with the person who can actually see the
 * paperwork. What it never does is stay silent.
 */
import { useEffect, useState, useTransition } from 'react';
import { Icon } from '@/proto/ui/icons';
import { formatPhoneDisplay } from '@/lib/phone/normalize';
import { SMS_VERBAL_CONSENT_SCRIPT } from '@/lib/sms/consentText';
import type { ConsentStatus } from '@/lib/sms/consent';
import { consentStatusAction, recordConsentAction } from './consentActions';

export function ConsentBadge({ e164 }: { e164: string | null }) {
  /*
   * The loaded status is stored WITH the number it belongs to, and the value
   * used is derived from whether those still agree. The obvious version -
   * clearing the status in the effect when the number changes - sets state
   * synchronously inside an effect, which triggers a cascading render and is
   * a lint error here. Deriving says the same thing with no second render,
   * and it also removes the window in which a stale answer from the previous
   * number is briefly shown against the new one.
   */
  const [loaded, setLoaded] = useState<{ e164: string; status: ConsentStatus } | null>(null);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const status = loaded && loaded.e164 === e164 ? loaded.status : null;

  useEffect(() => {
    if (!e164) return;
    let cancelled = false;
    startTransition(async () => {
      const result = await consentStatusAction(e164);
      if (!cancelled) setLoaded({ e164, status: result });
    });
    return () => {
      cancelled = true;
    };
  }, [e164]);

  if (!e164) return null;

  if (pending && !status) {
    return <p className="text-[11.5px] text-ink-400">Checking consent…</p>;
  }

  if (status?.consented) {
    const when = status.consentedAt
      ? new Date(status.consentedAt).toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })
      : null;
    const how =
      status.source === 'web_form'
        ? 'on the consent form'
        : status.source === 'verbal'
          ? 'on a call'
          : status.source === 'paperwork'
            ? 'on paperwork'
            : 'imported';

    return (
      <p className="flex items-center gap-1.5 text-[11.5px] text-ok">
        <Icon name="check" size={11} strokeWidth={2.5} />
        Consented {how}
        {when ? ` · ${when}` : ''}
      </p>
    );
  }

  const record = (source: 'verbal' | 'paperwork') => {
    setError(null);
    startTransition(async () => {
      const result = await recordConsentAction({ phone: e164, source });
      if (result.ok) {
        setLoaded({ e164, status: await consentStatusAction(e164) });
        setRecording(false);
      } else {
        setError(result.message ?? 'That could not be saved.');
      }
    });
  };

  return (
    <div className="rounded-lg border border-[#f7e0af] bg-[#fdf1d8] px-2.5 py-2">
      <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-[#8a5a09]">
        <Icon name="alert-triangle" size={11} className="mt-[2px] shrink-0" />
        <span>
          No consent on file for {formatPhoneDisplay(e164)}. US carriers require permission before
          a business texts someone.
        </span>
      </p>

      {recording ? (
        <div className="mt-2">
          <p className="rounded-md bg-white/70 px-2 py-1.5 text-[11.5px] leading-relaxed text-ink-700">
            <span className="font-semibold">Read this first:</span> “{SMS_VERBAL_CONSENT_SCRIPT}”
          </p>
          <p className="mt-1.5 text-[11px] text-[#8a5a09]">
            Recording this puts your name against it as the person who heard them agree.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={pending}
              onClick={() => record('verbal')}
              className="rounded-md bg-ok px-2 py-1 text-[11.5px] font-semibold text-white disabled:opacity-60"
            >
              They agreed on a call
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => record('paperwork')}
              className="rounded-md border border-line bg-white px-2 py-1 text-[11.5px] font-medium text-ink-700 disabled:opacity-60"
            >
              It&rsquo;s on signed paperwork
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setRecording(false)}
              className="px-1.5 py-1 text-[11.5px] text-ink-500"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setRecording(true)}
          className="mt-1.5 text-[11.5px] font-semibold text-[#8a5a09] underline underline-offset-2"
        >
          Record their consent
        </button>
      )}

      {error ? (
        <p role="alert" className="mt-1.5 text-[11.5px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
