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
import { ItemAccessProvider } from './ItemAccess';
import { itemAccessFor } from '@/lib/records/itemAccess';
import { DrawerFieldLinks } from './DrawerFieldLinks';
import { DrawerFieldFiles } from './DrawerFieldFiles';
import { HeaderFacts } from './HeaderFacts';
import { VISIBILITY_FIELD_KEY } from '@/lib/records/grantRules';
import { assignableTeams, teamsFor } from '@/lib/teams/service';
import type { AssignableTeam, RecordTeams } from '@/lib/teams/types';
import { AssignToMe, OpenRecordNotice, TeamAssignments } from './TeamAssignments';
import { permissionsFor, canDo, authorize, moduleGrant, membershipAllowed, fieldGrants, tabGrants, subtabGrants, capGrant, type Grant } from '@/lib/records/permissions';
import {
  loadConfig, moduleBySlug, columnsForModule, fieldsInTab, fieldsInRepeatGroup, tabsForModule, subtabsForModule,
  headerFieldsForModule, pipelinesForModule, stepsForPipeline, pipelineStatusFields, type Field,
} from '@/lib/records/config';
import { repeatInstanceCount } from '@/lib/records/repeatGroups';
import { listRecords, getRecord } from '@/lib/records/records';
import { membershipsFor, membershipsForMany } from '@/lib/records/memberships';
import { pipelineAssignment } from '@/lib/records/pipelines';
import { casesFor, repliesForCases, managersForCases, caseHandlingNote, caseRosterFor } from '@/lib/records/cases';
import { recordMentions, openNotification, isMuted, unreadMentionCounts } from '@/lib/records/notifications';
import { RecordHeaderMenu } from './RecordHeaderMenu';
import { AutomationWaiting } from './AutomationWaiting';
import { waitingOn } from '@/lib/automations/service';
import { SEARCH_MAX } from '@/lib/records/search';
import { SearchBox } from './SearchBox';
import { attachmentsForCases } from '@/lib/records/caseAttachments';
import { updatesFor, teamRosterFor } from '@/lib/records/updates';
import { ensureApplicationRows, fileRowsFor, filesForRows, fieldFilesFor } from '@/lib/records/files';
import { loginsFor } from '@/lib/records/logins';
import { allPeriods, filesForRecord } from '@/lib/records/statements';
import { residualsForRecord } from '@/lib/records/recordResiduals';
import { applicationsFor } from '@/lib/applications/service';
import { messagesFor } from '@/lib/records/messages';
import { callsForRecord } from '@/lib/phone/calls';
import { messagesForRecord as smsForRecord } from '@/lib/phone/messages';
import { allNotesFor } from '@/lib/records/notes';
import { fieldAddressesFor } from '@/lib/records/fieldAddresses';
import { agreementsFor } from '@/lib/agreements/service';
import type { Note } from '@/lib/records/notes';
import { profileNamesFor } from '@/lib/records/users';
import { columnOrderFor, columnVisibilityFor, filtersFor, fieldOrderFor } from '@/lib/records/preferences';
import { parseSort, SORTABLE_TYPES } from '@/lib/records/listSort';
import { resolveOrder } from '@/lib/records/preferences';
import { adaptFieldForDashboard, adaptRecordRow, adaptFieldForDrawer } from '@/lib/records/adapter';
import { CreateRecordDialog } from './CreateRecordDialog';
import { MembershipsForm, ArchiveButton } from './MembershipsForm';
import { RecordsTable } from './RecordsTable';
import { DrawerTabs, type TabPayload, type RepeatGroupDef } from './DrawerTabs';
import { FieldSearch } from './FieldSearch';
import { fieldHits } from './fieldHits';
import { DrawerShell } from './DrawerShell';
import { RealPipelineBar } from './RealPipelineBar';
import type { FileRow, FileEntry } from '@/lib/records/files';

