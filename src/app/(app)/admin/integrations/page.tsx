/**
 * Admin → Integrations — a PLACEHOLDER SCREEN, and deliberately nothing more.
 *
 * The client has never specified what this screen should do; the prototype's
 * own copy says "shell only in this build"
 * (`src/app/prototype/admin/page.tsx:706`), and `remaining-plan.md` § Phase 5
 * says in as many words: *"Do not spend real engineering time making either do
 * anything until there's a spec from the client."* So this screen states what
 * is and is not wired and offers no control that pretends otherwise — no
 * connect button, no credential form, no toggle. A control with no effect is
 * worse than an absent one: it is a promise the build cannot keep, and this
 * area has already refused two of those (a swatch on a dropdown, grid column
 * types beyond the three `GridCell` renders).
 *
 * WHY THE STATUSES BELOW SAY WHAT THEY SAY — each is a fact about this
 * repository, checked rather than copied from the prototype, which labels
 * Outlook and Instantly "Shell built" and overstates them:
 *
 *   - Email / Instantly / Text are REAL READS of the `messages` table
 *     (`lib/records/messages.ts`), rendered by `CommunicationPanel`.
 *   - Nothing writes that table. `src/app/api/` holds one route, `auth/signup`
 *     — there is no webhook endpoint in this build. Messages would arrive
 *     under the service role, which bypasses RLS (migration 9's
 *     `messages_select` policy comment), and there is deliberately no send
 *     path anywhere in the app.
 *   - Phone, Teams and Call recordings are seeded `coming_soon = true`
 *     (`20260819001000_module2_seed.sql:51,53,55`) and render the kit's
 *     `ComingSoon` state. That flag is the client's own, not an unfinished
 *     corner.
 *   - DocuSign has never been specified at all.
 *
 * So the empty Communication tab a user sees today is real absence of data,
 * not a stubbed screen — and that distinction is the single most useful thing
 * this page can tell an admin.
 */
import { redirect } from 'next/navigation';
import { authorize } from '@/lib/records/permissions';
import { Icon } from '@/proto/ui/icons';
import { PlaceholderNotice } from '../PlaceholderNotice';

type State = 'read-only' | 'coming-soon' | 'unspecified';

const STATE_LABEL: Record<State, string> = {
  'read-only': 'Reads only — nothing writes',
  'coming-soon': 'Coming soon',
  unspecified: 'Not specified',
};

const STATE_CLASS: Record<State, string> = {
  // Neutral, not green: a read path with no writer is not a working
  // integration, and colouring it as success would say it is.
  'read-only': 'border-line bg-white text-ink-500',
  'coming-soon': 'border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]',
  unspecified: 'border-line bg-canvas text-ink-400',
};

const PROVIDERS: { name: string; what: string; where: string; state: State }[] = [
  {
    name: 'Outlook',
    what: 'Inbound email, deposited onto the matching record',
    where: 'Communication → Email',
    state: 'read-only',
  },
  {
    name: 'Instantly',
    what: 'Campaign replies, labelled separately from Outlook',
    where: 'Communication → Instantly',
    state: 'read-only',
  },
  {
    name: 'SMS',
    what: 'Inbound text messages',
    where: 'Communication → Text',
    state: 'read-only',
  },
  {
    name: 'Phone (Twilio)',
    what: 'Calls, and the recordings they produce',
    where: 'Communication → Phone · Call recordings',
    state: 'coming-soon',
  },
  {
    name: 'Teams',
    what: 'Meetings surface',
    where: 'Communication → Teams',
    state: 'coming-soon',
  },
  {
    name: 'DocuSign',
    what: 'Gets its own tab once the client specifies one',
    where: 'No home yet',
    state: 'unspecified',
  },
];

export default async function AdminIntegrationsPage() {
  const ctx = await authorize();
  if (!ctx.isAdmin) redirect('/dashboard');

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Integrations</h1>
        <p className="text-[13px] text-ink-500">
          Where a record&rsquo;s Communication tab gets its messages from.
        </p>
      </div>

      <PlaceholderNotice title="Nothing on this screen is connected, and nothing here can be configured.">
        <p>
          No provider integration exists in this build — there is no webhook endpoint, no
          credential store and no send path anywhere in the app. This screen reports what each
          channel does today so that an empty Communication tab can be read correctly: it is real
          absence of data, not a broken screen.
        </p>
        <p>
          The client has not specified what this screen should do. Connecting a provider is its own
          piece of work and needs a specification first.
        </p>
      </PlaceholderNotice>

      <section className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          {PROVIDERS.map((p) => (
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
              <p className="mt-2 inline-flex items-center gap-1.5 text-[11.5px] text-ink-400">
                <Icon name="message-square" size={12} />
                {p.where}
              </p>
            </div>
          ))}
        </div>

        <p className="flex gap-2 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-[12.5px] leading-relaxed text-brand-700">
          <Icon name="info" size={14} className="mt-0.5 shrink-0 opacity-70" />
          <span>
            <strong>Reads only</strong> means the drawer already renders that channel from the real{' '}
            <code>messages</code> table — the read path is finished and correct. What is missing is
            anything that puts a message into it. The matching rules are settled even though nothing
            is wired: an inbound message matches against sync-enabled Email and Phone fields, a
            multi-match deposits into <strong>all</strong> matching records, a known sender never
            creates a new record, and sync is <strong>forward-only</strong> — no historical backfill.
          </span>
        </p>
      </section>
    </div>
  );
}
