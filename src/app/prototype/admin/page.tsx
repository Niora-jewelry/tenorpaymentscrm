'use client';

/**
 * PROTOTYPE — the Admin module.
 *
 * The single configuration source for the whole CRM. Every dashboard and drawer
 * elsewhere in the prototype is a pure consumer of what is defined here: change
 * a tab assignment in this screen and the drawer in Leads rearranges, because
 * they are reading the same rows.
 *
 * Five tabs, matching the Admin Module Plan: Users · Presets · Integrations ·
 * Automations · Recycle bin.
 */
import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { FIELDS, columnsFor } from '@/proto/fields';
import {
  MODULES,
  PIPELINES,
  CUSTOM_TABS,
  SYSTEM_TABS,
  tabsForModule,
  describePlacement,
} from '@/proto/modules';
import { UNSPECIFIED_TYPES, type FieldType } from '@/proto/schema';
import { USERS, USER_BY_ID, APPLICATION_ROWS, NEXT_CASE_NUMBER } from '@/proto/data';
import { useStore, VIEWERS } from '@/proto/store';
import {
  Avatar,
  Button,
  EmptyState,
  OutlineChip,
  SectionLabel,
  SpecNote,
  StatusPill,
} from '@/proto/ui/kit';
import { SWATCHES, SWATCH_NAMES } from '@/proto/ui/tokens';
import { Icon, type IconName } from '@/proto/ui/icons';

const TABS: { id: AdminTab; icon: IconName }[] = [
  { id: 'Users', icon: 'users' },
  { id: 'Presets', icon: 'sliders' },
  { id: 'Integrations', icon: 'link' },
  { id: 'Automations', icon: 'route' },
  { id: 'Recycle bin', icon: 'trash' },
];
type AdminTab = 'Users' | 'Presets' | 'Integrations' | 'Automations' | 'Recycle bin';

export default function AdminPage() {
  return (
    <Suspense fallback={<div className="p-8 text-[13px] text-ink-400">Loading…</div>}>
      <AdminScreen />
    </Suspense>
  );
}

/**
 * The active tab lives in the URL (`?tab=Presets`) rather than in state, so the
 * sidebar's Admin sub-items are real links and any of them can be deep-linked.
 */
