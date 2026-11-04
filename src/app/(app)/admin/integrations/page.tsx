/**
 * Admin → Integrations — what each Communication channel actually does.
 *
 * ── THIS SCREEN WAS WRONG, AND THAT IS WHY IT NOW READS LIVE STATE ───────
 * It used to open with "Nothing on this screen is connected… there is no
 * webhook endpoint, no credential store and no send path anywhere in the app",
 * and listed Phone as Coming soon. Every clause of that became false the day
 * the Twilio module landed: there are seven signed webhook routes under
 * `app/api/twilio/`, credentials in `lib/env.server.ts`, and `sendMessage()`
 * sends SMS.
 *
 * A screen that confidently tells an admin something untrue is worse than an
 * empty one — this is the same defect the Permissions screen had, where a
 * banner said template grants "cannot yet be changed" while the matrix beside
 * it was writing them.
 *
 * So the statuses are no longer prose anyone has to remember to update. The
 * Twilio rows read `phoneReady` from the live settings, so an unconfigured
 * deployment says so by itself, and a configured one cannot keep claiming to be
 * "coming soon".
 *
 * The Email module (Outlook / Microsoft 365, two-way) reads `mailReady` the same
 * way, and shows its health from the engine's own tables.
 *
 * Above that sits the place to enter the keys themselves (IntegrationsPanel).
 *
 * ── WHAT IS STILL HONESTLY NOT BUILT ─────────────────────────────────────
 * Mail deposited onto RECORDS (the drawer's Email tab) remains a real READ
 * of the `messages` table with nothing writing it — the Email module is
 * deliberately standalone (spec). DocuSign has never been specified. Instantly was removed outright (UI/UX Redesign spec §5).
 */
import { redirect } from 'next/navigation';
import { authorize, canOpenAdminPage } from '@/lib/records/permissions';
import { Icon } from '@/proto/ui/icons';
import { mailReady, maverickReady, phoneReady } from '@/lib/integrations/resolve';
import { integrationsScreen } from '@/lib/integrations/service';
import { adminHealth, SECRET_WARNING_DAYS, type AdminHealth } from '@/lib/mail/health';
import { IntegrationsPanel } from './IntegrationsPanel';

type State = 'live' | 'needs-config' | 'read-only' | 'coming-soon' | 'unspecified';

const STATE_LABEL: Record<State, string> = {
  live: 'Connected — sends and receives',
  'needs-config': 'Built — not configured here',
  'read-only': 'Reads only — nothing writes',
  'coming-soon': 'Coming soon',
  unspecified: 'Not specified',
};

const STATE_CLASS: Record<State, string> = {
  // Green is reserved for a channel that genuinely works end to end. A read
  // path with no writer stays neutral: colouring it as success would say it
  // does something it does not.
  live: 'border-[#bfe6dd] bg-[#e6f6f2] text-[#0b6b5d]',
  'needs-config': 'border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]',
  'read-only': 'border-line bg-white text-ink-500',
  'coming-soon': 'border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]',
  unspecified: 'border-line bg-canvas text-ink-400',
};

type Provider = { name: string; what: string; where: string; state: State; note?: string };

function mailNote(h: AdminHealth | null): string {
  if (!h) return 'Email stays hidden until the Microsoft 365 keys above are entered.';
  const parts = [
    h.provider === 'config_error'
      ? 'Microsoft is refusing the app secret. Create a new one in Azure and replace it above.'
      : h.provider === 'down'
        ? 'Outlook could not be reached on the last attempts.'
        : 'Outlook is answering.',
    `${h.mailboxes} mailbox${h.mailboxes === 1 ? '' : 'es'} from ${h.connections} connection${h.connections === 1 ? '' : 's'}${h.attention ? `, ${h.attention} needing attention` : ''}.`,
  ];
  if (h.secretDaysLeft !== null && h.secretDaysLeft <= SECRET_WARNING_DAYS) {
    parts.push(h.secretDaysLeft < 0 ? 'The app secret has expired.' : `The app secret expires in ${h.secretDaysLeft} day${h.secretDaysLeft === 1 ? '' : 's'}.`);
  }
  return parts.join(' ');
}

