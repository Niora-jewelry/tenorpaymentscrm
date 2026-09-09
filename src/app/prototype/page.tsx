'use client';

/**
 * PROTOTYPE — the orientation page.
 *
 * The one screen that answers "what am I looking at". Everything it claims is
 * clickable somewhere else in the prototype, and every claim links to the place
 * that proves it.
 */
import Link from 'next/link';
import { MODULES, DISPLAY_MODULES, tabsForModule } from '@/proto/modules';
import { FIELDS, columnsFor } from '@/proto/fields';
import { CASES, RECORDS } from '@/proto/data';
import { CHANGELOG, LATEST_ENTRY } from '@/proto/changelog';
import { useStore } from '@/proto/store';
import { NewBadge, OutlineChip, SectionLabel } from '@/proto/ui/kit';
import { Icon, MODULE_ICON } from '@/proto/ui/icons';

export default function PrototypeHome() {
  const { records } = useStore();
  const live = records.filter((r) => !r.deleted);
  const archived = live.filter((r) => r.memberships.length === 0);
  const multi = live.filter((r) => r.memberships.length > 1);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1080px] px-6 py-10">
        {/* ---------------- hero ---------------- */}
        <p className="text-[12px] font-semibold uppercase tracking-[.14em] text-brand-600">
          TapDash CRM
        </p>
        <h1 className="mt-2 max-w-[22ch] text-[34px] font-semibold leading-[1.12] tracking-[-.02em] text-ink-900">
          One store of records. Six windows onto it.
        </h1>
        <p className="mt-4 max-w-[68ch] text-[15.5px] leading-relaxed text-ink-500">
          Every record in this CRM lives in exactly one place — the{' '}
          <strong className="text-ink-900">Records List</strong>. Leads, Deals, Contacts, Tickets and
          Residuals store nothing at all. Each is a configurable view onto that same store: which
          records it shows, which columns it lists, and how it arranges the fields in the drawer.
        </p>
        <p className="mt-3 max-w-[68ch] text-[15.5px] leading-relaxed text-ink-500">
          Everything below is real, clickable, and built on {FIELDS.length} fields transcribed from
          your own spreadsheet. The data is invented.
        </p>

        {/* ---------------- what's changed ---------------- */}
        <ChangelogSection />

        {/* ---------------- the diagram ---------------- */}
        <div className="mt-9 overflow-hidden rounded-panel border border-line bg-white">
          <div className="border-b border-line-soft px-5 py-3">
            <SectionLabel>How the pieces fit</SectionLabel>
          </div>
          <div className="p-5">
            <HubDiagram />
          </div>
        </div>

        {/* ---------------- the three properties ---------------- */}
        <div className="mt-9">
          <SectionLabel>Three things follow automatically — go and check them</SectionLabel>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <Claim
              n="1"
              title="One drawer, ordered per module"
              href="/prototype/leads"
              cta="Open a record in Leads, then the same one in Deals"
            >
              Every module shows the <strong>same tabs and the same fields</strong>. Leads puts
              Marketing third and Application fourth; Deals swaps them. That ordering is the only
              drawer difference between the two.
            </Claim>
            <Claim
              n="2"
              title="Selective display"
              href="/prototype/residuals"
              cta="Compare the Residuals columns to the Records List"
            >
              A field shown in one module need not appear in another. Residuals shows{' '}
              {columnsFor('residuals').length} columns; the Records List shows{' '}
              {columnsFor('records').length}. Same records underneath.
            </Claim>
            <Claim
              n="3"
              title="Nothing is lost by moving"
              href="/prototype/records"
              cta="Open a record, untick every module, then tick one again"
            >
              Remove a record from Leads and add it back a month later and every value reappears —
              because it never lived in Leads. It was always in the Records List.
            </Claim>
          </div>
        </div>

        {/* ---------------- vocabulary ---------------- */}
        <div className="mt-9 grid gap-3 md:grid-cols-2">
          <div className="rounded-panel border border-line bg-white p-5">
            <div className="flex items-center gap-2">
              <OutlineChip>Archive</OutlineChip>
              <span className="text-[13px] text-ink-400">available everywhere</span>
            </div>
            <p className="mt-3 text-[14px] leading-relaxed text-ink-500">
              Removing a record&rsquo;s <em>last</em> display membership. The record stays fully
              active in the Records List with every value, file, message and case intact. It has
              simply gone dark. The word &ldquo;delete&rdquo; never appears in this flow.
            </p>
            <p className="mt-2 text-[13px] text-ink-400 tabular">
              {archived.length} records are archived right now — visible only in the Records List.
            </p>
          </div>
          <div className="rounded-panel border border-[#f7cfd1] bg-[#fdf5f5] p-5">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded-full border border-[#f7cfd1] bg-[#fce9ea] px-2 py-[2.5px] text-[11.5px] font-semibold tracking-[.03em] text-[#b02a30]">
                Delete
              </span>
              <span className="text-[13px] text-[#b02a30]/70">Records List only</span>
            </div>
            <p className="mt-3 text-[14px] leading-relaxed text-ink-500">
              The true soft delete, to the Recycle Bin. It exists in exactly one module and is
              available <strong>only on records that are already archived</strong>. Try it on a
              record still showing in Deals and it is refused, with a message telling you to archive
              it first.
            </p>
          </div>
        </div>

        {/* ---------------- modules ---------------- */}
        <div className="mt-9">
          <SectionLabel>The modules</SectionLabel>
          <div className="mt-3 grid gap-2">
            {MODULES.map((m) => (
              <Link
                key={m.slug}
                href={`/prototype/${m.slug}`}
                className="group flex flex-wrap items-start gap-x-4 gap-y-2 rounded-xl border border-line bg-white p-4 transition-all duration-150 hover:border-brand-600 hover:shadow-[0_2px_10px_-4px_rgba(8,32,47,.2)]"
              >
                <span className="flex min-w-[150px] items-start gap-2.5">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700 transition-colors group-hover:bg-brand-100">
                    <Icon name={MODULE_ICON[m.slug] ?? 'database'} size={16} strokeWidth={1.9} />
                  </span>
                  <span>
                    <span className="block text-[15px] font-semibold text-ink-900 group-hover:text-brand-700">
                      {m.label}
                    </span>
                    <span className="mt-1 block">
                      {m.kind === 'storage' ? (
                        <OutlineChip tone="brand">Master store</OutlineChip>
                      ) : (
                        <OutlineChip>Display module</OutlineChip>
                      )}
                    </span>
                  </span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] leading-relaxed text-ink-500">{m.blurb}</span>
                  <span className="mt-2 flex flex-wrap gap-1.5">
                    {tabsForModule(m).map((t) => (
                      <span
                        key={t.id}
                        className={`rounded-md px-1.5 py-0.5 text-[11.5px] font-medium ${
                          t.system ? 'bg-canvas text-ink-400' : 'bg-brand-50 text-brand-700'
                        }`}
                        title={t.system ? 'Locked system tab' : 'Admin-created tab'}
                      >
                        {t.label}
                      </span>
                    ))}
                  </span>
                </span>
                <span className="shrink-0 text-right text-[12px] text-ink-400 tabular">
                  {columnsFor(m.slug).length} columns
                  <br />
                  {m.pipelines.length ? `${m.pipelines[0]!.steps.length}-step pipeline` : 'no pipeline'}
                </span>
              </Link>
            ))}
          </div>
        </div>

        {/* ---------------- what to try ---------------- */}
        <div className="mt-9 rounded-panel border border-line bg-white p-5">
          <SectionLabel>Five things worth trying</SectionLabel>
          <ol className="mt-3 space-y-3 text-[14px] leading-relaxed text-ink-500">
            <Try n="1" href="/prototype/records">
              <strong>Scroll the Records List sideways.</strong> Deal Name stays frozen on the left
              and grows a shadow; the scrollbar stays pinned to the bottom of the screen instead of
              hiding below 50 rows.
            </Try>
            <Try n="2" href="/prototype/deals">
              <strong>Change who you are.</strong> Top right, switch from Super admin to Sales rep.
              The Records List vanishes from the nav, the row count drops to their own records, and
              the SSN and bank columns disappear entirely — absent, not blanked.
            </Try>
            <Try n="3" href="/prototype/records">
              <strong>Open a record and use &ldquo;In modules → Change&rdquo;.</strong> Tick Deals
              and it appears in Deals instantly. Untick everything and the button says{' '}
              <em>Archive</em>, never Delete.
            </Try>
            <Try n="4" href="/prototype/tickets">
              <strong>Look at a case.</strong> Numbers run from #10000 across the whole system.
              Closing one is blocked until a Solution has been written.
            </Try>
            <Try n="5" href="/prototype/records">
              <strong>Select several rows and bulk edit.</strong> Only fields you can edit appear at
              all, and anything skipped is listed back to you with a reason.
            </Try>
          </ol>
        </div>

        {/* ---------------- footprint ---------------- */}
        <div className="mt-9 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat n={live.length} label="sample records" />
          <Stat n={FIELDS.length} label="fields, from your spreadsheet" />
          <Stat n={multi.length} label="records in 2+ modules at once" />
          <Stat n={CASES.length} label="cases, numbered from #10000" />
        </div>

        <p className="mt-8 max-w-[70ch] text-[13px] leading-relaxed text-ink-400">
          Nothing here is saved. Refreshing the page resets every change. No database is connected,
          and this whole section refuses to run in a production build. What it does share with the
          real product is its structure: {DISPLAY_MODULES.length} display modules and{' '}
          {RECORDS.length} records are rendered by one screen and one drawer, reading configuration —
          exactly as the real modules will.
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * "What's changed" — the direct answer to "this CRM is too big, I don't know
 * what changed or where." Reads `src/proto/changelog.ts` — the same file that
 * drives every "New" badge elsewhere — so this list and those badges can
 * never say two different things. Newest first; the newest entry is expanded
 * by default since that is the one someone opening this page actually wants.
 */
