/**
 * The module dashboard + drawer, in one URL-addressable route:
 * `/{module}` lists records, `/{module}?record={id}` opens one.
 *
 * The dashboard grid, the drawer sheet, the field grid, and the pipeline bar
 * all reuse the prototype's actual `src/proto/ui/*` components/visual design
 * (MODULE-2-PLAN's own build order: "evolve, don't restart") — adapted to
 * real network calls against the real database. What's left in plain HTML
 * (Files/Logins/Statements/Communication tabs, repeat groups) says so
 * explicitly where it renders, rather than pretending to be finished.
 */
import { Suspense } from 'react';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { Icon } from '@/proto/ui/icons';
import { CellValue } from '@/proto/ui/value';
import { authorize, moduleGrant, fieldGrants, tabGrants, subtabGrants, capGrant } from '@/lib/records/permissions';
import {
  loadConfig, moduleBySlug, columnsForModule, fieldsInTab, fieldsInRepeatGroup, tabsForModule, subtabsForModule,
  headerFieldsForModule, pipelinesForModule, stepsForPipeline, pipelineStatusFields, type Field,
} from '@/lib/records/config';
import { repeatInstanceCount } from '@/lib/records/repeatGroups';
import { listRecords, getRecord } from '@/lib/records/records';
import { membershipsFor, membershipsForMany } from '@/lib/records/memberships';
import { pipelineAssignment } from '@/lib/records/pipelines';
import { entriesFor } from '@/lib/records/customEntries';
import { casesFor, repliesForCases, managersForCases } from '@/lib/records/cases';
import { attachmentsForCases } from '@/lib/records/caseAttachments';
import { updatesFor, teamRosterFor } from '@/lib/records/updates';
import { ensureApplicationRows, fileRowsFor, filesForRows } from '@/lib/records/files';
import { loginsFor } from '@/lib/records/logins';
import { allPeriods, filesForRecord } from '@/lib/records/statements';
import { messagesFor } from '@/lib/records/messages';
import { allNotesFor } from '@/lib/records/notes';
import type { Note } from '@/lib/records/notes';
import { profileNamesFor } from '@/lib/records/users';
import { columnOrderFor, filtersFor, fieldOrderFor } from '@/lib/records/preferences';
import { resolveOrder } from '@/lib/records/preferences';
import { adaptFieldForDashboard, adaptRecordRow, adaptFieldForDrawer } from '@/lib/records/adapter';
import { CreateRecordDialog } from './CreateRecordDialog';
import { MembershipsForm, ArchiveButton } from './MembershipsForm';
import { RecordsTable } from './RecordsTable';
import { DrawerTabs, type TabPayload, type RepeatGroupDef } from './DrawerTabs';
import { DrawerShell } from './DrawerShell';
import { RealPipelineBar } from './RealPipelineBar';
import type { FileRow, FileEntry } from '@/lib/records/files';

