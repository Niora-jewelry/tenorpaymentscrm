/**
 * Admin → Integrations (client, 6 Nov 2026: "Admin panel UI-UX changes").
 *
 * Every integration is a tab across the top; the open tab shows that one
 * integration only, with three subtabs and its on/off switch on the same row:
 *   Main connector         the company account (keys, test, what it powers)
 *   Individual connectors  per person or per merchant (Twilio: each person's
 *                          number; Microsoft 365: who connected their account;
 *                          Maverick: merchants matched to records)
 *   Activity               when it was first connected, and its change history
 *
 * Phone numbers and Maverick used to be pages of their own in Configure. They
 * now live here, and their old addresses forward to the right subtab. Each part
 * keeps its own permission: someone who may assign numbers but not see keys
 * still gets Twilio › Individual connectors and nothing else.
 *
 * ── WHY THE STATUSES ARE READ, NOT WRITTEN ───────────────────────────────
 * This screen once said "Nothing on this screen is connected" the day Twilio
 * went live. The channel statuses come from live settings (`phoneReady`,
 * `mailReady`), so a screen can never claim something untrue.
 */
import { redirect } from 'next/navigation';
import { authorize, canOpenAdminPage } from '@/lib/records/permissions';
import { mailReady, maverickReady, phoneReady } from '@/lib/integrations/resolve';
import { integrationsScreen, microsoftPeople, GROUPS, type MicrosoftPerson } from '@/lib/integrations/service';
import { forgetIntegrationValues } from '@/lib/integrations/resolve';
import { adminHealth, SECRET_WARNING_DAYS, type AdminHealth } from '@/lib/mail/health';
import { listNumbers } from '@/lib/records/adminNumbers';
import { listUsers } from '@/lib/records/adminUsers';
import { processorPerms } from '@/lib/processors/access';
import { connectionScreen } from '@/lib/processors/service';
import { ADAPTER_READY } from '@/lib/processors/vendor';
import type { IntegrationGroup } from '@/lib/integrations/catalog';
import { NumbersSection } from '../numbers/NumbersSection';
import { MaverickConnection } from '../maverick/MaverickConnection';
import { IntegrationsPanel, type Channel, type IntegrationTab } from './IntegrationsPanel';

export const dynamic = 'force-dynamic';

function mailNote(h: AdminHealth | null): string {
  if (!h) return 'Email stays hidden until the Microsoft 365 keys are entered.';
  const parts = [
    h.provider === 'config_error'
      ? 'Microsoft is refusing the app secret. Create a new one in Azure and replace it.'
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

/** What each integration powers, read from live configuration. */
function channels(twilioReady: boolean, mail: AdminHealth | null, maverickKey: boolean): Partial<Record<IntegrationGroup, Channel[]>> {
  const twilio = twilioReady ? 'live' : 'needs-config';
  const ms = mail ? 'live' : 'needs-config';
  return {
    twilio: [
      { name: 'Phone', what: 'Calls from the browser, in and out, recorded automatically', where: 'Phone · Communication › Phone', state: twilio },
      { name: 'Call recordings', what: 'Every answered call and voicemail, stored privately', where: 'Communication › Call recordings', state: twilio },
      {
        name: 'Text messages',
        what: 'Sent and received',
        where: 'Phone · Communication › Text',
        state: twilio,
        note: 'Sending to US numbers also needs each number registered (A2P 10DLC or toll-free verification) in the Twilio console.',
      },
    ],
    microsoft: [
      { name: 'Email', what: 'Outlook mailboxes synced both ways: read, send, folders, rules, invitations', where: 'Email · Settings › Email', state: ms, note: mailNote(mail) },
      { name: 'Calendar and Chat', what: 'Through each person’s own Microsoft account', where: 'Calendar and Chat in the sidebar', state: ms },
      { name: 'Teams on records', what: 'Teams chats and channels linked to a merchant record', where: 'Communication › Teams', state: ms },
    ],
    maverick: [
      {
        name: 'Maverick Payments',
        what: 'Applications, their status, Reporting, statements and support tickets',
        where: 'Applications · Reporting · Statements · Cases',
        state: 'needs-config',
        note: maverickKey ? 'The API key is saved. The connection is switched on once Maverick lets API requests through.' : undefined,
      },
    ],
  };
}

export default async function AdminIntegrationsPage({ searchParams }: { searchParams: Promise<{ tab?: string; sub?: string }> }) {
  const ctx = await authorize();
  const [keys, numbersOk, mav] = await Promise.all([
    canOpenAdminPage(ctx, 'integrations'),
    canOpenAdminPage(ctx, 'numbers'),
    processorPerms(ctx).catch(() => null),
  ]);
  const maverickOk = Boolean(mav && (mav.connection || mav.resolveUnmatched));
  if (!keys && !numbersOk && !maverickOk) redirect('/dashboard');
  // This screen never shows a value another server instance has since changed.
  forgetIntegrationValues();

  const [screen, twilioLive, mailLive, maverickKey, numbers, users, people, maverick] = await Promise.all([
    keys ? integrationsScreen(ctx) : Promise.resolve(null),
    phoneReady(),
    mailReady(),
    maverickReady(),
    numbersOk ? listNumbers(ctx) : Promise.resolve(null),
    // Picking whom to assign a number to reads the user list, which has its own permission.
    numbersOk ? listUsers(ctx).catch(() => []) : Promise.resolve(null),
    keys ? microsoftPeople(ctx) : Promise.resolve([] as MicrosoftPerson[]),
    maverickOk ? connectionScreen(ctx).catch(() => null) : Promise.resolve(null),
  ]);
  const what = channels(twilioLive, keys && mailLive ? await adminHealth() : null, maverickKey);

  // Which tabs this person gets, in the long-standing order.
  const tabs: IntegrationTab[] = GROUPS.flatMap(({ group, title }) => {
    const g = screen?.groups.find((x) => x.group === group) ?? null;
    const twilioNumbers =
      group === 'twilio' && numbers && users ? (
        <NumbersSection
          numbers={numbers}
          users={users
            // A suspended account cannot hold a session, so a number for it is spend nobody can use.
            .filter((u) => u.status === 'active')
            .map((u) => ({ id: u.id, label: u.fullName ? `${u.fullName} — ${u.email}` : u.email }))}
        />
      ) : null;
    const mavMain = group === 'maverick' && maverick?.canManage ? <MaverickConnection screen={maverick} adapterReady={ADAPTER_READY} part="main" /> : null;
    const mavIndividual = group === 'maverick' && maverick?.canResolve ? <MaverickConnection screen={maverick} adapterReady={ADAPTER_READY} part="individual" /> : null;
    if (!g && !twilioNumbers && !mavMain && !mavIndividual) return [];
    return [
      {
        group,
        title,
        view: g,
        channels: what[group] ?? [],
        mainExtra: mavMain,
        individual: twilioNumbers ?? mavIndividual,
        microsoftPeople: group === 'microsoft' && keys ? people : null,
      },
    ];
  });

  const { tab, sub } = await searchParams;

  return (
    <div className="space-y-5 p-6">
      <h1 className="text-xl font-semibold text-ink-900">Integrations</h1>
      <IntegrationsPanel
        tabs={tabs}
        canEdit={screen?.canEdit ?? false}
        origin={screen?.origin ?? ''}
        changes={screen?.changes ?? []}
        firstOn={screen?.firstOn ?? {}}
        initialTab={tab}
        initialSub={sub}
      />
    </div>
  );
}