function providers(twilioReady: boolean, mail: AdminHealth | null, maverick: boolean): Provider[] {
  /*
   * Read from configuration rather than written down. The previous version of
   * this screen was a hand-maintained list, which is exactly how it came to
   * describe a build that no longer existed.
   */
  const twilio: State = twilioReady ? 'live' : 'needs-config';

  return [
    {
      name: 'Phone (Twilio)',
      what: 'Outbound and inbound calls from the browser, recorded automatically',
      where: 'Phone · Communication → Phone',
      state: twilio,
      note: twilioReady
        ? 'Calls attach to a merchant by matching the other number against sync-enabled phone fields. A number the CRM has never seen is still logged, just unattached.'
        : 'The dialler stays unavailable until the Twilio keys above are entered.',
    },
    {
      name: 'Call recordings (Twilio)',
      what: 'Every answered call and voicemail, stored privately',
      where: 'Communication → Call recordings',
      state: twilio,
      note: 'Restricted to the person who was on the call, and to administrators — a colleague who can see the merchant sees that a call happened, not its audio.',
    },
    {
      name: 'SMS (Twilio)',
      what: 'Text messages, sent and received',
      where: 'Phone · Communication → Text',
      state: twilio,
      note: 'Sending additionally needs the number registered for A2P 10DLC or toll-free verification in the Twilio console — that is carrier state this app cannot check ahead of time. Receiving is unaffected.',
    },
    {
      name: 'Email (Outlook / Microsoft 365)',
      what: 'Mailboxes synced both ways with Outlook — read, send, folders, rules, invitations',
      where: 'Email · Settings → Email',
      state: mail ? 'live' : 'needs-config',
      note: mailNote(mail),
    },
    {
      name: 'Outlook on records',
      what: 'Inbound email, deposited onto the matching record',
      where: 'Communication → Email',
      state: 'read-only',
    },
    {
      name: 'Microsoft Teams',
      what: 'Calendar and Chat, through each person’s own Microsoft account',
      where: 'Calendar and Chat in the sidebar',
      state: mail ? 'live' : 'needs-config',
    },
    {
      name: 'Teams on records',
      what: 'Kept for later: not linked to records in this version',
      where: 'Communication → Teams',
      state: 'coming-soon',
    },
    {
      name: 'Maverick Payments',
      what: 'Send and update applications, their status, Reporting, statements and support tickets',
      where: 'Applications · Reporting · Statements · Cases → Other cases',
      state: 'needs-config',
      note: maverick
        ? 'The API key is saved. The connection is switched on once Maverick’s API documentation is in.'
        : 'Enter the Maverick API key above. The connection is switched on once Maverick’s API documentation is in.',
    },
    {
      name: 'DocuSign',
      what: 'Gets its own tab once the client specifies one',
      where: 'No home yet',
      state: 'unspecified',
    },
  ];
}

export default async function AdminIntegrationsPage() {
  const ctx = await authorize();
  if (!(await canOpenAdminPage(ctx, 'integrations'))) redirect('/dashboard');

  const [twilioLive, mailLive, maverickKey, screen] = await Promise.all([phoneReady(), mailReady(), maverickReady(), integrationsScreen(ctx)]);
  const list = providers(twilioLive, mailLive ? await adminHealth() : null, maverickKey);

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Integrations</h1>
        <p className="text-[13px] text-ink-500">
          Connect the services the CRM uses, and see what each channel does today.
        </p>
      </div>

      <IntegrationsPanel screen={screen} />

      <section className="space-y-3">
        <h2 className="pt-2 text-[15px] font-semibold text-ink-900">What each channel does</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {list.map((p) => (
            <div key={p.name} className="rounded-panel border border-line bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14.5px] font-semibold text-ink-900">{p.name}</span>
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-[2.5px] text-[11.5px] font-semibold tracking-[.03em] ${STATE_CLASS[p.state]}`}
                >
                  {STATE_LABEL[p.state]}
                </span>
              </div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">{p.what}</p>
              {p.note ? (
                <p className="mt-1.5 text-[12px] leading-relaxed text-ink-400">{p.note}</p>
              ) : null}
              <p className="mt-2 inline-flex items-center gap-1.5 text-[11.5px] text-ink-400">
                <Icon name="message-square" size={12} />
                {p.where}
              </p>
            </div>
          ))}
        </div>

        {/* Narrowed to the four channels it is still true of. It used to be
            framed as a statement about the whole screen, which stopped being
            accurate the moment one channel started working. */}
        <p className="flex gap-2 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-[12.5px] leading-relaxed text-brand-700">
          <Icon name="info" size={14} className="mt-0.5 shrink-0 opacity-70" />
          <span>
            <strong>Email on records is read only.</strong> The drawer renders it from the real{' '}
            <code>messages</code> table, so that read path is finished — what is missing is any
            provider that puts a message into it. The matching rules are settled even though nothing
            is wired: an inbound message matches against sync-enabled Email and Phone fields, a
            multi-match deposits into <strong>all</strong> matching records, a known sender never
            creates a new record, and sync is <strong>forward-only</strong> — no historical
            backfill. An empty Email tab is real absence of data, not a broken screen.
          </span>
        </p>
      </section>
    </div>
  );
}