export default async function ModulePage({
  params,
  searchParams,
}: {
  params: Promise<{ module: string }>;
  searchParams: Promise<{ record?: string; page?: string }>;
}) {
  const { module: slug } = await params;
  const { record: recordId, page: pageParam } = await searchParams;

  // `page` was never read, so `listRecords` always returned page 0 and every
  // record past the first 50 (ordered by Deal Name) was unreachable from any
  // screen — while the header cheerfully reported "page 1 of 7". Clamped at 0
  // so a hand-edited or stale URL cannot ask for a negative offset.
  const requestedPage = Math.max(0, Number.parseInt(pageParam ?? '0', 10) || 0);

  const ctx = await authorize();
  const config = await loadConfig();
  const mod = moduleBySlug(config, slug);
  if (!mod) notFound();

  // Started here and awaited inside `RecordDrawer`, NOT awaited now.
  //
  // The Suspense boundary further down lets the page flush before the drawer's
  // data is ready, which fixes the dead click — but on its own it does not make
  // the drawer arrive any sooner, because `RecordDrawer` is not even
  // constructed until this function's own four waves of queries have finished.
  // Kicking the record read off here overlaps it with the dashboard's, so the
  // drawer's chain starts at the same moment the list's does instead of after
  // it. It also warms the per-request grant set (`getRecord` resolves hidden
  // fields), which everything below then reads for free.
  //
  // The bare `.catch` parks the rejection so an unawaited promise cannot raise
  // an unhandled rejection between here and the `await` in `RecordDrawer` —
  // that `await` still sees the original rejection and still throws it, into
  // the Suspense boundary where it belongs.
  const recordPromise = recordId ? getRecord(ctx, recordId) : null;
  recordPromise?.catch(() => {});

  // `moduleGrant`, the saved column order and the saved filters are three
  // independent reads with no dependency between them. Awaiting them one after
  // another simply added their latencies together — worth ~3 round trips on a
  // remote database, on every single page load, for no reason.
  const [grant, savedColumnOrder, savedFilters] = await Promise.all([
    moduleGrant(ctx, mod.id, mod.adminOnly),
    columnOrderFor(ctx, mod.id),
    filtersFor(ctx, mod.id),
  ]);
  if (grant === 'hidden') redirect('/dashboard');

  // Layer 1 (admin order + selection) → layer 2 (this user's saved order) —
  // "admin default → user override → permission filter" (§16). Layer 3
  // (hidden fields absent) is `fieldGrants` below.
  const adminColumns = columnsForModule(config, mod.id);
  const orderedColumnIds = resolveOrder(adminColumns.map((f) => f.id), savedColumnOrder);
  const columnById = new Map(adminColumns.map((f) => [f.id, f]));
  const orderedDbColumns = orderedColumnIds.map((id) => columnById.get(id)).filter((f): f is Field => Boolean(f));

  const grants = await fieldGrants(ctx, orderedDbColumns);
  const visibleDbColumns = orderedDbColumns.filter((f) => grants.get(f.id) !== 'hidden');
  const columns = visibleDbColumns.map((f) => adaptFieldForDashboard(config, f));
  // Capped by the module grant — a field's own grant decides what it is at
  // most, the module decides the ceiling. See `capGrant`.
  const grantByKey = Object.fromEntries(
    visibleDbColumns.map((f) => [f.key, capGrant(grant, grants.get(f.id) ?? 'edit')]),
  );

  /*
   * The dashboard's pipeline/step filter — Admin §3.6, "module dashboards can
   * be filtered by pipeline, and by step via the synced Status field".
   *
   * Both halves are filters on the pipeline's synced Status field (migration
   * 57), so nothing here is a second filtering mechanism: the control writes an
   * ordinary saved filter and `listRecords` applies it in the database with
   * every other filter.
   *
   * A pipeline whose synced field this viewer may not see is dropped, so the
   * control cannot offer a filter the permission layer would then refuse — the
   * same "absent, never blank" rule the columns follow. `fieldGrants` is a
   * per-request lookup already warmed above, so this costs nothing extra.
   */
  const modulePipelinesRaw = pipelinesForModule(config, mod.id);
  const statusFieldById = new Map(config.fields.map((f) => [f.id, f]));
  const pipelineStatusDbFields = modulePipelinesRaw
    .map((p) => (p.statusFieldId ? statusFieldById.get(p.statusFieldId) : undefined))
    .filter((f): f is Field => Boolean(f));
  const statusGrants = await fieldGrants(ctx, pipelineStatusDbFields);
  const pipelineFilterOptions = modulePipelinesRaw
    .filter((p) => p.statusFieldId && statusGrants.get(p.statusFieldId) !== 'hidden')
    .map((p) => ({
      id: p.id,
      label: p.label,
      statusFieldKey: statusFieldById.get(p.statusFieldId!)!.key,
      steps: stepsForPipeline(config, p.id).map((st) => ({
        id: st.id,
        label: st.label,
        swatch: st.swatch as import('@/proto/schema').Swatch,
      })),
    }));
  const pipelineStatusFilterFields = pipelineStatusDbFields
    .filter((f) => statusGrants.get(f.id) !== 'hidden')
    .map((f) => adaptFieldForDashboard(config, f));

  const { rows: dbRows, total, page, pageCount } = await listRecords(ctx, mod.id, {
    filters: Object.values(savedFilters),
    page: requestedPage,
  });
  const membershipsByRecord = await membershipsForMany(ctx, dbRows.map((r) => r.id));
  const moduleSlugById = new Map(config.modules.map((m) => [m.id, m.slug]));
  const rows = dbRows.map((r) =>
    adaptRecordRow(
      r,
      (membershipsByRecord[r.id] ?? []).map((id) => moduleSlugById.get(id)).filter((s): s is string => Boolean(s)),
    ),
  );

  return (
    <div className="flex h-full flex-col p-6">
      {/*
        The page header. Three jobs, in order of how often they are needed:
        say where you are, say how much is here, and offer the one primary
        action. The record count moved off its own line and onto the title's
        baseline as a pill — a number that changes with every filter belongs
        next to the thing it counts, not underneath it as a sentence.
      */}
      <div className="mb-4 flex shrink-0 items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="truncate text-[22px] font-semibold leading-tight tracking-[-.02em] text-ink-900">
              {mod.label}
            </h1>
            <span className="shrink-0 rounded-full bg-canvas px-2 py-[3px] text-[11.5px] font-semibold tabular text-ink-500 ring-1 ring-inset ring-line">
              {total.toLocaleString()}
            </span>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[12.5px] text-ink-400">
            <span>
              Page {page + 1} of {pageCount}
            </span>
            {/* Configured column count vs. what this viewer may see — the gap
                IS the permission system, visible at a glance (prototype
                parity). Demoted from the top-right, where it sat with the same
                weight as the primary action while being a fact almost nobody
                needs, to the end of the subtitle where it reads as context. */}
            <span aria-hidden className="text-line">·</span>
            <span>
              {columns.length} of {adminColumns.length} columns visible to you
            </span>
          </p>
        </div>
        {grant === 'edit' ? (
          <span className="shrink-0">
            <CreateRecordDialog moduleSlug={slug} moduleLabel={mod.label} viewerId={ctx.userId} />
          </span>
        ) : null}
      </div>

      {/* Bounded + flex-col so DataTable's own `min-h-0 flex-1` grid actually
          gets a height to fill — without this, the table grows to its full
          content height and the WHOLE page (title, toolbar, everything)
          scrolls together, instead of just the rows under a sticky header. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <RecordsTable
          moduleSlug={slug}
          moduleId={mod.id}
          rows={rows}
          columns={columns}
          grantByKey={grantByKey}
          displayModules={config.modules
            .filter((m) => m.kind === 'display')
            .map((m) => ({ id: m.id, slug: m.slug, label: m.label }))}
          hasCustomColumnOrder={Boolean(savedColumnOrder?.length)}
          filters={savedFilters}
          pipelines={pipelineFilterOptions}
          pipelineStatusFields={pipelineStatusFilterFields}
          canEdit={grant === 'edit'}
          page={page}
          pageCount={pageCount}
          total={total}
        />
      </div>

      {/*
        The sheet is OUTSIDE the Suspense boundary and its contents are inside.
        That split is the whole point: `RecordDrawer` below is an async Server
        Component with a dozen dependent queries behind it, and without a
        boundary React cannot flush ANY of this page until every one of them has
        resolved. On the live remote database that was several seconds during
        which clicking a row did nothing observable at all — no sheet, no
        spinner, no change of any kind, which reads as a broken click rather
        than a slow one, so people click again.

        With the boundary, the sheet, its backdrop and the skeleton paint in the
        first flush and the real content streams in behind them. The Escape key
        and the backdrop close it while it is still loading, because
        `DrawerShell` is a Client Component that owns those and no longer waits
        on the data.

        `key={recordId}` remounts the boundary when the user opens a DIFFERENT
        record from an already-open drawer — without it React keeps the resolved
        subtree on screen and the drawer shows the previous record's data until
        the new one lands.
      */}
      {recordId ? (
        <DrawerShell moduleSlug={slug}>
          <Suspense key={recordId} fallback={<DrawerSkeleton />}>
            <RecordDrawer
              moduleSlug={slug}
              moduleId={mod.id}
              recordPromise={recordPromise!}
              grant={grant}
            />
          </Suspense>
        </DrawerShell>
      ) : null}
    </div>
  );
}