export default async function ModulePage({
  params,
  searchParams,
}: {
  params: Promise<{ module: string }>;
  searchParams: Promise<{ record?: string; page?: string; tab?: string; subtab?: string; n?: string; field?: string; q?: string; sort?: string }>;
}) {
  const { module: slug } = await params;
  const { record: recordId, page: pageParam, tab: tabKey, subtab: subtabKey, n: mentionParam, field: fieldParam, q: qParam, sort: sortParam } = await searchParams;
  // The list search; bounded like the box that writes it.
  const search = typeof qParam === 'string' ? qParam.trim().slice(0, SEARCH_MAX) : '';
  // `?n=<notification id>` is a deep link to one mention; `n=first` is the
  // list row's badge: whichever of my unread mentions here is oldest.
  const mentionKey = mentionParam && /^(first|[0-9a-f-]{36})$/.test(mentionParam) ? mentionParam : null;

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
  const [grant, savedColumnOrder, savedFilters, columnVisibility] = await Promise.all([
    moduleGrant(ctx, mod.id, mod.adminOnly),
    columnOrderFor(ctx, mod.id),
    filtersFor(ctx, mod.id),
    columnVisibilityFor(ctx, mod.id),
  ]);
  if (grant === 'hidden') redirect('/dashboard');

  // Layer 1 (admin order + selection) → layer 2 (this user's saved order) —
  // "admin default → user override → permission filter" (§16). Layer 3
  // (hidden fields absent) is `fieldGrants` below.
  const displayModuleGrantsForList = await Promise.all(
    config.modules
      .filter((m) => m.kind === 'display')
      .map(async (m) => [m, await moduleGrant(ctx, m.id, m.adminOnly)] as const),
  );
  const visibleDisplayModules = displayModuleGrantsForList
    .filter(([, g]) => g !== 'hidden')
    .map(([m]) => m);
  // The bulk bar moves records between modules, which is the `membership`
  // permission (Addition 2), not plain Edit: the restore picker offers only
  // modules this viewer may add to, and the archive / remove action is
  // offered only when they may remove from THIS module.
  const moveableDisplayModules = (
    await Promise.all(visibleDisplayModules.map(async (m) => [m, await membershipAllowed(ctx, m)] as const))
  )
    .filter(([, ok]) => ok)
    .map(([m]) => m);
  const canMoveRecords = mod.kind === 'display' ? await membershipAllowed(ctx, mod) : grant === 'edit';
  // Company-wide actions (Permissions spec) — each button exists only for
  // someone the database would let use it.
  const [canCreate, canArchive, canPipeline] = await Promise.all([
    canDo(ctx, 'create'),
    canDo(ctx, 'archive'),
    canDo(ctx, 'pipeline'),
  ]);

  const adminColumns = columnsForModule(config, mod.id);
  const orderedColumnIds = resolveOrder(adminColumns.map((f) => f.id), savedColumnOrder);
  const columnById = new Map(adminColumns.map((f) => [f.id, f]));
  const orderedDbColumns = orderedColumnIds.map((id) => columnById.get(id)).filter((f): f is Field => Boolean(f));

  const grants = await fieldGrants(ctx, orderedDbColumns, mod.id);
  const visibleDbColumns = orderedDbColumns.filter((f) => grants.get(f.id) !== 'hidden');
  /*
   * Permission first (above — a hidden field is never a column at all), then
   * the viewer's own show/hide over the module's "visible by default" (UI/UX
   * spec §6). A column the viewer hid is still one they may see, so it stays
   * in the Columns picker to be shown again.
   */
  const defaultVisible = new Map(
    config.moduleColumns.filter((c) => c.moduleId === mod.id).map((c) => [c.fieldId, c.defaultVisible]),
  );
  const isShown = (f: Field) => columnVisibility.get(f.id) ?? defaultVisible.get(f.id) ?? true;
  const shownDbColumns = visibleDbColumns.filter(isShown);
  // Team member(s) assigned carries a team, its tag and Assign to me on one line.
  const columns = shownDbColumns
    .map((f) => adaptFieldForDashboard(config, f))
    .map((c) => (c.id === VISIBILITY_FIELD_KEY ? { ...c, width: Math.max(c.width ?? 0, 300) } : c));
  const columnChoices = visibleDbColumns.map((f) => ({ key: f.key, label: f.label, shown: isShown(f) }));
  const userHiddenColumns = visibleDbColumns.filter((f) => !isShown(f)).map((f) => adaptFieldForDashboard(config, f));

  /* `?sort=` — only a column this viewer can see and whose type sorts, or the
     name; anything else is ignored rather than trusted. */
  const requestedSort = parseSort(sortParam);
  const sort =
    requestedSort && (requestedSort.fieldId === 'deal_name'
      || visibleDbColumns.some((f) => f.key === requestedSort.fieldId && SORTABLE_TYPES.has(f.type)))
      ? requestedSort
      : null;
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
  const statusGrants = await fieldGrants(ctx, pipelineStatusDbFields, mod.id);
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
    q: search,
    sort,
  });
  // Asked only for a viewer the column is shown to: absent, never blank.
  const showsTeams = columns.some((c) => c.id === VISIBILITY_FIELD_KEY);
  const [membershipsByRecord, mentionCounts, teamsByRecord, assignable] = await Promise.all([
    membershipsForMany(ctx, dbRows.map((r) => r.id)),
    // The viewer's own unread @mentions per row — the "@ 3" badge.
    unreadMentionCounts(ctx, dbRows.map((r) => r.id)),
    showsTeams ? teamsFor(ctx, dbRows.map((r) => r.id)) : new Map<string, RecordTeams>(),
    showsTeams || canCreate ? assignableTeams(ctx) : ([] as AssignableTeam[]),
  ]);
  const moduleSlugById = new Map(config.modules.map((m) => [m.id, m.slug]));
  const rows = dbRows.map((r) => ({
    ...adaptRecordRow(
      r,
      (membershipsByRecord[r.id] ?? []).map((id) => moduleSlugById.get(id)).filter((s): s is string => Boolean(s)),
    ),
    mentions: mentionCounts[r.id] ?? 0,
  }));

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
            {search ? (
              <>
                <span aria-hidden className="text-line">·</span>
                <span>
                  {total === 0 ? 'Nothing matches' : total === 1 ? '1 match for' : `${total.toLocaleString()} matches for`} “{search}”
                </span>
              </>
            ) : null}
            {/* Configured column count vs. what this viewer may see — the gap
                IS the permission system, visible at a glance (prototype
                parity). Demoted from the top-right, where it sat with the same
                weight as the primary action while being a fact almost nobody
                needs, to the end of the subtitle where it reads as context. */}
            <span aria-hidden className="text-line">·</span>
            <span>
              {columns.length} of {adminColumns.length} columns visible to you
            </span>
            {mod.showsOpenCases ? (
              <>
                <span aria-hidden className="text-line">·</span>
                <span>Records appear here automatically while they have an open case</span>
              </>
            ) : null}
          </p>
        </div>
        {/*
          No "New record" on a module that shows open cases (migration 9764):
          a record is in it exactly while it has an open case, so one made
          here would have nowhere to be. Records arrive by opening a case on
          them, and the subtitle says so.
        */}
        {/* The list search sits on the title row (the client's placement),
            keyed on the current search so a navigation resets what it shows. */}
        <div className="flex shrink-0 items-center gap-3">
          <SearchBox key={search} moduleSlug={slug} initial={search} />
          {grant === 'edit' && canCreate && !mod.showsOpenCases ? (
            <CreateRecordDialog moduleSlug={slug} moduleLabel={mod.label} viewerId={ctx.userId} assignable={assignable} />
          ) : null}
        </div>
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
          /* Only modules this viewer can open. This drives the bulk bar's
           * "add to module" picker, so an unfiltered list both offered a
           * module the gate in `setMemberships` refuses and named a module
           * the viewer is not meant to know exists — it shipped the whole
           * module table, ids included, in the page payload. */
          displayModules={moveableDisplayModules
            // Not a module a person can put a record into — see migration 9764.
            .filter((m) => !m.showsOpenCases)
            .map((m) => ({ id: m.id, slug: m.slug, label: m.label }))}
          canMoveRecords={canMoveRecords}
          canArchive={canArchive}
          canPipeline={canPipeline}
          hasCustomColumnOrder={Boolean(savedColumnOrder?.length)}
          filters={savedFilters}
          pipelines={pipelineFilterOptions}
          /* Also the columns this viewer hid: a saved filter on one still
             applies, and its chip should still say what it filters. */
          pipelineStatusFields={[...pipelineStatusFilterFields, ...userHiddenColumns]}
          columnChoices={columnChoices}
          sort={sort}
          canEdit={grant === 'edit'}
          teamsByRecord={Object.fromEntries(teamsByRecord)}
          assignableTeams={assignable}
          viewerId={ctx.userId}
          viewerIsAdmin={ctx.isAdmin}
          closesCases={Boolean(mod.showsOpenCases)}
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
          {/* Keyed on the mention too, so a second notification link to the
              same record re-renders and lands on the new item. */}
          <Suspense key={`${recordId}:${mentionKey ?? ''}`} fallback={<DrawerSkeleton />}>
            <RecordDrawer
              moduleSlug={slug}
              moduleId={mod.id}
              recordId={recordId}
              recordPromise={recordPromise!}
              grant={grant}
              openTabKey={tabKey ?? null}
              openSubtabKey={subtabKey ?? null}
              mentionKey={mentionKey}
              fieldKey={typeof fieldParam === 'string' && /^[a-z0-9_]{1,80}$/i.test(fieldParam) ? fieldParam : null}
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
function RecordLocked({ moduleSlug, recordId, data }: { moduleSlug: string; recordId: string; data: RecordTeams }) {
  const take = data.teams.find((t) => t.canTake);
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
            <Icon name="lock" size={18} />
          </div>
          <h2 className="mt-3 text-[15px] font-semibold text-ink-900">{take ? 'Take this record to open it' : 'This record is open for another team'}</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
            {take ? 'It is open for your team, and nobody has taken it yet.' : 'You can open it once it has been assigned to you.'}
          </p>
          {take ? (
            <div className="mt-4">
              <AssignToMe moduleSlug={moduleSlug} recordId={recordId} team={take} size="md" />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

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
  recordId,
  recordPromise,
  grant: moduleLevel,
  openTabKey,
  openSubtabKey,
  mentionKey = null,
  fieldKey = null,
}: {
  moduleSlug: string;
  moduleId: string;
  /** `?tab=` / `?subtab=` — which tab to open on, by KEY rather than id.
   *  Keys are stable across databases; ids are not, so a link in a
   *  notification or an email keeps working after a reseed. Ignored when the
   *  tab is hidden for this viewer, which is why it is resolved against the
   *  already-filtered `dbTabs` rather than against config. */
  openTabKey?: string | null;
  openSubtabKey?: string | null;
  /** `?n=` — a notification id, or 'first' for the oldest unread mention here. */
  mentionKey?: string | null;
  /** `?field=` — a field KEY to land on: its tab and sub-tab open and the card
   *  flashes (the pre-send check's "fix this" links, the drawer's own field
   *  search). Ignored when the field is hidden for this viewer. */
  fieldKey?: string | null;
  /** Started by `ModulePage` before it awaited its own queries, so this read
   *  overlaps the dashboard's instead of queueing behind it. Awaited here, so
   *  a failure lands inside the Suspense boundary and takes only the drawer. */
  recordId: string;
  recordPromise: Promise<Awaited<ReturnType<typeof getRecord>>>;
  grant: 'view' | 'edit';
}) {
  const ctx = await authorize();
  const [config, record, drawerTeams, assignable, automationsWaiting] = await Promise.all([
    loadConfig(),
    recordPromise,
    teamsFor(ctx, [recordId]),
    assignableTeams(ctx),
    waitingOn(ctx, recordId),
  ]);
  const teamsHere = drawerTeams.get(recordId);
  // Read-only until taken, when an open assignment is the only way in.
  const grant = teamsHere?.writable === false ? 'view' : moduleLevel;

  /*
   * ── MENTIONS ON THIS RECORD ─────────────────────────────────────────────
   * A link into one mention opens it (read + opened; the previous value of a
   * field mention is returned this once and then gone) and overrides the
   * tab/sub-tab to wherever it lives. The remaining unread ones feed the
   * tab counts, the case dots and the field dots.
   */
  let openMention: Awaited<ReturnType<typeof openNotification>> = null;
  if (record && mentionKey) {
    const id = mentionKey === 'first' ? ((await recordMentions(ctx, record.id))[0]?.id ?? null) : mentionKey;
    if (id) openMention = await openNotification(ctx, id);
    if (openMention && openMention.recordId !== record.id) openMention = null;
  }
  // `?field=` resolves to the field's own tab and sub-tab (by key, like the
  // params themselves); whether the viewer may see it is settled further down,
  // where the tab list has been filtered and the field's grant is known.
  const fieldHome = fieldKey ? config.fields.find((f) => f.key === fieldKey && !f.archivedAt) : undefined;
  const fieldTabKey = fieldHome ? config.tabs.find((t) => t.id === fieldHome.tabId)?.key ?? null : null;
  const fieldSubtabKey = fieldHome?.subtabId ? config.subtabs.find((s) => s.id === fieldHome.subtabId)?.key ?? null : null;
  // Where the drawer opens: the mention's home wins, then the field's, then `?tab=`/`?subtab=`.
  const wantTabKey = openMention?.tabKey ?? fieldTabKey ?? openTabKey;
  const wantSubtabKey = openMention?.tabKey ? (openMention.subtabKey ?? null) : fieldTabKey ? fieldSubtabKey : openSubtabKey;
  // `getRecord` legitimately returns null: the record was deleted, or this
  // viewer was removed from its team. Returning `null` here rendered a
  // full-height blank white sheet with no title, no message and no close
  // button — the "×" lives inside the subtree that was skipped — so a stale
  // bookmark or a shared link looked like the app had hung.
  if (!record) {
    // In this viewer's list but not theirs to open yet: say so, and offer the way in.
    if (teamsHere?.locked) return <RecordLocked moduleSlug={moduleSlug} recordId={recordId} data={teamsHere} />;
    return <RecordUnavailable moduleSlug={moduleSlug} />;
  }

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
  /*
   * ⚠ EVERY GRANT BELOW IS RESOLVED **IN THIS MODULE**.
   *
   * Admin-Module-Plan §2.2: "which drawer tabs and subtabs the user sees
   * WITHIN THAT MODULE". These lookups used to omit the module and so read
   * only the global grant — which meant a tab or field restricted in one
   * module alone was restricted in none of them. The per-module write path,
   * the resolvers and the matrix UI were all already correct; this screen was
   * the one place the module was in scope and simply not passed, so the
   * feature resolved correctly everywhere except where a user could see it.
   *
   * This is deliberately NOT the best-across-modules rule the write path uses
   * (`tabAccess.ts`). The drawer is opened FROM a module, so the module is a
   * known fact rather than a claim, and the same record opened from Leads and
   * from Deals is supposed to differ. The write path cannot rely on that: its
   * module arrives from the browser, so it resolves from `record_modules` and
   * takes the best — never narrower than what this screen displays, so nothing
   * shown here can be refused on save.
   */
  const allTabs = tabsForModule(config, moduleId);
  const rawTabGrants = await tabGrants(ctx, allTabs.map((t) => t.id), moduleId);
  const tabGrantById = new Map(
    allTabs.map((t) => [t.id, capGrant(grant, rawTabGrants.get(t.id) ?? 'edit')] as const),
  );
  // Cases = Hidden (Permissions spec) hides the Cases tab with the module.
  const viewerPerms = await permissionsFor(ctx);
  const casesHidden = !ctx.isAdmin && viewerPerms.settings['items.cases'] === 'hidden';
  const dbTabs = allTabs.filter((t) => tabGrantById.get(t.id) !== 'hidden' && !(casesHidden && t.kind === 'cases'));

  /*
   * Subtab grants. Permissions spec: a sub-tab follows its tab until it has a
   * setting of its own, and then that setting wins — higher or lower than the
   * tab ("the most specific setting wins"). `subtabGrant` resolves exactly
   * that; the module stays the outer limit.
   */
  const allSubtabs = dbTabs.flatMap((t) => subtabsForModule(config, moduleId, t.id));
  const rawSubtabGrants = await subtabGrants(ctx, allSubtabs, moduleId);
  const subtabGrantById = new Map(
    allSubtabs.map((s) => [s.id, capGrant(grant, rawSubtabGrants.get(s.id) ?? 'edit')] as const),
  );

  /** Is the tab of this kind visible to this viewer? System tabs are one per
   *  module, so `kind` identifies them unambiguously. */
  const shows = (kind: string) => dbTabs.some((t) => t.kind === kind);

  /** The resolved grant on the tab of this kind — Hidden when there isn't one. */
  const grantOfKind = (kind: string): Grant => {
    const t = dbTabs.find((x) => x.kind === kind);
    return (t ? tabGrantById.get(t.id) : undefined) ?? 'hidden';
  };

  const [
    memberships, cases, caseNote, updates, pipelineAssign,
    applicationRows, otherRows, logins, statementPeriods, statementFiles,
    messages, notesByScope, teamRoster, caseRoster, mentions, muted, phoneCalls, smsMessages, residuals,
    applications, addressesRaw, agreements,
  ] = await Promise.all([
    membershipsFor(ctx, record.id),
    shows('cases') ? casesFor(ctx, record.id) : [],
    /* Fetched alongside the cases and skipped with them: a tab the viewer
       cannot see should not cost a query, and RLS would refuse this one
       anyway (its policies are the Cases tab's, exactly). */
    shows('cases') ? caseHandlingNote(ctx, record.id) : null,
    shows('updates') ? updatesFor(ctx, record.id) : [],
    pipelineAssignment(ctx, record.id, moduleId),
    // `ensureApplicationRows` must finish before the Application rows are read
    // — it is what creates the 5 locked rows on a record's first-ever open, and
    // reading in parallel with it would return an empty Files tab that time.
    // Chained rather than awaited up front so the pair still overlaps with the
    // other independent fetches instead of blocking all of them. Skipped
    // entirely when Files is hidden, which also avoids a WRITE for a tab the
    // viewer cannot open.
    /*
     * ⚠ OPENING A DRAWER MUST NOT REQUIRE WRITE ACCESS.
     *
     * `ensureApplicationRows` creates the five locked Application rows on a
     * record's first-ever open. It goes through `ensure_application_file_rows`,
     * which is SECURITY INVOKER and is therefore authorised by the `file_rows`
     * policy — and that policy now requires Edit on the Files tab (migration
     * 88), as it should, because it is an INSERT.
     *
     * The consequence was that a viewer holding View on Files could no longer
     * open the record AT ALL: the write was attempted during render, RLS
     * refused it, and the whole drawer became an error page. Seen the moment
     * the migration landed, on the Tickets module.
     *
     * So the rows are created only by someone who may create them. A View-only
     * viewer reads whatever rows already exist — which is every record anyone
     * has opened once, and an empty Files tab otherwise. That is the correct
     * outcome for read-only access, and it is honest: it does not silently
     * perform a write on their behalf.
     */
    shows('files')
      ? (grantOfKind('files') === 'edit'
          ? ensureApplicationRows(ctx, record.id)
          : Promise.resolve()
        ).then(() => fileRowsFor(ctx, record.id, 'application'))
      : [],
    shows('files') ? fileRowsFor(ctx, record.id, 'other') : [],
    shows('logins') ? loginsFor(ctx, record.id) : [],
    shows('statements') ? allPeriods() : [],
    shows('statements') ? filesForRecord(ctx, record.id) : [],
    shows('communication') ? messagesFor(ctx, record.id) : [],
    allNotesFor(ctx, record.id),
    shows('updates') ? teamRosterFor(ctx, record.id) : [],
    shows('cases') ? caseRosterFor(ctx, record.id) : [],
    recordMentions(ctx, record.id),
    isMuted(ctx, record.id),
    /*
     * Calls and texts ride along with the same parallel wave as everything
     * else, and are skipped entirely when Communication is hidden — the same
     * `shows()` guard the message fetch above already uses, so a viewer who
     * cannot open the tab does not pay for its two queries.
     *
     * Both functions ask the phone subtab grant themselves and return [] when
     * it is hidden, so this guard is the cheap outer one, not the boundary.
     */
    shows('communication') ? callsForRecord(ctx, record.id) : [],
    shows('communication') ? smsForRecord(ctx, record.id) : [],
    /*
     * Null — not an empty object — when the tab is hidden, so the drawer can
     * tell "not fetched" from `{ kind: 'admin_only' }`, which means the tab IS
     * shown and the figures behind it are not. Collapsing those two would make
     * a hidden tab and a refused one render identically, which is the
     * distinction this whole panel is built around.
     */
    shows('residuals') ? residualsForRecord(ctx, record.id) : Promise.resolve(null),
    // The Prepopulated Application panel, on whichever visible tab carries it.
    dbTabs.some((t) => t.showsApplications) ? applicationsFor(ctx, record.id) : Promise.resolve(null),
    fieldAddressesFor(ctx, record.id),
    // The Agreements (e-signature) panel, on whichever visible tab carries it.
    dbTabs.some((t) => t.showsAgreements) ? agreementsFor(ctx, record.id) : Promise.resolve(null),
  ]);

  /* Both kinds still read: "Other files" was folded into Application by
     migration 750 and its rows migrated, so `otherRows` is empty on a current
     database — it is still unioned here so `filesByRow` covers any straggler
     an older deployment left behind, rather than rendering a row with its
     files missing. */
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
    if (u.authorId) authorIds.add(u.authorId);
    for (const m of u.mentionedUserIds) authorIds.add(m);
  }
  for (const c of cases) {
    if (c.issueAuthor) authorIds.add(c.issueAuthor);
    if (c.solutionAuthor) authorIds.add(c.solutionAuthor);
    if (c.editedBy) authorIds.add(c.editedBy);
  }
  for (const replies of Object.values(repliesByCase)) for (const r of replies) authorIds.add(r.authorId);
  for (const managers of Object.values(managersByCase)) for (const m of managers) authorIds.add(m);

  // The viewer too: their own name must be bold when a colleague tags them,
  // and the roster never contains yourself.
  authorIds.add(ctx.userId);
  const authorNameMap = await profileNamesFor(ctx, Array.from(authorIds));
  const authorNames = Object.fromEntries(authorNameMap) as Record<string, string>;

  // Field-mention entries in the feed carry the field's home as labels. Global
  // configuration, resolved here where the whole of it is known (a tab the
  // viewer cannot see is still named — the entry itself is only delivered
  // when the viewer may see the field).
  const fieldByKey = new Map(config.fields.map((f) => [f.key.toLowerCase(), f]));
  const tabById = new Map(config.tabs.map((t) => [t.id, t]));
  const subtabById = new Map(config.subtabs.map((s) => [s.id, s]));
  const fieldPathByUpdate: Record<string, { tab: string; subtab: string | null; field: string }> = {};
  for (const u of updates) {
    if (!u.fieldKey) continue;
    const f = fieldByKey.get(u.fieldKey.toLowerCase());
    if (!f) continue;
    fieldPathByUpdate[u.id] = {
      tab: tabById.get(f.tabId)?.label ?? '',
      subtab: f.subtabId ? (subtabById.get(f.subtabId)?.label ?? null) : null,
      field: f.label,
    };
  }

  const headerMentions: Record<string, typeof mentions> = {};
  for (const m of mentions) if (m.fieldKey) (headerMentions[m.fieldKey] ??= []).push(m);

  const allDisplayModules = config.modules.filter((m) => m.kind === 'display');
  const displayModuleGrants = await Promise.all(
    allDisplayModules.map(async (m) => [m, await moduleGrant(ctx, m.id, m.adminOnly)] as const),
  );
  const displayModules = displayModuleGrants.filter(([, g]) => g !== 'hidden').map(([m]) => m);
  // Which of those this viewer may add records to and remove them from — the
  // `membership` permission (Addition 2). The chip row draws the rest locked.
  const membershipAllowedIds = (
    await Promise.all(displayModules.map(async (m) => [m.id, await membershipAllowed(ctx, m)] as const))
  )
    .filter(([, ok]) => ok)
    .map(([id]) => id);

  const headerFields = headerFieldsForModule(config, moduleId);

  // The tab half of the grant chain. A tab resolved to Hidden is dropped from
  // the strip entirely rather than rendered empty — "absent, never blank"
  // (CLAUDE.md §3), and it is the ONLY permission that can restrict Cases,
  // Files, Logins, Statements, Updates or Communication, none of which are
  // made of fields.

  // One grant lookup for every field across every tab — a hidden tab's too,
  // because a field set on its own can be shown where its tab is not (Vital
  // Info, columns) — keyed by the adapted (key-based) field id, the shape
  // RealFieldGrid consumes.
  const allTabFields = allTabs.flatMap((t) => fieldsInTab(config, t.id));
  const grants = await fieldGrants(ctx, allTabFields, moduleId);
  const grantByKey: Record<string, 'hidden' | 'view' | 'edit'> = {};
  for (const f of allTabFields) {
    // field's own setting → sub-tab's → tab's → Edit (`fieldGrant`), with the
    // module as the outer limit. Permissions spec: "The most specific setting
    // wins. A field or sub tab setting beats its tab setting."
    grantByKey[f.key] = capGrant(grant, grants.get(f.id) ?? 'hidden');
  }

  /* Files FIELDS — only fetched when this viewer can see at least one; RLS
     leaves out any field they cannot. */
  // Who an update, case or tab note can be shared with, and what is already shared.
  const itemAccess = await itemAccessFor(ctx, record.id);
  const filesByField: Record<string, FileEntry[]> = config.fields.some(
    (f) => f.type === 'file' && (grantByKey[f.key] ?? 'hidden') !== 'hidden',
  )
    ? await fieldFilesFor(ctx, record.id)
    : {};

  /*
   * ── THE HEADER STRIP'S FACTS, AND ITS PERMISSION CHAIN ───────────────────
   *
   * ⚠️ THIS STRIP PREVIOUSLY HONOURED NO GRANT AT ALL. It read straight from
   * `headerFieldsForModule` and `record.values` and rendered whatever it found.
   *
   * It survived the FIELD-level case only by accident: `getRecord` strips
   * field-hidden keys before returning, so a Hidden field arrived as undefined
   * and the empty check dropped it. The TAB and SUBTAB cases were not covered
   * at all — `hiddenKeysFor` consults `fieldGrants` and nothing else — so
   * hiding the Overview tab still printed Legal business name, MID, Team
   * member(s) assigned, MCC code and Current status at the top of the drawer,
   * in the page payload as well as on screen. That is CLAUDE.md rule 3
   * verbatim, and the prototype this block was copied from does filter.
   *
   * `grantByKey` is the already-computed chain — module ceiling, then tab, then
   * subtab, then the field itself — so using it closes every level at once.
   *
   * ⚠️ AND IT MATTERS MORE NOW THAN IT DID. The grid above renders a LABEL for
   * a field that is present but empty, because "this module tracks MCC code and
   * this record has not got one" is worth saying. A permission-hidden field
   * also arrives empty, so without this filter the redesign would have
   * announced the NAME of every field the viewer is not allowed to see.
   */
  // Archive and the pipeline bar follow their company-wide actions.
  const [canArchiveRecords, canMovePipelineAtAll, canChangePipelineAtAll] = await Promise.all([canDo(ctx, 'archive'), canDo(ctx, 'pipeline'), canDo(ctx, 'pipeline_change')]);
  const canMovePipeline = canMovePipelineAtAll && grant === 'edit';
  const canChangePipeline = canChangePipelineAtAll && grant === 'edit';
  const teamSlot = (
    <TeamAssignments
      moduleSlug={moduleSlug}
      recordId={record.id}
      data={teamsHere}
      assignable={assignable}
      viewerId={ctx.userId}
      viewerIsAdmin={ctx.isAdmin}
    />
  );
  const titleForCompare = (record.dealName ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

  const headerFacts = headerFields
    .filter((f) => {
      // Absent, never blank.
      if ((grantByKey[f.key] ?? 'hidden') === 'hidden') return false;
      // A pipeline-synced Status field belongs only to records on that
      // pipeline — the same rule the field grid applies below (Admin §3.6).
      const owner = statusFieldOwners.get(f.id);
      return owner === undefined || owner === pipelineAssign?.pipelineId;
    })
    .map((f) => {
      const value = record.values[f.key];
      const empty =
        value == null
        || value === ''
        || (Array.isArray(value) && value.length === 0)
        // `{}` reaches here from a percent_split or address that was filled in
        // and then cleared. The old check missed it, so the strip printed a
        // label with nothing after it.
        || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
      return {
        id: f.id,
        label: f.label,
        /* Already capped by module → tab → subtab → field, and never
           'hidden' — those were filtered out above. The strip is editable
           now, so the chain has to reach it rather than stopping at
           "should this be on screen at all". */
        grant: (grantByKey[f.key] ?? 'view') === 'edit' ? ('edit' as const) : ('view' as const),
        field: adaptFieldForDashboard(config, f),
        // Same trust boundary every other read from JSONB crosses: the union
        // describes what a well-formed value looks like once its own renderer
        // interprets it, not a runtime guarantee this line can check.
        value: value as import('@/proto/schema').FieldValue,
        empty,
      };
    })
    /*
     * A field whose value simply restates the record's own title is noise —
     * Legal business name is seeded into the header of all six modules and
     * usually equals the Deal Name.
     *
     * Compared by VALUE, not by field key, so this names no field and no module
     * (CLAUDE.md §1) and generalises: any field that happens to restate the
     * title is equally redundant. It also self-heals — the moment someone edits
     * the legal name so the two differ, the cell returns, which is exactly when
     * it becomes worth seeing.
     *
     * Scalars only. A status or an avatar stack that coincidentally matches the
     * record name is a coincidence, not a duplication.
     */
    .filter((fact) => {
      if (fact.empty) return true;
      if (!['text', 'long_text', 'identifier'].includes(fact.field.type)) return true;
      const shown = String(fact.value).trim().toLowerCase().replace(/\s+/g, ' ');
      return shown !== titleForCompare;
    });

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

  // A field's own address follows the field's grant, like its notes.
  const addressByField = Object.fromEntries(
    Object.entries(addressesRaw).filter(([key]) => grantByKey[key] !== undefined && grantByKey[key] !== 'hidden'),
  );

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
          // A pipeline's synced Status field never renders as a card: the
          // stage lives in the header stepper, and a second copy in the body
          // was the client's "remove the pipeline in the body — it lives in
          // the header" (30 Oct 2026). The field row stays (lists, filters and
          // the header read it); only the grid drops it. Dropped rather than
          // disabled, the same "absent, never blank" rule hidden fields follow.
          .filter((f) => !statusFieldOwners.has(f.id));
        const plain = visible.filter((f) => f.type !== 'repeat_group');
        fieldsNeed += plain.length;
        fieldsHave += plain.filter((f) => {
          // A Files field holds uploads, not a value.
          if (f.type === 'file') return (filesByField[f.key]?.length ?? 0) > 0;
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

    return { id: t.id, key: t.key, label: t.label, kind: t.kind, editable: tabGrantById.get(t.id) === 'edit', count, subtabs, fieldsBySubtab, repeatGroupsBySubtab, hasCustomFieldOrderBySubtab, fieldCompleteness, showsApplications: t.showsApplications ?? false, showsAgreements: t.showsAgreements ?? false };
  }));

  return (
    <section className="@container min-h-full bg-white px-6 py-5">
      <DrawerFieldLinks moduleSlug={moduleSlug} recordId={record.id}>
      <DrawerFieldFiles moduleSlug={moduleSlug} recordId={record.id} filesByField={filesByField}>
      <ItemAccessProvider value={{ ...itemAccess, viewerId: ctx.userId }}>
      {/* ── Band 1: title bar — record name, field search, Archive, ••• menu,
          close. The two `flex-1` ends keep the search in the middle; on a phone
          width it takes its own line under them. ── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* `min-w-0 flex-1` plus `truncate` on the heading. Without both, a long
            business name pushed the Archive and Close controls off the sheet
            and gave the whole drawer a horizontal scrollbar — an inline-flex
            child cannot shrink below its own min-content width. */}
        <div className="min-w-0 flex-1">
          <h2
            className="truncate text-[20px] font-semibold leading-tight tracking-[-.015em] text-ink-900"
            title={record.dealName || undefined}
          >
            {record.dealName || '(untitled)'}
          </h2>
        </div>
        <FieldSearch hits={fieldHits(tabs, applicationRows)} />
        <div className="flex shrink-0 items-center justify-end gap-3 @[40rem]:flex-1">
          {grant === 'edit' && canArchiveRecords && memberships.length > 0 ? (
            <ArchiveButton
              moduleSlug={moduleSlug}
              recordId={record.id}
              heldBy={{
                labels: config.modules.filter((m) => m.showsOpenCases && memberships.includes(m.id)).map((m) => m.label),
                openCases: cases.filter((c) => c.state === 'open').length,
              }}
            />
          ) : null}
          <AutomationWaiting waiting={automationsWaiting} />
          <RecordHeaderMenu recordId={record.id} muted={muted} />
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

      {/*
        ── Band 2: Pipeline | In modules (UI spec §2) ──────────────────────
        One row, two equal halves; on a narrower drawer they stack, Pipeline
        first. The separate "Account Health: Onboarding" fact that used to sit
        under the title is gone — the stepper already says where the record
        stands, and saying it twice was the redundancy the spec removes.
      */}
      <div className="mt-4 grid grid-cols-1 gap-3 @[56rem]:grid-cols-2">
        <div className="min-w-0 rounded-xl border border-line-soft bg-canvas/50 px-3.5 py-3">
          <RealPipelineBar
            moduleSlug={moduleSlug}
            moduleId={moduleId}
            recordId={record.id}
            pipelines={modulePipelines}
            assignment={pipelineAssign}
            canMove={canMovePipeline}
            canChange={canChangePipeline}
          />
        </div>
        <div className="min-w-0 rounded-xl border border-line-soft bg-canvas/50 px-3.5 py-3">
          <MembershipsForm
            moduleSlug={moduleSlug}
            recordId={record.id}
            /* Only modules this viewer can actually open. It listed every display
             * module regardless of grant, so a hidden module appeared as a
             * toggle — offering a control the gate in `setMemberships` now
             * refuses, and naming a module the viewer is not supposed to know
             * exists. */
            allModules={displayModules}
            current={memberships}
            allowed={membershipAllowedIds}
          />
          {memberships.length === 0 && grant === 'edit' ? (
            <p className="mt-2 text-[12px] text-ink-400">
              Archived — displayed in no module. Still in the Records List.
            </p>
          ) : null}
        </div>
      </div>

      {/*
        ── Band 3: Vital Info ───────────────────────────────────────────────
        Editable in place — see `HeaderFacts`. It writes through
        `setValueAction`, the same path the field grid and the dashboard cell
        use, so the permission chain, the compare-and-swap and the activity
        entry are not reimplemented here.
      */}
      {teamsHere && !teamsHere.writable ? <OpenRecordNotice moduleSlug={moduleSlug} recordId={record.id} data={teamsHere} /> : null}
      <HeaderFacts
        moduleSlug={moduleSlug}
        recordId={record.id}
        updatedAt={record.updatedAt}
        facts={headerFacts}
        viewerId={ctx.userId}
        viewerIsAdmin={ctx.isAdmin}
        visibilityFieldKey={VISIBILITY_FIELD_KEY}
        teamSlot={teamSlot}
        mentionsByField={headerMentions}
        openMention={openMention?.fieldKey ? openMention : null}
      />

      <DrawerTabs
        teamSlot={teamSlot}
        moduleSlug={moduleSlug}
        recordId={record.id}
        tabs={tabs}
        /*
         * Resolved HERE, against the tabs this viewer actually gets, not in the
         * client component. A link asking for a tab that is Hidden for them
         * must fall back to the first visible one rather than opening an empty
         * shell — and the server is the only place that knows which tabs
         * survived the grant chain.
         */
        openTabId={tabs.find((t) => t.key === wantTabKey)?.id ?? null}
        openSubtabId={
          tabs
            .find((t) => t.key === wantTabKey)
            ?.subtabs.find((sub) => sub.key === wantSubtabKey)?.id ?? null
        }
        grantByKey={grantByKey}
        values={record.values}
        updatedAt={record.updatedAt}
        cases={cases}
        caseHandlingNote={caseNote}
        repliesByCase={repliesByCase}
        managersByCase={managersByCase}
        attachmentsByCase={attachmentsByCase}
        updates={updates}
        teamRoster={teamRoster}
        applicationRows={applicationRows}
        filesByRow={filesByRow}
        logins={logins}
        statementPeriods={statementPeriods}
        statementFiles={statementFiles}
        residuals={residuals}
        applications={applications}
        agreements={agreements}
        messages={messages}
        phoneCalls={phoneCalls}
        smsMessages={smsMessages}
        notesByScope={notesByScopeObj}
        addressByField={addressByField}
        openFieldKey={fieldHome && grantByKey[fieldHome.key] !== undefined && grantByKey[fieldHome.key] !== 'hidden' ? fieldHome.key : null}
        authorNames={authorNames}
        viewerId={ctx.userId}
        isAdmin={ctx.isAdmin}
        caseRoster={caseRoster}
        mentions={mentions}
        openMention={openMention}
        fieldPathByUpdate={fieldPathByUpdate}
      />
      </ItemAccessProvider>
      </DrawerFieldFiles>
      </DrawerFieldLinks>
    </section>
  );
}