function ChangelogSection() {
  return (
    <div className="mt-9 overflow-hidden rounded-panel border border-line bg-white">
      <div className="flex items-center gap-2 border-b border-line-soft px-5 py-3">
        <SectionLabel>What&rsquo;s changed</SectionLabel>
        <span className="text-[12px] text-ink-400">
          {CHANGELOG.length} dated {CHANGELOG.length === 1 ? 'entry' : 'entries'}
        </span>
      </div>
      <ul className="divide-y divide-line-soft">
        {CHANGELOG.map((entry) => (
          <li key={entry.id} className="p-5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-mono text-[12px] tabular text-ink-400">
                {formatChangelogDate(entry.date)}
              </span>
              <h3 className="text-[15px] font-semibold text-ink-900">{entry.title}</h3>
              {entry.id === LATEST_ENTRY.id ? <NewBadge /> : null}
            </div>
            <p className="mt-2 max-w-[74ch] text-[13.5px] leading-relaxed text-ink-500">
              {entry.summary}
            </p>
            {entry.links.length ? (
              <ul className="mt-3 flex flex-wrap gap-2">
                {entry.links.map((link) => (
                  <li key={link.href + link.label}>
                    <Link
                      href={link.href}
                      className="group inline-flex items-center gap-1 rounded-full border border-line bg-white px-2.5 py-1 text-[12px] font-medium text-brand-700 transition-colors hover:border-brand-600 hover:bg-brand-50"
                    >
                      {link.label}
                      <Icon
                        name="arrow-right"
                        size={11}
                        className="transition-transform duration-150 group-hover:translate-x-0.5"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatChangelogDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${String(d.getUTCDate()).padStart(2, '0')} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function HubDiagram() {
  return (
    <div className="overflow-x-auto">
      <svg viewBox="0 0 860 260" className="h-auto w-full min-w-[720px]" role="img"
        aria-label="Records List at the centre, with five display modules projecting from it">
        <defs>
          <linearGradient id="hub" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#1e3a8a" />
            <stop offset="55%" stopColor="#1d4ed8" />
            <stop offset="100%" stopColor="#2563eb" />
          </linearGradient>
        </defs>

        {/* connectors */}
        {[
          [120, 200],
          [285, 200],
          [450, 200],
          [615, 200],
          [780, 200],
        ].map(([x], i) => (
          <path
            key={i}
            d={`M 430 96 C 430 140, ${x} 140, ${x} 176`}
            fill="none"
            stroke="#c7dcfb"
            strokeWidth="1.5"
          />
        ))}

        {/* hub */}
        <rect x="270" y="24" width="320" height="72" rx="14" fill="url(#hub)" />
        <text x="430" y="55" textAnchor="middle" fill="#ffffff" fontSize="17" fontWeight="600">
          Records List
        </text>
        <text x="430" y="76" textAnchor="middle" fill="#c7dcfb" fontSize="12.5">
          every record · every value · every file · all history
        </text>

        {/* projections */}
        {[
          ['Leads', 120],
          ['Deals', 285],
          ['Contacts', 450],
          ['Tickets', 615],
          ['Residuals', 780],
        ].map(([label, x]) => (
          <g key={label as string}>
            <rect
              x={(x as number) - 72}
              y="176"
              width="144"
              height="56"
              rx="12"
              fill="#ffffff"
              stroke="#d9e3ec"
            />
            <text
              x={x as number}
              y="200"
              textAnchor="middle"
              fill="#08202f"
              fontSize="13.5"
              fontWeight="600"
            >
              {label as string}
            </text>
            <text x={x as number} y="218" textAnchor="middle" fill="#6b8699" fontSize="11">
              stores nothing
            </text>
          </g>
        ))}
      </svg>
      <p className="mt-3 max-w-[80ch] text-[13px] leading-relaxed text-ink-400">
        The arrows point one way on purpose. A display module decides{' '}
        <em>which records it shows</em> and <em>how it arranges them</em> — nothing more. Storing a
        value, a file or a message &ldquo;in&rdquo; Leads would be an architecture violation.
      </p>
    </div>
  );
}

function Claim({
  n,
  title,
  href,
  cta,
  children,
}: {
  n: string;
  title: string;
  href: string;
  cta: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col rounded-xl border border-line bg-white p-4">
      <span className="grid size-6 place-items-center rounded-full bg-brand-950 text-[12px] font-bold text-accent">
        {n}
      </span>
      <h3 className="mt-3 text-[14.5px] font-semibold text-ink-900">{title}</h3>
      <p className="mt-1.5 flex-1 text-[13px] leading-relaxed text-ink-500">{children}</p>
      <Link
        href={href}
        className="group mt-3 inline-flex items-start gap-1 text-[12.5px] font-semibold text-brand-700 underline-offset-2 hover:underline"
      >
        {cta}
        <Icon
          name="arrow-right"
          size={12}
          className="mt-0.5 shrink-0 transition-transform duration-150 group-hover:translate-x-0.5"
        />
      </Link>
    </div>
  );
}

function Try({ n, href, children }: { n: string; href: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-canvas text-[11px] font-bold text-ink-500">
        {n}
      </span>
      <span>
        {children}{' '}
        <Link
          href={href}
          className="group inline-flex items-center gap-1 font-semibold text-brand-700 underline-offset-2 hover:underline"
        >
          Try it
          <Icon
            name="arrow-right"
            size={12}
            className="transition-transform duration-150 group-hover:translate-x-0.5"
          />
        </Link>
      </span>
    </li>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="rounded-xl border border-line bg-white px-4 py-3">
      <p className="text-[24px] font-semibold tracking-[-.02em] text-ink-900 tabular">{n}</p>
      <p className="mt-0.5 text-[12.5px] leading-snug text-ink-400">{label}</p>
    </div>
  );
}