/**
 * Shown in the sheet when `?record=…` names something this viewer cannot open.
 *
 * Deliberately does not distinguish "deleted" from "you no longer have access":
 * saying which one it is tells someone without access that the record exists,
 * which is the disclosure the record-visibility rules exist to prevent. The
 * wording covers both without confirming either.
 */
function RecordUnavailable({ moduleSlug }: { moduleSlug: string }) {
  return (
    <section className="flex min-h-full flex-col bg-white px-6 py-5">
      <div className="flex justify-end">
        <Link
          href={`/${moduleSlug}`}
          title="Close"
          aria-label="Close"
          className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-400 transition-colors duration-150 hover:bg-canvas hover:text-ink-900"
        >
          <Icon name="x" size={16} />
        </Link>
      </div>
      <div className="flex flex-1 items-center justify-center pb-16">
        <div className="max-w-sm text-center">
          <div className="mx-auto grid size-10 place-items-center rounded-full bg-canvas text-ink-400">
            <Icon name="search" size={18} />
          </div>
          <h2 className="mt-3 text-[15px] font-semibold text-ink-900">This record isn&rsquo;t available</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
            It may have been deleted, or it may no longer be shared with you. Ask whoever sent you
            the link if you still need it.
          </p>
          <Link
            href={`/${moduleSlug}`}
            className="mt-4 inline-flex rounded-lg border border-line px-3 py-1.5 text-[13px] font-semibold text-ink-700 transition-colors hover:bg-canvas"
          >
            Back to the list
          </Link>
        </div>
      </div>
    </section>
  );
}

