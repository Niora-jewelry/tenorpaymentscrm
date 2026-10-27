'use client';

/**
 * The drawer's real tab strip — same visual language as
 * `src/proto/ui/Drawer.tsx`'s tab/subtab strip, driven by real per-tab data
 * fetched once, server-side, in `page.tsx`. Client-side only for which tab
 * is active (no data fetching here — everything for every tab is already on
 * the page, so switching tabs is instant, no loading state needed).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { recordMentionsAction } from './actions';
import { CHANGED_EVENT } from '../useLiveCounts';
import type { Candidate, NotificationView } from '@/lib/records/notifications';
import type { FieldPath } from './UpdatesPanel';
import { Icon } from '@/proto/ui/icons';
import { CountPill, CompletenessBadge } from '@/proto/ui/kit';
import type { Field as ProtoField } from '@/proto/schema';
import { RealFieldGrid } from './RealFieldGrid';
import { PanelErrorBoundary } from './PanelErrorBoundary';
import { TabNotes } from './NoteThread';
import { CasesPanel } from './CasesPanel';
import { UpdatesPanel } from './UpdatesPanel';
import { FilesPanel } from './FilesPanel';
import { LoginsPanel } from './LoginsPanel';
import { StatementsPanel } from './StatementsPanel';
import { CommunicationPanel } from './CommunicationPanel';
import { ResidualsPanel } from './ResidualsPanel';
import type { CaseThread, CaseReply, CaseHandlingNote } from '@/lib/records/cases';
import type { CaseAttachments as CaseAttachmentMap } from '@/lib/records/caseAttachments';
import type { Update, TeamRosterEntry } from '@/lib/records/updates';
import type { FileRow, FileEntry } from '@/lib/records/files';
import type { LoginRow } from '@/lib/records/logins';
import type { StatementPeriod, StatementFile } from '@/lib/records/statements';
import type { Message } from '@/lib/records/messages';
import type { PhoneCall } from '@/lib/phone/calls';
import type { PhoneMessage } from '@/lib/phone/messages';
import type { Note } from '@/lib/records/notes';
import type { RecordResiduals } from '@/lib/records/recordResiduals';

type Grant = 'hidden' | 'view' | 'edit';

/** One `repeat_group` `fields` row, as it renders at ITS OWN tab/subtab
 * location — `schema` is only the member fields that live here ('owner_private'
 * carries just SSN; 'owner_ownership' carries the other six), but `count` is
 * the SHARED instance count across every sibling location (migration 27),
 * computed server-side so both locations always agree on how many instances
 * exist even though each only shows its own slice of the data. */
import { textableNumbers } from '@/lib/phone/textableNumbers';

export type RepeatGroupDef = {
  id: string;
  key: string;
  label: string;
  max: number;
  schema: {
    key: string;
    label: string;
    type: ProtoField['type'];
    sensitive?: boolean;
    /** Inbound texts match against this sub-field — see textableNumbers.ts. */
    sync?: boolean;
    /** Shown in the (i) beside the member's label. */
    hint?: string;
    /** Allowed lengths for a digits-only member (an SSN is 9). */
    digits?: number[];
  }[];
  values: Record<string, unknown>[];
  count: number;
};

export type TabPayload = {
  id: string;
  key: string;
  label: string;
  kind: string;
  /** This tab's own grant, already capped by the module's — Phase: grant
   * chain. Per tab rather than per drawer, because a member can hold Edit on
   * a module and View on one tab inside it. A Hidden tab never arrives here
   * at all; the page drops it from the strip. */
  editable: boolean;
  count?: number;
  fieldCompleteness?: { have: number; need: number };
  subtabs: { id: string; key: string; label: string; description: string | null; comingSoon: boolean }[];
  fieldsBySubtab: Record<string, ProtoField[]>;
  repeatGroupsBySubtab: Record<string, RepeatGroupDef[]>;
  hasCustomFieldOrderBySubtab: Record<string, boolean>;
};