function AdminScreen() {
  const { viewer } = useStore();
  const search = useSearchParams();
  const tab = (search.get('tab') ?? 'Presets') as AdminTab;

  if (!viewer.isAdmin) {
    return (
      <div className="p-8">
        <EmptyState
          title="Admin is not available to this user"
          body="Admin access is all-or-nothing: anyone granted the Admin module has everything inside it. This viewer has not been granted it, so it is absent from their navigation."
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line bg-white px-4 pt-3">
        <h1 className="flex items-center gap-2 text-[18px] font-semibold tracking-[-.01em] text-ink-900">
          <span className="grid size-7 place-items-center rounded-lg bg-brand-50 text-brand-700">
            <Icon name="cog" size={15} strokeWidth={2} />
          </span>
          Admin
        </h1>
        <p className="mt-1 max-w-[100ch] text-[12.5px] leading-relaxed text-ink-400">
          Everything the CRM displays is defined here. Access is all-or-nothing — an admin has every
          tab below, or none of them.
        </p>
        <nav className="-mb-px mt-2 flex gap-0.5 overflow-x-auto">
          {TABS.map((t) => (
            <Link
              key={t.id}
              href={`/prototype/admin?tab=${encodeURIComponent(t.id)}`}
              className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-[13.5px] font-medium transition-colors duration-150 ${
                t.id === tab
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-ink-500 hover:border-line hover:text-ink-900'
              }`}
            >
              <Icon name={t.icon} size={14} />
              {t.id}
            </Link>
          ))}
        </nav>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-[1180px]">
          {tab === 'Users' ? <UsersTab /> : null}
          {tab === 'Presets' ? <PresetsTab /> : null}
          {tab === 'Integrations' ? <IntegrationsTab /> : null}
          {tab === 'Automations' ? <AutomationsTab /> : null}
          {tab === 'Recycle bin' ? <RecycleBinTab /> : null}
        </div>
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Users                                                                       */
/* ========================================================================== */

function UsersTab() {
  return (
    <div className="space-y-5">
      <SpecNote>
        Every grant uses three states — <strong>Hidden / View / Edit</strong> — assigned per module,
        at three levels: module access, tab and subtab access, and individual fields. Row visibility
        is separate and driven by the <strong>Team member</strong> field alone.
      </SpecNote>

      <section className="overflow-hidden rounded-panel border border-line bg-white">
        <header className="flex items-center gap-3 border-b border-line-soft px-4 py-3">
          <SectionLabel>Users</SectionLabel>
          <span className="text-[12.5px] text-ink-400 tabular">{USERS.length} accounts</span>
          <span className="ml-auto">
            <Button size="sm" variant="primary">
              + Invite a user
            </Button>
          </span>
        </header>

        <table className="w-full text-[13.5px]">
          <thead className="bg-canvas">
            <tr>
              {['User', 'Role', 'Permissions', 'Records List', 'Last login', ''].map((h) => (
                <th
                  key={h}
                  className="px-4 py-2 text-left text-[11.5px] font-semibold uppercase tracking-[.04em] text-ink-400"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[#f0f4f8]">
            {USERS.map((u, i) => {
              const profile = VIEWERS.find((v) => v.userId === u.id);
              const template =
                i % 4 === 0 ? 'Custom' : i % 3 === 0 ? 'Template: Sales Rep (edited)' : 'Template: Sales Rep';
              return (
                <tr key={u.id}>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-2">
                      <Avatar user={u} size={24} />
                      <span className="font-medium text-ink-900">{u.name}</span>
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-ink-500">{u.role}</td>
                  <td className="px-4 py-2.5">
                    {template.includes('(edited)') ? (
                      <button
                        type="button"
                        className="text-[12.5px] font-semibold text-brand-700 hover:underline"
                        title="Overridden grants always win over the template, and are never replaced by template edits"
                      >
                        {template}
                      </button>
                    ) : (
                      <span className="text-[12.5px] text-ink-500">{template}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {profile?.isAdmin ? (
                      <StatusPill label="Full" swatch="teal" dot={false} />
                    ) : profile?.modules.includes('records') ? (
                      <StatusPill label="Granted" swatch="blue" dot={false} />
                    ) : (
                      <span className="text-ink-400">No access</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-ink-500 tabular">
                    {i === 0 ? 'Today, 09:12' : `${i + 1}d ago`}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <span className="flex justify-end gap-2 text-[12.5px]">
                      <button type="button" className="font-semibold text-brand-700 hover:underline">
                        Login history
                      </button>
                      <button type="button" className="text-ink-400 hover:text-[#b02a30] hover:underline">
                        Pause
                      </button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <div className="grid gap-3 md:grid-cols-3">
        <InfoCard title="Three levels of removal">
          <strong>Pause</strong> — cannot log in, existing sessions rejected mid-flight, all data
          intact. <strong>Soft delete</strong> — moves to the Recycle Bin, restorable.{' '}
          <strong>Full delete</strong> — permanent.
        </InfoCard>
        <InfoCard title="Forced reassignment">
          Before any delete, the admin must reassign every record where the departing user is the
          Team member. The delete is blocked until that is finished.
        </InfoCard>
        <InfoCard title="Cross-visibility grants">
          &ldquo;John sees Steve&rsquo;s leads&rdquo; is one grant, in one direction. The viewer
          still operates under <em>their own</em> field and tab permissions.
        </InfoCard>
      </div>

      <section className="rounded-panel border border-line bg-white p-4">
        <SectionLabel>What each prototype profile can see</SectionLabel>
        <div className="mt-3 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {VIEWERS.map((v) => {
            const u = USER_BY_ID.get(v.userId)!;
            const hidden = Object.entries(v.grants).filter(([, g]) => g === 'hidden').length;
            const view = Object.entries(v.grants).filter(([, g]) => g === 'view').length;
            return (
              <div key={v.userId} className="rounded-xl border border-line p-3">
                <div className="flex items-center gap-2">
                  <Avatar user={u} size={24} />
                  <span className="text-[13px] font-semibold text-ink-900">{v.label}</span>
                </div>
                <dl className="mt-2 space-y-1 text-[12.5px] text-ink-500">
                  <Row k="Modules" v={`${v.modules.length} of ${MODULES.length}`} />
                  <Row k="Fields hidden" v={String(hidden)} />
                  <Row k="Fields read-only" v={String(view)} />
                  <Row k="Rows" v={v.ownRecordsOnly ? 'Own records only' : 'All records'} />
                </dl>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-[12px] text-ink-400">
          Switch between these in the top-right of any screen to see the effect live.
        </p>
      </section>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-ink-400">{k}</dt>
      <dd className="text-right font-medium text-ink-700">{v}</dd>
    </div>
  );
}

/* ========================================================================== */
/* Presets — where tabs, fields and pipelines are built                        */
/* ========================================================================== */

function PresetsTab() {
  const [q, setQ] = useState('');
  const [tabFilter, setTabFilter] = useState<string>('all');

  /*
   * Filtering is by TAB, not by module. Under the Global Amendment every field
   * is in every module, so a module filter would match all 81 rows every time.
   */
  const filtered = useMemo(
    () =>
      FIELDS.filter((f) => {
        if (q && !f.label.toLowerCase().includes(q.toLowerCase())) return false;
        if (tabFilter !== 'all' && !f.tab.startsWith(tabFilter)) return false;
        return true;
      }),
    [q, tabFilter],
  );

  const typeCounts = useMemo(() => {
    const map = new Map<FieldType, number>();
    for (const f of FIELDS) map.set(f.type, (map.get(f.type) ?? 0) + 1);
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, []);

  return (
    <div className="space-y-5">
      <SpecNote>
        Creating a field is three deliberate steps: define it, choose which display modules it
        appears in (<strong>at least one</strong>), then choose <strong>exactly one tab per
        module</strong>. The Records List needs no selection — every field automatically exists on
        every record and surfaces in its Details tab if it is not shelved elsewhere.
      </SpecNote>

      {/* --- the type gap --- */}
      <section className="rounded-panel border border-[#f7e0af] bg-[#fefaf0] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <OutlineChip tone="warn">Needs a decision</OutlineChip>
          <span className="text-[13.5px] font-semibold text-ink-900">
            Your spreadsheet needs five field types the specification never lists
          </span>
        </div>
        <div className="mt-3 grid gap-2 text-[13px] leading-relaxed text-ink-500 md:grid-cols-2">
          <p>
            <strong>Percentage</strong> — used about ten times across the pricing sheet.
          </p>
          <p>
            <strong>Address</strong> — Merchant address and Retail address, both &ldquo;City, State,
            Zip&rdquo;.
          </p>
          <p>
            <strong>Must-total-100% groups</strong> — Customer type, Customer profile, Sales method,
            Payment codes.
          </p>
          <p>
            <strong>Month multi-select</strong> — Seasonal, up to twelve months plus a note.
          </p>
          <p>
            <strong>Repeatable groups</strong> — &ldquo;add new owner, up to 5 owners&rdquo; repeats
            six fields as a block.
          </p>
          <p className="text-ink-400">
            All five are implemented in this prototype so you can see them working. They still need
            signing off.
          </p>
        </div>
      </section>

      {/* --- the global tab definition --- */}
      <section className="overflow-hidden rounded-panel border border-line bg-white">
        <header className="border-b border-line-soft px-4 py-3">
          <SectionLabel>The global tabs</SectionLabel>
          <p className="mt-1 text-[12.5px] text-ink-400">
            Defined once, used by every module. A module may reorder these — it can never add,
            remove or rename one.
          </p>
        </header>
        <div className="space-y-3 p-4">
          {[
            ['Custom tabs', CUSTOM_TABS],
            ['System tabs', SYSTEM_TABS],
          ].map(([label, list]) => (
            <div key={label as string}>
              <span className="text-[11px] font-semibold uppercase tracking-[.06em] text-ink-400">
                {label as string}
              </span>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {(list as typeof CUSTOM_TABS).map((t) => (
                  <span
                    key={t.id}
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] font-medium ${
                      t.system
                        ? 'border-line bg-canvas text-ink-500'
                        : 'border-brand-100 bg-brand-50 text-brand-700'
                    }`}
                  >
                    {t.system ? <Icon name="lock" size={10} /> : null}
                    {t.label}
                    {t.subtabs?.length ? (
                      <span className="text-ink-400">· {t.subtabs.length} subtabs</span>
                    ) : null}
                    {!t.acceptsFields ? (
                      <span title="Cannot hold fields" className="text-ink-400">
                        <Icon name="x" size={10} strokeWidth={2.4} />
                      </span>
                    ) : null}
                  </span>
                ))}
              </div>
            </div>
          ))}
          <p className="text-[11.5px] leading-relaxed text-ink-400">
            Subtabs are global too. <strong>Application</strong> carries General, Financial, ACQ,
            ACH, Private, Ownership and Prior Processor; <strong>Pricing</strong> carries
            Processing, ACH, Gateway, Terminal, POS, Other and Partner. Every tab and every subtab
            also carries a notes thread.
          </p>
        </div>
      </section>

      {/* --- per-module ordering, the only drawer variation --- */}
      <section className="overflow-hidden rounded-panel border border-line bg-white">
        <header className="border-b border-line-soft px-4 py-3">
          <SectionLabel>Tab order, per module</SectionLabel>
          <p className="mt-1 text-[12.5px] text-ink-400">
            The <strong>only</strong> way one module&rsquo;s drawer differs from another&rsquo;s.
            Same tabs, same fields, different sequence.
          </p>
        </header>
        <div className="divide-y divide-[#f0f4f8]">
          {MODULES.map((m) => (
            <div key={m.slug} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <span className="w-[120px] shrink-0 text-[13.5px] font-semibold text-ink-900">
                {m.label}
              </span>
              <span className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                {tabsForModule(m).map((t) => (
                  <span
                    key={t.id}
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] font-medium ${
                      t.system
                        ? 'border-line bg-canvas text-ink-500'
                        : 'border-brand-100 bg-brand-50 text-brand-700'
                    }`}
                  >
                    {t.system ? <Icon name="lock" size={10} aria-label="Locked system tab" /> : null}
                    {t.label}
                    {t.subtabs?.length ? (
                      <span className="text-ink-400">· {t.subtabs.length}</span>
                    ) : null}
                    {!t.acceptsFields ? (
                      <span
                        title="Updates, Communication and Cases can never hold fields"
                        className="text-ink-400"
                      >
                        <Icon name="x" size={10} strokeWidth={2.4} />
                      </span>
                    ) : null}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* --- pipelines --- */}
      <section className="overflow-hidden rounded-panel border border-line bg-white">
        <header className="border-b border-line-soft px-4 py-3">
          <SectionLabel>Pipelines</SectionLabel>
          <p className="mt-1 text-[12.5px] text-ink-400">
            Each pipeline belongs to exactly one module and can never appear in two. Creating one
            auto-creates a linked Status field whose options are its steps — one source of truth.
          </p>
        </header>
        <div className="divide-y divide-[#f0f4f8]">
          {PIPELINES.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="w-[150px] shrink-0">
                <span className="block text-[13.5px] font-semibold text-ink-900">{p.label}</span>
                <span className="block text-[11.5px] text-ink-400">
                  {MODULES.find((m) => m.slug === p.module)?.label}
                </span>
              </span>
              <span className="flex flex-wrap gap-1">
                {p.steps.map((s, i) => (
                  <span
                    key={s.id}
                    className="inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] text-[11.5px] font-semibold"
                    style={{
                      background: SWATCHES[s.swatch].bg,
                      color: SWATCHES[s.swatch].text,
                      borderColor: SWATCHES[s.swatch].border,
                    }}
                  >
                    <span className="tabular opacity-60">{i + 1}</span>
                    {s.label}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* --- swatches --- */}
      <section className="rounded-panel border border-line bg-white p-4">
        <SectionLabel>Status colours — a fixed set of 12, not a colour picker</SectionLabel>
        <p className="mt-1 text-[12.5px] text-ink-400">
          Each is checked for contrast. Nobody can create a red that means &ldquo;good&rdquo;, or a
          yellow no one can read.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {SWATCH_NAMES.map((s) => (
            <StatusPill key={s} label={s} swatch={s} size="md" />
          ))}
        </div>
      </section>

      {/* --- system structures --- */}
      <section className="rounded-panel border border-line bg-white p-4">
        <SectionLabel>Locked system structures</SectionLabel>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <InfoCard title={`Application files — ${APPLICATION_ROWS.length} locked rows`}>
            {APPLICATION_ROWS.join(' · ')}. The completeness indicator counts how many hold at least
            one file.
          </InfoCard>
          <InfoCard title="Logins grid">
            Login type · Link · User · Pass · Notes. Unlimited rows, envelope-encrypted, every reveal
            audited.
          </InfoCard>
          <InfoCard title="Statements month grid">
            July 2024 → December 2032, prebuilt. Extension is append-only: adding 2033 creates its
            twelve rows across every record at once. The July 2024 start never moves.
          </InfoCard>
          <InfoCard title="Case numbering">
            One global database sequence from #10000. Next number would be{' '}
            <strong className="tabular">#{NEXT_CASE_NUMBER}</strong>. Numbers are never reused, even
            after a purge.
          </InfoCard>
        </div>
      </section>

      {/* --- the field list --- */}
      <section className="overflow-hidden rounded-panel border border-line bg-white">
        <header className="flex flex-wrap items-center gap-3 border-b border-line-soft px-4 py-3">
          <SectionLabel>Module fields</SectionLabel>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search fields…"
            className="rounded-md border border-line px-2.5 py-1.5 text-[13px] outline-none focus-underline"
          />
          <select
            value={tabFilter}
            onChange={(e) => setTabFilter(e.target.value)}
            className="rounded-md border border-line px-2.5 py-1.5 text-[13px] outline-none focus-underline"
          >
            <option value="all">All tabs</option>
            {CUSTOM_TABS.filter((t) => t.acceptsFields).map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <span className="text-[12.5px] text-ink-400 tabular">
            {filtered.length} of {FIELDS.length}
          </span>
          <span className="ml-auto">
            <Button size="sm" variant="primary">
              + New field
            </Button>
          </span>
        </header>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-[13px]">
            <thead className="bg-canvas">
              <tr>
                {['Field', 'Type', 'Toggles', 'Tab in each module', 'Columns'].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-2 text-left text-[11.5px] font-semibold uppercase tracking-[.04em] text-ink-400"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f0f4f8]">
              {filtered.map((f) => (
                <tr key={f.id} className="align-top hover:bg-brand-50/50">
                  <td className="px-4 py-2.5">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-ink-900">{f.label}</span>
                      {f.system ? <OutlineChip icon="lock">System</OutlineChip> : null}
                      {f.sensitive ? <OutlineChip tone="warn">Sensitive</OutlineChip> : null}
                    </span>
                    {f.hint ? (
                      <span className="mt-0.5 block text-[11.5px] text-ink-400">{f.hint}</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium ${
                        UNSPECIFIED_TYPES.includes(f.type)
                          ? 'bg-[#fdf1d8] text-[#8a5a09]'
                          : 'bg-canvas text-ink-500'
                      }`}
                      title={
                        UNSPECIFIED_TYPES.includes(f.type)
                          ? 'Not in the specification’s list of 15 types'
                          : undefined
                      }
                    >
                      {f.type.replace(/_/g, ' ')}
                      {UNSPECIFIED_TYPES.includes(f.type) ? '*' : ''}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="flex flex-wrap gap-1">
                      {f.headerIn?.length ? (
                        <OutlineChip tone="brand">
                          Header{f.headerIn.length < MODULES.length ? ` (${f.headerIn.length})` : ''}
                        </OutlineChip>
                      ) : null}
                      {f.notes ? <OutlineChip>Notes</OutlineChip> : null}
                      {f.sync ? <OutlineChip tone="brand">Sync</OutlineChip> : null}
                      {f.readOnly ? <OutlineChip>Read-only</OutlineChip> : null}
                      {f.repeatGroup ? (
                        <OutlineChip tone="warn">Repeats ×{f.repeatGroup.max}</OutlineChip>
                      ) : null}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {/* ONE tab, globally. There is no per-module placement any more. */}
                    <span className="text-[12px] font-medium text-ink-700">
                      {describePlacement(f.tab)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {f.columnIn.length ? (
                      <span className="flex flex-wrap gap-1">
                        {f.columnIn.map((s) => (
                          <span
                            key={s}
                            className="rounded bg-canvas px-1.5 py-0.5 text-[11.5px] text-ink-500"
                          >
                            {MODULES.find((m) => m.slug === s)?.label}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="text-ink-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-panel border border-line bg-white p-4">
        <SectionLabel>Field types in use</SectionLabel>
        <div className="mt-3 flex flex-wrap gap-2">
          {typeCounts.map(([type, n]) => (
            <span
              key={type}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12.5px] ${
                UNSPECIFIED_TYPES.includes(type)
                  ? 'border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]'
                  : 'border-line bg-white text-ink-500'
              }`}
            >
              {type.replace(/_/g, ' ')}
              <span className="font-semibold tabular">{n}</span>
            </span>
          ))}
        </div>
        <p className="mt-2 text-[12px] text-ink-400">
          Amber types are the five the specification does not list.
        </p>
      </section>
    </div>
  );
}

/* ========================================================================== */
/* Integrations · Automations                                                  */
/* ========================================================================== */

function IntegrationsTab() {
  const items = [
    ['Outlook', 'Email into the Communication tab', 'Shell built'],
    ['Instantly', 'Campaign replies, labelled separately from Outlook', 'Shell built'],
    ['Teams', 'Meetings surface', 'Coming soon'],
    ['Phone (Twilio)', 'SMS, calls and recordings', 'Coming soon'],
    ['DocuSign', 'Gets its own tab once the specification arrives', 'Not specified'],
  ];
  return (
    <div className="space-y-4">
      <SpecNote>
        Integration tabs are rendered from configuration, not hardcoded — a new one is a row, not a
        release. The sync rules are locked now even though nothing is wired: multi-match deposits
        into <strong>all</strong> matching records, an existing sender never creates a new record,
        and sync is <strong>forward-only</strong> with no historical backfill.
      </SpecNote>
      <div className="grid gap-3 md:grid-cols-2">
        {items.map(([name, what, state]) => (
          <div key={name} className="rounded-panel border border-line bg-white p-4">
            <div className="flex items-center gap-2">
              <span className="text-[14.5px] font-semibold text-ink-900">{name}</span>
              {state === 'Shell built' ? (
                <StatusPill label={state} swatch="blue" dot={false} />
              ) : state === 'Coming soon' ? (
                <OutlineChip tone="warn">{state}</OutlineChip>
              ) : (
                <OutlineChip>{state}</OutlineChip>
              )}
            </div>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">{what}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function AutomationsTab() {
  return (
    <EmptyState
      title="Automations — shell only in this build"
      body="The future home of rules such as auto-adding a record to Deals on a status change, or auto-adding it to Tickets when a case opens. Both are on the deferred register; neither is specified yet."
    />
  );
}

/* ========================================================================== */
/* Recycle bin                                                                 */
/* ========================================================================== */

function RecycleBinTab() {
  const { records, restoreRecord } = useStore();
  const deleted = records.filter((r) => r.deleted);

  return (
    <div className="space-y-4">
      <SpecNote>
        Two things are <strong>never</strong> here, for two different reasons. Archived records are
        not deleted — they stay active in the Records List. And field text values overwrite in place,
        with every prior value readable in the activity log.
      </SpecNote>

      {deleted.length === 0 ? (
        <EmptyState
          title="The Recycle Bin is empty"
          body="Delete a record from the Records List to see it land here. Only archived records can be deleted."
        />
      ) : (
        <section className="overflow-hidden rounded-panel border border-line bg-white">
          <table className="w-full text-[13.5px]">
            <thead className="bg-canvas">
              <tr>
                {['Record', 'Type', 'Deleted', ''].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-2 text-left text-[11.5px] font-semibold uppercase tracking-[.04em] text-ink-400"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f0f4f8]">
              {deleted.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2.5 font-medium text-ink-900">{r.dealName}</td>
                  <td className="px-4 py-2.5 text-ink-500">Record</td>
                  <td className="px-4 py-2.5 text-ink-500">Recently</td>
                  <td className="px-4 py-2.5 text-right">
                    <span className="flex justify-end gap-2">
                      <Button size="sm" onClick={() => restoreRecord(r.id)}>
                        Restore
                      </Button>
                      <Button size="sm" variant="danger">
                        Purge
                      </Button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-line-soft px-4 py-2.5 text-[12px] text-ink-400">
            A restored record always returns <strong>archived</strong> — active in the Records List
            with zero display memberships. Restore is refused if the Deal Name would now collide with
            a live record.{' '}
            <Link
              href="/prototype/records"
              className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline"
            >
              Open the Records List
              <Icon name="arrow-right" size={12} />
            </Link>
          </p>
        </section>
      )}

      <div className="grid gap-3 md:grid-cols-3">
        <InfoCard title="What lands here">
          Records deleted from the Records List, files, updates and replies, login rows, users, and
          admin-deleted case content.
        </InfoCard>
        <InfoCard title="Who can reach it">
          Admins only. Unlike every other module, Recycle Bin access is not grantable through the
          permission system.
        </InfoCard>
        <InfoCard title="Cases">
          Case threads reach the bin through exactly one path — admin deletion. Non-admins can never
          delete case content, including their own.
        </InfoCard>
      </div>
    </div>
  );
}

/* ========================================================================== */

function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-white p-4">
      <h3 className="text-[13.5px] font-semibold text-ink-900">{title}</h3>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">{children}</p>
    </div>
  );
}

export { columnsFor };