/**
 * What fills the sheet while the record loads.
 *
 * Deliberately shaped like the real drawer — title block, membership strip,
 * pipeline bar, tab strip, field grid — rather than a centred spinner. The
 * layout does not jump when the content arrives, and the shape itself tells
 * the user what is coming. `animate-pulse` is the only motion; a spinner in a
 * panel this large reads as "stuck" rather than "loading".
 */
function DrawerSkeleton() {
  return (
    <section className="min-h-full bg-white px-6 py-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading record…</span>
      <div className="space-y-4">
        <div className="flex items-start justify-between">
          <div className="space-y-2">
            <div className="h-6 w-64 skeleton" />
            <div className="flex gap-2.5">
              <div className="h-3.5 w-28 skeleton" />
              <div className="h-3.5 w-20 skeleton" />
              <div className="h-3.5 w-24 skeleton" />
            </div>
          </div>
          <div className="size-8 skeleton rounded-lg" />
        </div>

        <div className="h-10 rounded-lg border border-line-soft bg-canvas/60" />
        <div className="h-14 rounded-lg border border-line-soft bg-canvas/60" />

        <div className="flex gap-5 border-b border-line pb-2.5">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-3.5 w-20 skeleton" />
          ))}
        </div>

        <div className="overflow-hidden rounded-xl border border-line">
          <div className="flex flex-wrap">
            {Array.from({ length: 12 }).map((_, i) => (
              <div
                key={i}
                className="flex-1 border-b border-r border-line-soft px-3 py-3 last:border-r-0"
                style={{ flex: '1 1 250px', minWidth: '250px' }}
              >
                <div className="mb-2 h-2.5 w-20 skeleton" />
                <div className="h-4 w-36 skeleton" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

async function RecordDrawer({
  moduleSlug,
  moduleId,
  recordPromise,
  grant,
}: {
  moduleSlug: string;
  moduleId: string;
  /** Started by `ModulePage` before it awaited its own queries, so this read
   *  overlaps the dashboard's instead of queueing behind it. Awaited here, so
   *  a failure lands inside the Suspense boundary and takes only the drawer. */
  recordPromise: Promise<Awaited<ReturnType<typeof getRecord>>>;
  grant: 'view' | 'edit';
}) {
  const [ctx, config, record] = await Promise.all([authorize(), loadConfig(), recordPromise]);
  // `getRecord` legitimately returns null: the record was deleted, or this
  // viewer was removed from its team. Returning `null` here rendered a
  // full-height blank white sheet with no title, no message and no close
  // button — the "×" lives inside the subtree that was skipped — so a stale
  // bookmark or a shared link looked like the app had hung.
  if (!record) return <RecordUnavailable moduleSlug={moduleSlug} />;

  /*
   * ⚠️ TAB GRANTS ARE RESOLVED BEFORE ANYTHING IS FETCHED, and that ordering is
   * the whole point of this block.
   *
   * They used to be computed AFTER the fetch below, purely to decide which tab
   * buttons to draw. So a tab set to Hidden lost its button while its CONTENT
   * was still read from the database and serialised into the RSC payload —
   * case threads, update posts, login usernames and notes, message bodies,
   * statement metadata, notes. Absent from the screen, present in the page
   * source. That is exactly the failure CLAUDE.md rule 3 names: "the data sits
   * in the page, readable with browser developer tools."
   *
   * Now a hidden tab is never queried at all. Every system-tab read below is
   * gated on its own tab being visible, so "absent, never blank" holds for the
   * data as well as the layout.
   *
   * Passwords were never part of this: `password_enc` is not selectable by the
   * request-scoped client at the column-grant level (migration 12).
   */
  const allTabs = tabsForModule(config, moduleId);
  const rawTabGrants = await tabGrants(ctx, allTabs.map((t) => t.id));
  const tabGrantById = new Map(
    allTabs.map((t) => [t.id, capGrant(grant, rawTabGrants.get(t.id) ?? 'edit')] as const),
  );
  const dbTabs = allTabs.filter((t) => tabGrantById.get(t.id) !== 'hidden');

  /*
   * Subtab grants, capped under their own tab. A scope only since migration
   * 50 — the client's §8 always asked for "tab/subtab access", but there was
   * no fourth `grant_scope` value, so nineteen subtabs could previously only
   * be restricted by hiding their whole parent tab or by granting every field
   * inside them one at a time. Application → Private (EIN, account and routing
   * numbers, owner SSNs) is the case that made that worth closing.
   *
   * Capped, not independent: a subtab can restrict further than its tab, never
   * re-open what the tab closed.
   */
  const allSubtabs = dbTabs.flatMap((t) => subtabsForModule(config, moduleId, t.id));
  const rawSubtabGrants = await subtabGrants(ctx, allSubtabs.map((s) => s.id));
  const subtabGrantById = new Map(
    allSubtabs.map((s) => [
      s.id,
      capGrant(tabGrantById.get(s.tabId) ?? 'hidden', rawSubtabGrants.get(s.id) ?? 'edit'),
    ] as const),
  );

  /** Is the tab of this kind visible to this viewer? System tabs are one per
   *  module, so `kind` identifies them unambiguously. */
  const shows = (kind: string) => dbTabs.some((t) => t.kind === kind);

  const [
    memberships, entries, cases, updates, pipelineAssign,
    applicationRows, otherRows, logins, statementPeriods, statementFiles,
    messages, notesByScope, teamRoster,
  ] = await Promise.all([
    membershipsFor(ctx, record.id),
    shows('freeform') ? entriesFor(ctx, record.id) : [],
    shows('cases') ? casesFor(ctx, record.id) : [],
    shows('updates') ? updatesFor(ctx, record.id) : [],
    pipelineAssignment(ctx, record.id, moduleId),
    // `ensureApplicationRows` must finish before the Application rows are read
    // — it is what creates the 5 locked rows on a record's first-ever open, and
    // reading in parallel with it would return an empty Files tab that time.
    // Chained rather than awaited up front so the pair still overlaps with the
    // other independent fetches instead of blocking all of them. Skipped
    // entirely when Files is hidden, which also avoids a WRITE for a tab the
    // viewer cannot open.
    shows('files')
      ? ensureApplicationRows(ctx, record.id).then(() => fileRowsFor(ctx, record.id, 'application'))
      : [],
    shows('files') ? fileRowsFor(ctx, record.id, 'other') : [],
    shows('logins') ? loginsFor(ctx, record.id) : [],
    shows('statements') ? allPeriods() : [],
    shows('statements') ? filesForRecord(ctx, record.id) : [],
    shows('communication') ? messagesFor(ctx, record.id) : [],
    allNotesFor(ctx, record.id),
    shows('updates') ? teamRosterFor(ctx, record.id) : [],
  ]);

  const fileRows: FileRow[] = [...applicationRows, ...otherRows];
  // One `.in()` query for every row's files, not one query per row. There are
  // never fewer than the 5 locked Application rows, so the old per-row map was
  // a guaranteed floor of 5 round trips even on a record with no files at all.
  const filesByRow: Record<string, FileEntry[]> = await filesForRows(ctx, fileRows.map((r) => r.id));

  // `fieldId -> pipelineId` for every generated Status field, used twice below:
  // to keep each one off the records that are not on its pipeline, and to keep
  // all of them out of the drawer's completeness ratio.
  const statusFieldOwners = pipelineStatusFields(config);

  const modulePipelines = pipelinesForModule(config, moduleId).map((p) => ({
    id: p.id,
    label: p.label,
    steps: stepsForPipeline(config, p.id).map((s) => ({
      id: s.id,
      label: s.label,
      swatch: s.swatch as import('@/proto/schema').Swatch,
    })),
  }));

  // Two queries total, and they run together. This was two SEQUENTIAL waves of
  // one query per case: the replies wave had to finish before the managers
  // wave began, so a record with six cases cost twelve round trips in series.
  const [repliesByCase, managersByCase, attachmentsByCase] = await Promise.all([
    repliesForCases(ctx, cases.map((c) => c.id)),
    managersForCases(ctx, cases.map((c) => c.id)),
    // Modules §3.7's Issue/Solution/reply attachments, in the same wave. Two
    // queries for the whole tab rather than one per attachment point, which on
    // a record with six cases and four replies each would be thirty.
    attachmentsForCases(ctx, record.id, cases.map((c) => c.id)),
  ]);

  // One name lookup for every author across notes/updates/cases/entries —
  // profile_names() (migration 28) is the only path to a teammate's display
  // name, so this is the single round trip everything below reads from.
  const authorIds = new Set<string>();
  for (const notes of notesByScope.values()) for (const n of notes) authorIds.add(n.authorId);
  for (const u of updates) {
    authorIds.add(u.authorId);
    for (const m of u.mentionedUserIds) authorIds.add(m);
  }
  for (const c of cases) {
    authorIds.add(c.issueAuthor);
    if (c.solutionAuthor) authorIds.add(c.solutionAuthor);
    if (c.editedBy) authorIds.add(c.editedBy);
  }
  for (const replies of Object.values(repliesByCase)) for (const r of replies) authorIds.add(r.authorId);
  for (const managers of Object.values(managersByCase)) for (const m of managers) authorIds.add(m);
  for (const e of entries) authorIds.add(e.createdBy);

  const authorNameMap = await profileNamesFor(ctx, Array.from(authorIds));
  const authorNames = Object.fromEntries(authorNameMap) as Record<string, string>;

  const headerFields = headerFieldsForModule(config, moduleId);

  // The tab half of the grant chain. A tab resolved to Hidden is dropped from
  // the strip entirely rather than rendered empty — "absent, never blank"
  // (CLAUDE.md §3), and it is the ONLY permission that can restrict Cases,
  // Files, Logins, Statements, Updates or Communication, none of which are
  // made of fields.

  // One grant lookup for every field across every tab/subtab, keyed by the
  // adapted (key-based) field id — the same shape RealFieldGrid consumes.
  const allTabFields = dbTabs.flatMap((t) => fieldsInTab(config, t.id));
  const grants = await fieldGrants(ctx, allTabFields);
  const grantByKey: Record<string, 'hidden' | 'view' | 'edit'> = {};
  // Capped by module THEN tab: without this a module or tab set to View still
  // handed the drawer a page of Edit fields, because the three scopes resolve
  // independently and an unset field is Edit.
  for (const f of allTabFields) {
    // module → tab → SUBTAB → field. Each level can only narrow the one above
    // it, which is what makes a View subtab hand the drawer read-only fields
    // even where the field's own grant says Edit.
    const above = f.subtabId
      ? (subtabGrantById.get(f.subtabId) ?? 'hidden')
      : (tabGrantById.get(f.tabId) ?? 'hidden');
    grantByKey[f.key] = capGrant(above, grants.get(f.id) ?? 'hidden');
  }

  /*
   * Notes are fetched in ONE query for the whole record (`allNotesFor`), which
   * is right for latency and wrong for disclosure if handed over unfiltered: a
   * note on a hidden tab, or attached to a hidden field, would ride into the
   * page payload with everything else.
   *
   * Keys are `${scopeKind}:${scopeId}` — `field:<field key>` for a field note,
   * `tab:<tabId>` or `tab:<tabId>/<subtabId>` for a tab note. Both are checked
   * against what this viewer may actually see, so the same "absent, never
   * blank" rule the fields themselves follow applies to their notes.
   */
  const visibleTabIds = new Set(dbTabs.map((t) => t.id));
  const notesByScopeObj = Object.fromEntries(
    Array.from(notesByScope.entries()).filter(([key]) => {
      const [kind, ...rest] = key.split(':');
      const scopeId = rest.join(':');
      if (kind === 'tab') return visibleTabIds.has(scopeId.split('/')[0] ?? '');
      if (kind === 'field') return grantByKey[scopeId] !== undefined && grantByKey[scopeId] !== 'hidden';
      return false;
    }),
  ) as Record<string, Note[]>;

  const tabs: TabPayload[] = await Promise.all(dbTabs.map(async (t) => {
    // A Hidden subtab is dropped from the strip, exactly as a Hidden tab is —
    // "absent, never blank". Its fields are then never built below either,
    // because `buildFor` only runs for the subtabs that survive this filter.
    const subtabs = subtabsForModule(config, moduleId, t.id)
      .filter((s) => subtabGrantById.get(s.id) !== 'hidden')
      .map((s) => ({
        id: s.id, key: s.key, label: s.label, description: s.description, comingSoon: s.comingSoon,
      }));

    const fieldsBySubtab: Record<string, ReturnType<typeof adaptFieldForDrawer>[]> = {};
    const repeatGroupsBySubtab: Record<string, RepeatGroupDef[]> = {};
    const hasCustomFieldOrderBySubtab: Record<string, boolean> = {};
    // "How many fields are filled" per tab (prototype-style completeness
    // badge, 19 Aug UI ask) — counted across every subtab of this tab, plain
    // fields only (a repeat_group's own instance count already renders via
    // `RepeatGroupDef.count`/`max`, so folding it into this ratio too would
    // double-count the same completeness signal two different ways).
    let fieldsHave = 0;
    let fieldsNeed = 0;
    if (t.kind === 'custom') {
      const buildFor = async (subtabId: string | null, slotKey: string) => {
        const visible = fieldsInTab(config, t.id, subtabId)
          .filter((f) => grants.get(f.id) !== 'hidden')
          // Admin §3.6: "That Status field is visible only on records assigned
          // to that pipeline." A synced Status field is an ordinary field row
          // with an ordinary tab, so nothing else would keep it off the other
          // records — and on those it would render empty, offering the steps of
          // a process the record is not in. Dropped rather than disabled, which
          // is the same "absent, never blank" rule hidden fields follow.
          .filter((f) => {
            const owner = statusFieldOwners.get(f.id);
            return owner === undefined || owner === pipelineAssign?.pipelineId;
          });
        const plain = visible.filter((f) => f.type !== 'repeat_group');
        fieldsNeed += plain.length;
        fieldsHave += plain.filter((f) => {
          const v = record.values[f.key];
          if (v == null || v === '') return false;
          if (Array.isArray(v)) return v.length > 0;
          if (typeof v === 'object') return Object.keys(v).length > 0;
          return true;
        }).length;

        // Personalization layer 2: "admin default → user override" — one
        // saved order per tab/subtab covers every module, since the drawer
        // is global (19 Aug amendment).
        const savedOrder = await fieldOrderFor(ctx, t.id, subtabId);
        const orderedIds = resolveOrder(plain.map((f) => f.id), savedOrder);
        const byId = new Map(plain.map((f) => [f.id, f]));
        const ordered = orderedIds.map((id) => byId.get(id)).filter((f): f is Field => Boolean(f));

        fieldsBySubtab[slotKey] = ordered.map((f) => adaptFieldForDrawer(config, f));
        hasCustomFieldOrderBySubtab[slotKey] = Boolean(savedOrder?.length);
        repeatGroupsBySubtab[slotKey] = visible
          .filter((f) => f.type === 'repeat_group' && f.repeatGroupKey && f.repeatSchema && f.repeatMax != null)
          .map((f) => {
            const siblings = fieldsInRepeatGroup(config, f.repeatGroupKey!);
            return {
              id: f.id,
              key: f.key,
              label: f.label,
              max: f.repeatMax!,
              schema: f.repeatSchema!,
              values: (record.values[f.key] as Record<string, unknown>[] | undefined) ?? [],
              count: repeatInstanceCount(record.values, siblings.map((s) => s.key)),
            };
          });
      };

      if (subtabs.length) {
        await Promise.all(subtabs.map((s) => buildFor(s.id, s.id)));
      } else {
        await buildFor(null, '_');
      }
    }

    const count =
      t.kind === 'cases' ? cases.length :
      t.kind === 'updates' ? updates.length :
      undefined;

    const fieldCompleteness = t.kind === 'custom' && fieldsNeed > 0 ? { have: fieldsHave, need: fieldsNeed } : undefined;

    return { id: t.id, key: t.key, label: t.label, kind: t.kind, editable: tabGrantById.get(t.id) === 'edit', count, subtabs, fieldsBySubtab, repeatGroupsBySubtab, hasCustomFieldOrderBySubtab, fieldCompleteness };
  }));

  return (
    <section className="min-h-full bg-white px-6 py-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink-900">{record.dealName || '(untitled)'}</h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-ink-500">
            {(() => {
              // Matches the prototype's own Drawer.tsx header strip exactly:
              // CellValue for real type-aware rendering (currency formats as
              // dollars, status shows a swatch pill, dates format properly —
              // not a bare `String(value)`), and an empty field is skipped
              // entirely rather than shown as a bare em-dash, so the dot
              // separators only ever sit between fields that actually have
              // something to say.
              let shown = 0;
              return headerFields.map((f) => {
                const raw = record.values[f.key];
                if (raw == null || raw === '' || (Array.isArray(raw) && !raw.length)) return null;
                const i = shown++;
                const adapted = adaptFieldForDashboard(config, f);
                return (
                  <span key={f.id} className="inline-flex items-center gap-2.5">
                    {i > 0 ? <span className="text-line" aria-hidden>·</span> : null}
                    <span className="inline-flex items-center gap-1.5">
                      <span className="text-[11px] uppercase tracking-[.05em] text-ink-400">{f.label}</span>
                      <CellValue field={adapted} value={raw as import('@/proto/schema').FieldValue} moduleSlug={moduleSlug} />
                    </span>
                  </span>
                );
              });
            })()}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {grant === 'edit' && memberships.length > 0 ? (
            <ArchiveButton moduleSlug={moduleSlug} recordId={record.id} />
          ) : null}
          <Link
            href={`/${moduleSlug}`}
            title="Close"
            aria-label="Close"
            className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-400 transition-colors duration-150 hover:bg-canvas hover:text-ink-900"
          >
            <Icon name="x" size={16} />
          </Link>
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-line-soft bg-canvas/60 px-2.5 py-2">
        <MembershipsForm
          moduleSlug={moduleSlug}
          recordId={record.id}
          allModules={config.modules.filter((m) => m.kind === 'display')}
          current={memberships}
        />
      </div>

      {memberships.length === 0 && grant === 'edit' ? (
        <p className="mt-2 text-[12px] text-ink-400">
          Archived — displayed in no module. Still in the Records List.
        </p>
      ) : null}

      <RealPipelineBar
        moduleSlug={moduleSlug}
        moduleId={moduleId}
        recordId={record.id}
        pipelines={modulePipelines}
        assignment={pipelineAssign}
      />

      <DrawerTabs
        moduleSlug={moduleSlug}
        recordId={record.id}
        tabs={tabs}
        grantByKey={grantByKey}
        values={record.values}
        updatedAt={record.updatedAt}
        entries={entries}
        cases={cases}
        repliesByCase={repliesByCase}
        managersByCase={managersByCase}
        attachmentsByCase={attachmentsByCase}
        updates={updates}
        teamRoster={teamRoster}
        applicationRows={applicationRows}
        otherRows={otherRows}
        filesByRow={filesByRow}
        logins={logins}
        statementPeriods={statementPeriods}
        statementFiles={statementFiles}
        messages={messages}
        notesByScope={notesByScopeObj}
        authorNames={authorNames}
        viewerId={ctx.userId}
        isAdmin={ctx.isAdmin}
      />
    </section>
  );
}