export function DrawerTabs({
  moduleSlug,
  recordId,
  tabs,
  grantByKey,
  values,
  updatedAt,
  cases,
  caseHandlingNote,
  repliesByCase,
  managersByCase,
  attachmentsByCase,
  updates,
  teamRoster,
  applicationRows,
  filesByRow,
  logins,
  statementPeriods,
  statementFiles,
  residuals,
  messages,
  phoneCalls,
  smsMessages,
  notesByScope,
  authorNames,
  viewerId,
  isAdmin,
  openTabId,
  openSubtabId,
  caseRoster = [],
  mentions: initialMentions = [],
  openMention = null,
  fieldPathByUpdate = {},
}: {
  /** Field-mention entries in Updates: the field's home, as labels. */
  fieldPathByUpdate?: Record<string, FieldPath>;
  moduleSlug: string;
  recordId: string;
  tabs: TabPayload[];
  /** Who may be @mentioned on this record's cases. */
  caseRoster?: Candidate[];
  /** The viewer's unread @mentions on this record, oldest first. */
  mentions?: NotificationView[];
  /** The mention a link landed on — already marked read; scrolled to and flashed. */
  openMention?: NotificationView | null;
  /** Already resolved from `?tab=`/`?subtab=` against the tabs this viewer can
   *  see, so these are either usable ids or null — never a hidden tab. */
  openTabId?: string | null;
  openSubtabId?: string | null;
  grantByKey: Record<string, Grant>;
  values: Record<string, unknown>;
  updatedAt: string;
  cases: CaseThread[];
  /** The record's standing "how to handle tickets here" instruction, shown
   *  at the top of Cases. Null when nobody has written one. */
  caseHandlingNote: CaseHandlingNote;
  repliesByCase: Record<string, CaseReply[]>;
  managersByCase: Record<string, string[]>;
  /** Files on each case's Issue, Solution and replies — Modules §3.7. */
  attachmentsByCase: Record<string, CaseAttachmentMap>;
  updates: Update[];
  teamRoster: TeamRosterEntry[];
  applicationRows: FileRow[];
  filesByRow: Record<string, FileEntry[]>;
  logins: LoginRow[];
  statementPeriods: StatementPeriod[];
  statementFiles: StatementFile[];
  /**
   * Null when the Residuals tab is hidden for this viewer, so nothing was
   * fetched. Distinct from `{ kind: 'admin_only' }`, which means the tab IS
   * shown and the figures behind it are not.
   */
  residuals: RecordResiduals | null;
  messages: Message[];
  phoneCalls: PhoneCall[];
  smsMessages: PhoneMessage[];
  notesByScope: Record<string, Note[]>;
  authorNames: Record<string, string>;
  viewerId: string;
  isAdmin: boolean;
}) {
  const [activeTabId, setActiveTabId] = useState(openTabId ?? tabs[0]?.id ?? '');
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  /*
   * My unread mentions on this record. Held here so reading one (from a
   * field dot, a thread, a link) clears its markers everywhere at once, and
   * refetched when the live count says something changed in another tab.
   */
  const [mentions, setMentions] = useState(initialMentions);
  const onMentionRead = (id: string) => setMentions((l) => l.filter((m) => m.id !== id));
  useEffect(() => {
    const on = () => {
      void recordMentionsAction({ recordId }).then(setMentions);
    };
    window.addEventListener(CHANGED_EVENT, on);
    return () => window.removeEventListener(CHANGED_EVENT, on);
  }, [recordId]);
  const mentionsByTab = useMemo(() => {
    const byTab: Record<string, number> = {};
    const bySubtab: Record<string, number> = {};
    const byField: Record<string, NotificationView[]> = {};
    const byUpdate: Record<string, NotificationView> = {};
    const byCase: Record<string, NotificationView[]> = {};
    for (const m of mentions) {
      if (m.tabKey) byTab[m.tabKey] = (byTab[m.tabKey] ?? 0) + 1;
      if (m.tabKey && m.subtabKey) bySubtab[`${m.tabKey}/${m.subtabKey}`] = (bySubtab[`${m.tabKey}/${m.subtabKey}`] ?? 0) + 1;
      if (m.fieldKey) (byField[m.fieldKey] ??= []).push(m);
      // A field mention also has an update id (its feed entry), but it is
      // read on the FIELD; the feed shows it without a dot.
      if (m.updateId && m.sourceKind === 'mention_update') byUpdate[m.updateId] = m;
      if (m.caseId) (byCase[m.caseId] ??= []).push(m);
    }
    return { byTab, bySubtab, byField, byUpdate, byCase };
  }, [mentions]);

  /* Every visible tab read-only means the ceiling is the MODULE, not any one
   * tab — a different setting, on a different screen, so the notice below says
   * so rather than blaming whichever tab happens to be open. */
  const readOnlyThroughout = tabs.length > 0 && tabs.every((t) => !t.editable);
  const [activeSubtabId, setActiveSubtabId] = useState<string | undefined>(
    openSubtabId ?? activeTab?.subtabs[0]?.id,
  );
  // A deep link into a drawer that is already open: follow it. (The two props
  // were read once, so a notification click on an open record did nothing.)
  // State adjusted during render from the previous props — React's own
  // pattern for "react to a prop change", with no effect round-trip.
  const target = `${openTabId ?? ''}/${openSubtabId ?? ''}/${openMention?.id ?? ''}`;
  const [seenTarget, setSeenTarget] = useState(target);
  if (seenTarget !== target) {
    setSeenTarget(target);
    if (openTabId) {
      setActiveTabId(openTabId);
      setActiveSubtabId(openSubtabId ?? tabs.find((t) => t.id === openTabId)?.subtabs[0]?.id);
    }
  }

  /*
   * ⚠️ THE EDITED VALUES LIVE HERE, not inside `RealFieldGrid`.
   *
   * They used to be `useState(initialValues)` in the grid, which loses them the
   * moment the grid unmounts — and it unmounts on every switch to a tab that is
   * not a field tab (Communication, Updates, Cases, Files, Logins,
   * Statements). Coming back re-seeded from the SERVER-rendered values, and
   * those are stale by design: `setValueAction` deliberately skips
   * `revalidatePath` because recomputing this whole route cost ~1.9s on the
   * most frequent interaction in the app. So the props still described the
   * record as it was when the drawer opened.
   *
   * The result looked like catastrophic data loss: fill in the Overview tab,
   * visit Communication, come back, and every field is blank again. The
   * database had every value the whole time — verified directly on the live
   * record — but nothing on screen said so, and the natural response is to
   * type it all in a second time.
   *
   * `DrawerTabs` stays mounted for the life of the open drawer, so holding the
   * values here makes them survive every tab and subtab switch. Closing and
   * reopening the drawer is a fresh server render that reads the database, so
   * that path was always correct and still is.
   */
  const [liveValues, setLiveValues] = useState(values);

  /*
   * The numbers this record can be texted on, gathered from EVERY tab rather
   * than the one that happens to be open: the phone lives on Contact and the
   * text box lives on Communication, so a per-tab scan would always come back
   * empty. `liveValues` rather than `values`, so a number typed into the
   * Contact tab is textable without a reload.
   */
  const recordPhones = useMemo(
    () =>
      textableNumbers(
        tabs.flatMap((t) =>
          Object.keys(t.fieldsBySubtab).map((subtabKey) => ({
            fields: t.fieldsBySubtab[subtabKey] ?? [],
            groups: t.repeatGroupsBySubtab[subtabKey] ?? [],
          })),
        ),
        liveValues,
      ),
    [tabs, liveValues],
  );
  const [conflicts, setConflicts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(0);
  /* How many field writes have landed successfully in this drawer session.
   * Drives the "All changes saved" confirmation — auto-save is only trustworthy
   * if it SAYS it saved, which is most of the reason a Save button feels safer
   * than one that silently does the same job. */
  const [savedCount, setSavedCount] = useState(0);

  /*
   * Re-seed when a genuinely NEW server render arrives — a different record, or
   * a `router.refresh()` from another panel. `values` is a fresh object
   * identity on every real server render and stable across purely client-side
   * re-renders, so reference equality is exactly the right signal (the same
   * reasoning `RecordsTable` documents for its `rowsSnapshot`).
   *
   * Local edits are layered back ON TOP, because a render triggered by some
   * other action still carries the stale field values described above and
   * would otherwise wipe them. A key we have written is a key we know the
   * current value of; everything else comes from the server.
   */
  const [valuesSnapshot, setValuesSnapshot] = useState(values);
  const editedKeys = useRef<Set<string>>(new Set());
  if (values !== valuesSnapshot) {
    setValuesSnapshot(values);
    setLiveValues((prev) => {
      const merged = { ...values };
      for (const k of editedKeys.current) merged[k] = prev[k];
      return merged;
    });
  }

  const selectTab = (id: string) => {
    setActiveTabId(id);
    const next = tabs.find((t) => t.id === id);
    setActiveSubtabId(next?.subtabs[0]?.id);
  };

  if (!activeTab) return null;

  const fields = activeTab.fieldsBySubtab[activeSubtabId ?? '_'] ?? [];
  /** The notes scope for whatever is on screen: one thread per tab, or per
   *  subtab where the tab has them. Matches the `tab:<id>` / `tab:<id>/<sub>`
   *  keys `allNotesFor` groups by. */
  const tabScopeId = activeSubtabId ? `${activeTab.id}/${activeSubtabId}` : activeTab.id;
  const activeSubtab = activeTab.subtabs.find((s) => s.id === activeSubtabId);

  return (
    <div className="mt-4">
      <nav className="-mb-px flex gap-0.5 overflow-x-auto border-b border-line">
        {tabs.map((t) => {
          const active = t.id === activeTab.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => selectTab(t.id)}
              className={`flex shrink-0 items-center whitespace-nowrap border-b-2 px-2.5 py-2 text-[13px] font-medium transition-colors duration-150 ${
                active ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-500 hover:border-line hover:text-ink-900'
              }`}
            >
              {t.label}
              {/* A tab the viewer cannot edit says so in the strip, so "why
                * won't this save" is answered before they try. Hidden tabs
                * never reach here — the page drops them entirely. */}
              {!t.editable ? (
                <Icon
                  name="lock"
                  size={11}
                  className={`ml-1.5 shrink-0 ${active ? 'text-brand-600' : 'text-ink-400'}`}
                />
              ) : null}
              {t.count != null ? <CountPill n={t.count} active={active} /> : null}
              {mentionsByTab.byTab[t.key] ? <MentionPill n={mentionsByTab.byTab[t.key]} /> : null}
              {t.fieldCompleteness ? (
                <span className="ml-1.5">
                  <CompletenessBadge have={t.fieldCompleteness.have} need={t.fieldCompleteness.need} />
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {/*
        ── WHY A SENTENCE AND NOT JUST DISABLED INPUTS ───────────────────────
        A read-only tab used to render fields that simply refused to accept
        typing, with nothing on screen explaining it. That reads as a broken
        page, not as a permission — the same confusion a missing tab causes
        when nobody says the tab was hidden on purpose.

        The wording distinguishes the two cases, because the fix is different:
        the whole record being view-only is a MODULE grant, while one tab being
        view-only is a TAB grant, and an admin looking for the setting needs to
        know which screen to open.
      */}
      {!activeTab.editable ? (
        <div className="flex items-center gap-2 border-b border-line-soft bg-warn-bg px-3 py-1.5 text-[12px] leading-snug text-ink-700">
          <Icon name="lock" size={12} className="shrink-0 text-warn" />
          <span>
            {readOnlyThroughout ? (
              <>
                <strong className="font-semibold">Read-only.</strong> You have view access to this
                record, so nothing on it can be changed.
              </>
            ) : (
              <>
                <strong className="font-semibold">Read-only.</strong> {activeTab.label} is view-only
                for you — other tabs on this record may still be editable.
              </>
            )}
          </span>
        </div>
      ) : null}

      {/*
        A chooser is only worth drawing where there is a choice. The Files tab
        is down to one subtab since "Other files" was folded into Application
        (migration 750), and a strip holding a single chip is a control that
        can only tell you where you already are — it reads as though something
        is missing beside it.
      */}
      {activeTab.subtabs.length > 1 ? (
        <div className="flex gap-1 overflow-x-auto border-b border-line-soft bg-canvas/50 px-1 py-1.5">
          {activeTab.subtabs.map((s) => {
            const active = s.id === activeSubtabId;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setActiveSubtabId(s.id)}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors duration-150 ${
                  active ? 'bg-brand-600 text-white' : 'text-ink-500 hover:bg-canvas'
                }`}
              >
                {s.label}
                {mentionsByTab.bySubtab[`${activeTab.key}/${s.key}`] ? <MentionPill n={mentionsByTab.bySubtab[`${activeTab.key}/${s.key}`]} onDark={active} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {/*
        `key` on the panel, so switching tab or subtab REMOUNTS this subtree and
        the settle animation plays. Without the key React would reconcile the
        two panels in place and the content would swap with no transition at
        all — the strip would move and the body would simply be different, which
        reads as a page that skipped a frame.

        `animate-settle` is a 120ms fade with a 2px drop: enough to say "this is
        new content", short enough that it is finished before you have moved
        your eyes down to read it.
      */}
      <div key={`${activeTab.id}/${activeSubtabId ?? '_'}`} className="animate-settle py-4">
        {activeSubtab?.description ? (
          <p className="mb-3 border-l-2 border-line pl-3 text-[12.5px] italic leading-relaxed text-ink-500">
            {activeSubtab.description}
          </p>
        ) : null}

        {/*
          Scoped per tab via `key`: a tab that failed must not stay failed once
          the user navigates to a different one, and "Try again" on a remounted
          boundary should retry THIS tab, not whichever one broke earlier.
        */}
        <PanelErrorBoundary key={`${activeTab.id}/${activeSubtabId ?? '_'}`}>
        {activeTab.kind === 'custom' ? (
          (() => {
            return (
              <div className="space-y-4">
                <RealFieldGrid
                  moduleSlug={moduleSlug}
                  recordId={recordId}
                  tabId={activeTab.id}
                  subtabId={activeSubtabId ?? null}
                  fields={fields}
                  repeatGroups={activeTab.repeatGroupsBySubtab[activeSubtabId ?? '_'] ?? []}
                  hasCustomFieldOrder={activeTab.hasCustomFieldOrderBySubtab[activeSubtabId ?? '_'] ?? false}
                  grantByKey={grantByKey}
                  values={liveValues}
                  setValues={setLiveValues}
                  conflicts={conflicts}
                  setConflicts={setConflicts}
                  saving={saving}
                  setSaving={setSaving}
                  savedCount={savedCount}
                  onSaved={() => setSavedCount((n) => n + 1)}
                  markEdited={(key) => editedKeys.current.add(key)}
                  initialUpdatedAt={updatedAt}
                  notesByField={notesByScope}
                  authorNames={authorNames}
                  viewerId={viewerId}
                  isAdmin={isAdmin}
                  mentionsByField={mentionsByTab.byField}
                  openMention={openMention?.fieldKey ? openMention : null}
                  onMentionRead={onMentionRead}
                />
              </div>
            );
          })()
        ) : activeTab.kind === 'cases' ? (
          <CasesPanel
            moduleSlug={moduleSlug}
            recordId={recordId}
            handlingNote={caseHandlingNote}
            cases={cases}
            repliesByCase={repliesByCase}
            managersByCase={managersByCase}
            attachmentsByCase={attachmentsByCase}
            authorNames={authorNames}
            viewerId={viewerId}
            isAdmin={isAdmin}
            editable={activeTab.editable}
            caseRoster={caseRoster}
            mentionsByCase={mentionsByTab.byCase}
            openMention={openMention?.caseId ? openMention : null}
          />
        ) : activeTab.kind === 'updates' ? (
          <UpdatesPanel
            moduleSlug={moduleSlug}
            recordId={recordId}
            updates={updates}
            authorNames={authorNames}
            viewerId={viewerId}
            isAdmin={isAdmin}
            teamRoster={teamRoster}
            editable={activeTab.editable}
            mentionsByUpdate={mentionsByTab.byUpdate}
            openMention={openMention?.sourceKind === 'mention_update' ? openMention : null}
            fieldPathByUpdate={fieldPathByUpdate}
          />
        ) : activeTab.kind === 'files' ? (
          <FilesPanel
            moduleSlug={moduleSlug}
            recordId={recordId}
            /* One list since migration 750 — "Other files" was folded in and
               its rows migrated, so there is no second branch to take. */
            kind="application"
            rows={applicationRows}
            filesByRow={filesByRow}
            editable={activeTab.editable}
          />
        ) : activeTab.kind === 'logins' ? (
          <LoginsPanel moduleSlug={moduleSlug} recordId={recordId} logins={logins} editable={activeTab.editable} />
        ) : activeTab.kind === 'statements' ? (
          <StatementsPanel
            moduleSlug={moduleSlug}
            recordId={recordId}
            periods={statementPeriods}
            files={statementFiles}
            editable={activeTab.editable}
          />
        ) : activeTab.kind === 'residuals' ? (
          /*
            The sixth module's own tab. The renderer switches on the tab KIND,
            never on the module — which module carries this tab is a row in
            `module_tab_order`, so putting it on Deals as well would be
            configuration rather than a change here.
          */
          residuals === null ? (
            <p className="flex items-center gap-2 text-[13px] text-ink-400">
              <Icon name="lock" size={13} />
              Residual figures are not available to you.
            </p>
          ) : (
            <ResidualsPanel data={residuals} />
          )
        ) : activeTab.kind === 'communication' ? (
          <CommunicationPanel
            subtabId={activeSubtab?.key ?? 'email'}
            comingSoon={activeSubtab?.comingSoon ?? false}
            subtabLabel={activeSubtab?.label ?? ''}
            messages={messages}
            moduleSlug={moduleSlug}
            calls={phoneCalls}
            smsMessages={smsMessages}
            recordPhones={recordPhones}
          />
        ) : (
          <p className="flex items-center gap-2 text-[13px] text-ink-400">
            <Icon name="clock" size={13} />
            {activeTab.label} — real-build wiring for this tab lands in a follow-up pass.
          </p>
        )}
        </PanelErrorBoundary>

        {/*
          ⚠️ ONE notes thread, for EVERY tab and EVERY subtab.
          
          The client asked for this twice and literally: "Each tab should have a
          notes field" / "Each sub tab should have a notes field." It used to
          live INSIDE the `custom` branch above, so only the 15 field-bearing
          locations had one. The other 13 — Other, all six Communication
          subtabs, Updates, Cases, both Files subtabs, Logins and Statements —
          had none at all, even though the prototype did have them.

          Rendered OUTSIDE `PanelErrorBoundary` on purpose: a panel that fails
          should not take the record's notes down with it, and the notes are
          often where someone recorded why the thing that just broke matters.

          The scope id is subtab-aware, so Communication → Email and
          Communication → Text keep separate threads, which is what "each sub
          tab" means.
        */}
        <div className="mt-4">
          <TabNotes
            moduleSlug={moduleSlug}
            recordId={recordId}
            scopeId={tabScopeId}
            notes={notesByScope[`tab:${tabScopeId}`] ?? []}
            authorNames={authorNames}
            viewerId={viewerId}
            isAdmin={isAdmin}
          />
        </div>
      </div>
    </div>
  );
}

/** "@ 2" on a tab or sub-tab: unread mentions for the viewer inside it. Brand-coloured, unlike the neutral record counts. */
function MentionPill({ n, onDark = false }: { n: number; onDark?: boolean }) {
  return (
    <span
      title={`${n} unread mention${n === 1 ? '' : 's'} for you here`}
      className={`ml-1.5 inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[10.5px] font-bold tabular ${onDark ? 'bg-white/20 text-white' : 'bg-brand-600 text-white'}`}
    >
      <Icon name="at-sign" size={9} strokeWidth={2.5} />
      {n}
    </span>
  );
}
