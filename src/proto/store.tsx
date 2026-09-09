'use client';

/**
 * PROTOTYPE — in-memory state.
 *
 * Holds the sample data and the mutations the walkthrough needs. Everything is
 * React state: nothing is saved, and a refresh resets it.
 *
 * Two things here carry more weight than the rest:
 *
 *   toggleMembership() — one record, many display modules. Check a box and the
 *   record appears there immediately with every value intact, because there is
 *   only ever one copy of it.
 *
 *   VIEWERS — switching who you are re-filters the nav, the rows AND the
 *   columns. A field you cannot see produces an ABSENT column, never a blank
 *   cell.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  ACTIVITY,
  CASES,
  CUSTOM_ENTRIES,
  DEFAULT_VIEWER,
  NOTES,
  RECORDS,
  UPDATES,
  USER_BY_ID,
  NEXT_CASE_NUMBER,
  TODAY,
  valueKey,
} from './data';
import { FIELDS } from './fields';
import { MODULES } from './modules';
import { resolveOrder } from './schema';
import type {
  ActivityEntry,
  CaseThread,
  ColumnOrderPref,
  CustomEntry,
  Field,
  FieldOrderPref,
  FieldValue,
  Filter,
  FilterPref,
  Module,
  ModuleSlug,
  Note,
  RecordRow,
  Update,
} from './schema';

/* -------------------------------------------------------------------------- */
/* Permission profiles — the Hidden / View / Edit model                        */
/* -------------------------------------------------------------------------- */

export type Grant = 'hidden' | 'view' | 'edit';

export type Viewer = {
  userId: string;
  label: string;
  isAdmin: boolean;
  /** Modules this profile can reach. Absent modules never render in the nav. */
  modules: ModuleSlug[];
  /** Explicit per-field grants. Anything unlisted defaults to `edit`. */
  grants: Record<string, Grant>;
  /** Whether row visibility is limited to records they are Team member on. */
  ownRecordsOnly: boolean;
};

const SENSITIVE_IDS = FIELDS.filter((f) => f.sensitive).map((f) => f.id);
const PRIVATE_TAB_IDS = FIELDS.filter((f) => f.tab === 'application/private').map((f) => f.id);
const MARKETING_IDS = FIELDS.filter((f) => f.tab === 'marketing').map((f) => f.id);

function grantsOf(hidden: string[], view: string[] = []): Record<string, Grant> {
  const out: Record<string, Grant> = {};
  for (const id of hidden) out[id] = 'hidden';
  for (const id of view) out[id] = 'view';
  return out;
}

export const VIEWERS: Viewer[] = [
  {
    userId: 'u_izzy',
    label: 'Super admin',
    isAdmin: true,
    modules: ['records', 'leads', 'deals', 'contacts', 'tickets', 'residuals'],
    grants: {},
    ownRecordsOnly: false,
  },
  {
    userId: 'u_sarah',
    label: 'Sales rep',
    isAdmin: false,
    // No Records List, no Residuals. Absent from the nav, not greyed out.
    modules: ['leads', 'deals', 'contacts', 'tickets'],
    grants: grantsOf(PRIVATE_TAB_IDS, ['risk_level', 'relationship_manager']),
    ownRecordsOnly: true,
  },
  {
    userId: 'u_priya',
    label: 'Accounting',
    isAdmin: false,
    modules: ['residuals', 'contacts'],
    // Sees the money, not the marketing.
    grants: grantsOf(
      SENSITIVE_IDS.filter((id) => id !== 'ein'),
      MARKETING_IDS,
    ),
    ownRecordsOnly: false,
  },
  {
    userId: 'u_dana',
    label: 'Underwriting',
    isAdmin: false,
    modules: ['deals', 'tickets'],
    // Underwriting needs the Private tab — that is the whole job.
    grants: grantsOf([], MARKETING_IDS),
    ownRecordsOnly: false,
  },
];

/* -------------------------------------------------------------------------- */
/* Context                                                                     */
/* -------------------------------------------------------------------------- */

type Store = {
  now: Date;

  records: RecordRow[];
  updates: Update[];
  cases: CaseThread[];
  activity: ActivityEntry[];
  notes: Note[];
  customEntries: CustomEntry[];

  /** Sidebar collapsed to an icon rail. Lives here so it survives navigation. */
  navCollapsed: boolean;
  toggleNav: () => void;

  viewer: Viewer;
  setViewerId: (id: string) => void;
  visibleModules: Module[];

  grantFor: (field: Field) => Grant;
  canSeeRecord: (r: RecordRow) => boolean;
  /** Columns for a module, permission-filtered. Hidden fields are ABSENT. */
  columnsForViewer: (moduleSlug: string) => Field[];
  rowsFor: (moduleSlug: string) => RecordRow[];

  /** Reads through the per-module key for fields with per-module choices. */
  readValue: (r: RecordRow, field: Field, moduleSlug?: string) => FieldValue;
  setValue: (recordId: string, fieldId: string, value: FieldValue, moduleSlug?: string) => void;

  toggleMembership: (recordId: string, module: ModuleSlug) => void;
  setMemberships: (recordId: string, modules: ModuleSlug[]) => void;
  setPipelineStep: (recordId: string, module: ModuleSlug, pipelineId: string, stepId: string) => void;
  clearPipeline: (recordId: string, module: ModuleSlug) => void;
  deleteRecord: (recordId: string) => void;
  restoreRecord: (recordId: string) => void;

  addUpdate: (recordId: string, body: string, parentId?: string) => void;
  addCase: (recordId: string, title: string, issue: string) => void;
  addCaseReply: (caseId: string, body: string) => void;
  setCaseSolution: (caseId: string, solution: string) => void;
  toggleCaseState: (caseId: string) => void;
  logCredentialReveal: (recordId: string, loginType: string) => void;

  /** Notes, on a field or on a tab — one table, two scopes. */
  notesFor: (recordId: string, scopeKind: Note['scopeKind'], scopeId: string) => Note[];
  addNote: (recordId: string, scopeKind: Note['scopeKind'], scopeId: string, body: string) => void;
  editNote: (noteId: string, body: string) => void;
  deleteNote: (noteId: string) => void;

  /** The "Other" tab — per-record entries with no field definition. */
  entriesFor: (recordId: string) => CustomEntry[];
  addEntry: (recordId: string, label: string, value: string) => void;
  updateEntry: (entryId: string, label: string, value: string) => void;
  deleteEntry: (entryId: string) => void;

  /** Repeatable groups — "add new owner, up to 5 owners". */
  instanceCount: (recordId: string, groupKey: string) => number;
  addInstance: (recordId: string, groupKey: string, max: number) => void;
  removeInstance: (recordId: string, groupKey: string, index: number) => void;

  /**
   * 19 Aug amendment — per-user personalization. "Admin default → user
   * override → permission filter." `columnsForViewer` already applies this;
   * these are the read/write surface a drag interaction calls directly.
   * Scoped to the CURRENT viewer only — switching viewers in the sidebar
   * switches whose personalization is in effect, exactly like switching
   * whose permissions are in effect.
   */
  setColumnOrder: (moduleSlug: ModuleSlug, orderedFieldIds: string[]) => void;
  resetColumnOrder: (moduleSlug: ModuleSlug) => void;
  hasCustomColumnOrder: (moduleSlug: ModuleSlug) => boolean;
  /** `placement` is a tab id, or `tabId/subtabId` — same shape as `Field.tab`. */
  fieldOrderFor: (placement: string, adminOrder: string[]) => string[];
  setFieldOrder: (placement: string, orderedFieldIds: string[]) => void;
  resetFieldOrder: (placement: string) => void;
  hasCustomFieldOrder: (placement: string) => boolean;
  /**
   * Filters — "upgraded from session-only to durable — server-side per user
   * per module." No admin default layer here (unlike columns/fields): a
   * filter is entirely the user's own, so there's nothing to reset TO, only
   * to clear.
   */
  filtersFor: (moduleSlug: ModuleSlug) => Record<string, Filter>;
  setFilters: (moduleSlug: ModuleSlug, filters: Record<string, Filter>) => void;
  clearFilters: (moduleSlug: ModuleSlug) => void;
};

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore must be used inside <ProtoProvider>');
  return s;
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}_${++seq}`;

/** Stable empty-object reference — a fresh `{}` every render would break any
 *  consumer that memoizes on `filtersFor`'s return value by identity. */
const EMPTY_FILTERS: Record<string, Filter> = {};

/* -------------------------------------------------------------------------- */

export function ProtoProvider({ children }: { children: ReactNode }) {
  const [records, setRecords] = useState<RecordRow[]>(RECORDS);
  const [updates, setUpdates] = useState<Update[]>(UPDATES);
  const [cases, setCases] = useState<CaseThread[]>(CASES);
  const [activity, setActivity] = useState<ActivityEntry[]>(ACTIVITY);
  const [notes, setNotes] = useState<Note[]>(NOTES);
  const [customEntries, setCustomEntries] = useState<CustomEntry[]>(CUSTOM_ENTRIES);
  const [viewerId, setViewerId] = useState(DEFAULT_VIEWER);
  /*
   * Per-user personalization, keyed by user id so switching the viewer also
   * switches whose drag-reordering is in effect — proves the "never affects
   * any other user" guarantee before Stage 2 makes this a real per-user table.
   */
  const [columnOrderByUser, setColumnOrderByUser] = useState<Record<string, ColumnOrderPref>>({});
  const [fieldOrderByUser, setFieldOrderByUser] = useState<Record<string, FieldOrderPref>>({});
  const [filtersByUser, setFiltersByUser] = useState<Record<string, FilterPref>>({});
  const [navCollapsed, setNavCollapsed] = useState(false);

  const viewer = useMemo(
    () => VIEWERS.find((v) => v.userId === viewerId) ?? VIEWERS[0]!,
    [viewerId],
  );

  const log = useCallback(
    (recordId: string, kind: ActivityEntry['kind'], summary: string, from?: string, to?: string) => {
      setActivity((prev) => [
        {
          id: nextId('act'),
          recordId,
          actorId: viewer.userId,
          at: new Date().toISOString(),
          kind,
          summary,
          from,
          to,
        },
        ...prev,
      ]);
    },
    [viewer.userId],
  );

  /* --- permissions ------------------------------------------------------ */

  const grantFor = useCallback(
    (field: Field): Grant => {
      // Deal Name floor: never Hidden for anyone with module access.
      if (field.id === 'deal_name') return viewer.isAdmin ? 'edit' : 'view';
      // Record creator is read-only forever, for everyone, including admins.
      if (field.readOnly) return 'view';
      /*
       * Repeated instances inherit the template's grant: owner_3_ssn is as
       * sensitive as owner_1_ssn, and nobody lists them all by hand.
       */
      const template = field.id.replace(/_(\d+)_/, '_1_');
      return viewer.grants[field.id] ?? viewer.grants[template] ?? 'edit';
    },
    [viewer],
  );

  const canSeeRecord = useCallback(
    (r: RecordRow) => {
      if (viewer.isAdmin || !viewer.ownRecordsOnly) return true;
      /*
       * ONLY "Team member(s) assigned" grants visibility. Record creator grants
       * nothing, and Relationship manager is informational — the client was
       * explicit about both.
       */
      const team = (r.values.team_members_assigned as string[] | undefined) ?? [];
      return team.includes(viewer.userId);
    },
    [viewer],
  );

  const visibleModules = useMemo(
    () => MODULES.filter((m) => viewer.modules.includes(m.slug)),
    [viewer],
  );

  const columnsForViewer = useCallback(
    (moduleSlug: string) => {
      // Layer 1: admin default — the configured column set, admin order.
      const visible = FIELDS.filter((f) => f.columnIn.includes(moduleSlug as never))
        .filter((f) => grantFor(f) !== 'hidden') // Layer 3 applies here: absent column, never blank
        .sort((a, b) => (a.columnOrder ?? 999) - (b.columnOrder ?? 999));

      // Deal Name is not in `columnIn` (it's the hardcoded frozen column, drawn
      // separately by DataTable) so it never enters this list and can never be
      // dragged — the amendment's "not draggable, nothing can land before it"
      // is true by construction here, not by a check somewhere else.

      // Layer 2: this user's saved order, applied on top.
      const pref = columnOrderByUser[viewer.userId]?.[moduleSlug as ModuleSlug];
      if (!pref) return visible;
      const byId = new Map(visible.map((f) => [f.id, f]));
      const adminIds = visible.map((f) => f.id);
      return resolveOrder(adminIds, pref)
        .map((id) => byId.get(id))
        .filter((f): f is Field => Boolean(f));
    },
    [grantFor, columnOrderByUser, viewer.userId],
  );

  /* --- personalization ---------------------------------------------------
   * "Admin default → user override → permission filter." Order only — this
   * never adds or removes a column/field, only resequences what the admin
   * and the permission gate have already decided is visible. Not written to
   * the activity log: the client's own words, "pure UI preference, would be
   * noise."
   * ------------------------------------------------------------------- */

  const setColumnOrder = useCallback(
    (moduleSlug: ModuleSlug, orderedFieldIds: string[]) => {
      setColumnOrderByUser((prev) => ({
        ...prev,
        [viewer.userId]: { ...prev[viewer.userId], [moduleSlug]: orderedFieldIds },
      }));
    },
    [viewer.userId],
  );

  const resetColumnOrder = useCallback(
    (moduleSlug: ModuleSlug) => {
      setColumnOrderByUser((prev) => {
        const mine = { ...prev[viewer.userId] };
        delete mine[moduleSlug];
        return { ...prev, [viewer.userId]: mine };
      });
    },
    [viewer.userId],
  );

  const hasCustomColumnOrder = useCallback(
    (moduleSlug: ModuleSlug) => Boolean(columnOrderByUser[viewer.userId]?.[moduleSlug]?.length),
    [columnOrderByUser, viewer.userId],
  );

  const fieldOrderFor = useCallback(
    (placement: string, adminOrder: string[]) => {
      const pref = fieldOrderByUser[viewer.userId]?.[placement];
      return resolveOrder(adminOrder, pref);
    },
    [fieldOrderByUser, viewer.userId],
  );

  const setFieldOrder = useCallback(
    (placement: string, orderedFieldIds: string[]) => {
      setFieldOrderByUser((prev) => ({
        ...prev,
        [viewer.userId]: { ...prev[viewer.userId], [placement]: orderedFieldIds },
      }));
    },
    [viewer.userId],
  );

  const resetFieldOrder = useCallback(
    (placement: string) => {
      setFieldOrderByUser((prev) => {
        const mine = { ...prev[viewer.userId] };
        delete mine[placement];
        return { ...prev, [viewer.userId]: mine };
      });
    },
    [viewer.userId],
  );

  const hasCustomFieldOrder = useCallback(
    (placement: string) => Boolean(fieldOrderByUser[viewer.userId]?.[placement]?.length),
    [fieldOrderByUser, viewer.userId],
  );

  const filtersFor = useCallback(
    (moduleSlug: ModuleSlug) => filtersByUser[viewer.userId]?.[moduleSlug] ?? EMPTY_FILTERS,
    [filtersByUser, viewer.userId],
  );

  const setFilters = useCallback(
    (moduleSlug: ModuleSlug, filters: Record<string, Filter>) => {
      setFiltersByUser((prev) => ({
        ...prev,
        [viewer.userId]: { ...prev[viewer.userId], [moduleSlug]: filters },
      }));
    },
    [viewer.userId],
  );

  const clearFilters = useCallback(
    (moduleSlug: ModuleSlug) => {
      setFiltersByUser((prev) => {
        const mine = { ...prev[viewer.userId] };
        delete mine[moduleSlug];
        return { ...prev, [viewer.userId]: mine };
      });
    },
    [viewer.userId],
  );

  const rowsFor = useCallback(
    (moduleSlug: string) => {
      const live = records.filter((r) => !r.deleted);
      const inModule =
        moduleSlug === 'records'
          ? live // the master store holds everything, archived included
          : live.filter((r) => r.memberships.includes(moduleSlug as ModuleSlug));
      return inModule.filter(canSeeRecord);
    },
    [records, canSeeRecord],
  );

  /* --- values ----------------------------------------------------------- */

  const readValue = useCallback(
    (r: RecordRow, field: Field, moduleSlug?: string): FieldValue => {
      if (field.id === 'deal_name') return r.dealName;
      return r.values[valueKey(field.id, moduleSlug)] ?? null;
    },
    [],
  );

  const setValue = useCallback(
    (recordId: string, fieldId: string, value: FieldValue, moduleSlug?: string) => {
      const field = FIELDS.find((f) => f.id === fieldId);
      const key = valueKey(fieldId, moduleSlug);
      const before = records.find((r) => r.id === recordId)?.values[key];

      setRecords((prev) =>
        prev.map((r) => {
          if (r.id !== recordId) return r;
          return fieldId === 'deal_name'
            ? { ...r, dealName: String(value ?? '') }
            : { ...r, values: { ...r.values, [key]: value } };
        }),
      );

      const show = (v: FieldValue) =>
        v == null || v === '' ? '(empty)' : Array.isArray(v) ? v.join(', ') : String(v);
      log(recordId, 'field', `${field?.label ?? fieldId} changed`, show(before ?? null), show(value));
    },
    [log, records],
  );

  /* --- memberships ------------------------------------------------------ */

  const setMemberships = useCallback(
    (recordId: string, modules: ModuleSlug[]) => {
      const before = records.find((r) => r.id === recordId)?.memberships ?? [];
      setRecords((prev) =>
        prev.map((r) => {
          if (r.id !== recordId) return r;
          // Dropping a module drops its pipeline too — pipelines are per-module,
          // so it has nowhere left to live.
          const pipeline = { ...r.pipeline };
          for (const key of Object.keys(pipeline) as ModuleSlug[]) {
            if (!modules.includes(key)) delete pipeline[key];
          }
          return { ...r, memberships: modules, pipeline };
        }),
      );

      const name = (s: ModuleSlug) => MODULES.find((m) => m.slug === s)?.label ?? s;
      const added = modules.filter((m) => !before.includes(m));
      const removed = before.filter((m) => !modules.includes(m));
      if (added.length) log(recordId, 'membership', `Displayed in ${added.map(name).join(', ')}`);
      if (removed.length) log(recordId, 'membership', `Removed from ${removed.map(name).join(', ')}`);
      // Clearing the last display membership is ARCHIVE — never "delete".
      if (before.length > 0 && modules.length === 0) {
        log(recordId, 'record', 'Archived — no longer displayed in any module');
      }
    },
    [log, records],
  );

  const toggleMembership = useCallback(
    (recordId: string, module: ModuleSlug) => {
      const r = records.find((x) => x.id === recordId);
      if (!r) return;
      setMemberships(
        recordId,
        r.memberships.includes(module)
          ? r.memberships.filter((m) => m !== module)
          : [...r.memberships, module],
      );
    },
    [records, setMemberships],
  );

  const setPipelineStep = useCallback(
    (recordId: string, module: ModuleSlug, pipelineId: string, stepId: string) => {
      setRecords((prev) =>
        prev.map((r) =>
          r.id === recordId
            ? { ...r, pipeline: { ...r.pipeline, [module]: { pipelineId, stepId } } }
            : r,
        ),
      );
      log(recordId, 'pipeline', `Pipeline step changed in ${module}`);
    },
    [log],
  );

  const clearPipeline = useCallback(
    (recordId: string, module: ModuleSlug) => {
      setRecords((prev) =>
        prev.map((r) => {
          if (r.id !== recordId) return r;
          const pipeline = { ...r.pipeline };
          delete pipeline[module];
          return { ...r, pipeline };
        }),
      );
      log(recordId, 'pipeline', `Pipeline removed in ${module}`);
    },
    [log],
  );

  const deleteRecord = useCallback(
    (recordId: string) => {
      setRecords((prev) => prev.map((r) => (r.id === recordId ? { ...r, deleted: true } : r)));
      log(recordId, 'record', 'Deleted to the Recycle Bin');
    },
    [log],
  );

  const restoreRecord = useCallback(
    (recordId: string) => {
      // A restored record always comes back ARCHIVED: active in the Records
      // List, zero display memberships, ready to be re-displayed from there.
      setRecords((prev) =>
        prev.map((r) =>
          r.id === recordId ? { ...r, deleted: false, memberships: [], pipeline: {} } : r,
        ),
      );
      log(recordId, 'record', 'Restored from the Recycle Bin as an archived record');
    },
    [log],
  );

  /* --- updates and cases ------------------------------------------------ */

  const addUpdate = useCallback(
    (recordId: string, body: string, parentId?: string) => {
      setUpdates((prev) => [
        ...prev,
        {
          id: nextId('upd'),
          recordId,
          parentId,
          authorId: viewer.userId,
          body,
          at: new Date().toISOString(),
        },
      ]);
      log(recordId, 'update', parentId ? 'Replied to an update' : 'Posted an update');
    },
    [log, viewer.userId],
  );

  const addCase = useCallback(
    (recordId: string, title: string, issue: string) => {
      setCases((prev) => [
        {
          id: nextId('case'),
          recordId,
          // Straight off the global sequence. Numbers are never reused.
          number: NEXT_CASE_NUMBER + prev.length - CASES.length,
          title,
          issue,
          issueAuthorId: viewer.userId,
          issueAt: new Date().toISOString(),
          // The Issue author is automatically the first ticket manager.
          managerIds: [viewer.userId],
          state: 'open',
          replies: [],
        },
        ...prev,
      ]);
      log(recordId, 'case', `Case opened — ${title}`);
    },
    [log, viewer.userId],
  );

  const addCaseReply = useCallback(
    (caseId: string, body: string) => {
      const c = cases.find((x) => x.id === caseId);
      setCases((prev) =>
        prev.map((x) =>
          x.id === caseId
            ? {
                ...x,
                replies: [
                  ...x.replies,
                  {
                    id: nextId('crep'),
                    authorId: viewer.userId,
                    body,
                    at: new Date().toISOString(),
                  },
                ],
              }
            : x,
        ),
      );
      if (c) log(c.recordId, 'case', `Replied on case #${c.number}`);
    },
    [cases, log, viewer.userId],
  );

  const setCaseSolution = useCallback(
    (caseId: string, solution: string) => {
      setCases((prev) =>
        prev.map((c) =>
          c.id === caseId
            ? { ...c, solution, solutionAuthorId: viewer.userId, solutionAt: new Date().toISOString() }
            : c,
        ),
      );
      const c = cases.find((x) => x.id === caseId);
      if (c) log(c.recordId, 'case', `Solution written on case #${c.number}`);
    },
    [cases, log, viewer.userId],
  );

  const toggleCaseState = useCallback(
    (caseId: string) => {
      const c = cases.find((x) => x.id === caseId);
      if (!c) return;
      // A case cannot be Closed until its Solution has been written.
      if (c.state === 'open' && !c.solution) return;
      setCases((prev) =>
        prev.map((x) => (x.id === caseId ? { ...x, state: x.state === 'open' ? 'closed' : 'open' } : x)),
      );
      log(c.recordId, 'case', `Case #${c.number} ${c.state === 'open' ? 'closed' : 'reopened'}`);
    },
    [cases, log],
  );

  const logCredentialReveal = useCallback(
    (recordId: string, loginType: string) => {
      // Every reveal is audited: user, credential, timestamp.
      log(recordId, 'credential', `Revealed password — ${loginType}`);
    },
    [log],
  );

  /* --- notes ------------------------------------------------------------ */

  const notesFor = useCallback(
    (recordId: string, scopeKind: Note['scopeKind'], scopeId: string) =>
      notes
        .filter((n) => n.recordId === recordId && n.scopeKind === scopeKind && n.scopeId === scopeId)
        .sort((a, b) => (a.at < b.at ? -1 : 1)),
    [notes],
  );

  const scopeLabel = (kind: Note['scopeKind'], id: string) =>
    kind === 'field' ? (FIELDS.find((f) => f.id === id)?.label ?? id) : id;

  const addNote = useCallback(
    (recordId: string, scopeKind: Note['scopeKind'], scopeId: string, body: string) => {
      setNotes((prev) => [
        ...prev,
        {
          id: nextId('note'),
          recordId,
          scopeKind,
          scopeId,
          authorId: viewer.userId,
          body,
          at: new Date().toISOString(),
        },
      ]);
      log(recordId, 'field', `Note added on ${scopeLabel(scopeKind, scopeId)}`);
    },
    [log, viewer.userId],
  );

  const editNote = useCallback(
    (noteId: string, body: string) => {
      const note = notes.find((n) => n.id === noteId);
      setNotes((prev) => prev.map((n) => (n.id === noteId ? { ...n, body, edited: true } : n)));
      if (note) log(note.recordId, 'field', `Note edited on ${scopeLabel(note.scopeKind, note.scopeId)}`);
    },
    [notes, log],
  );

  const deleteNote = useCallback(
    (noteId: string) => {
      const note = notes.find((n) => n.id === noteId);
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      if (note) log(note.recordId, 'field', `Note deleted on ${scopeLabel(note.scopeKind, note.scopeId)}`);
    },
    [notes, log],
  );

  /* --- the "Other" tab -------------------------------------------------- */

  const entriesFor = useCallback(
    (recordId: string) => customEntries.filter((e) => e.recordId === recordId),
    [customEntries],
  );

  const addEntry = useCallback(
    (recordId: string, label: string, value: string) => {
      setCustomEntries((prev) => [
        ...prev,
        {
          id: nextId('ce'),
          recordId,
          label,
          value,
          createdBy: viewer.userId,
          at: new Date().toISOString(),
        },
      ]);
      log(recordId, 'field', `Added "${label}" on the Other tab`);
    },
    [log, viewer.userId],
  );

  const updateEntry = useCallback(
    (entryId: string, label: string, value: string) => {
      const e = customEntries.find((x) => x.id === entryId);
      setCustomEntries((prev) => prev.map((x) => (x.id === entryId ? { ...x, label, value } : x)));
      if (e) log(e.recordId, 'field', `Edited "${label}" on the Other tab`);
    },
    [customEntries, log],
  );

  const deleteEntry = useCallback(
    (entryId: string) => {
      const e = customEntries.find((x) => x.id === entryId);
      setCustomEntries((prev) => prev.filter((x) => x.id !== entryId));
      if (e) log(e.recordId, 'field', `Removed "${e.label}" from the Other tab`);
    },
    [customEntries, log],
  );

  /* --- repeatable groups ------------------------------------------------ */

  const instanceCount = useCallback(
    (recordId: string, groupKey: string) => {
      const r = records.find((x) => x.id === recordId);
      const n = Number(r?.values[`_${groupKey}_count`] ?? 1);
      return Number.isFinite(n) && n >= 1 ? n : 1;
    },
    [records],
  );

  const addInstance = useCallback(
    (recordId: string, groupKey: string, max: number) => {
      setRecords((prev) =>
        prev.map((r) => {
          if (r.id !== recordId) return r;
          const current = Number(r.values[`_${groupKey}_count`] ?? 1);
          if (current >= max) return r;
          return { ...r, values: { ...r.values, [`_${groupKey}_count`]: current + 1 } };
        }),
      );
      log(recordId, 'field', `${groupKey} ${instanceCount(recordId, groupKey) + 1} added`);
    },
    [instanceCount, log],
  );

  const removeInstance = useCallback(
    (recordId: string, groupKey: string, index: number) => {
      setRecords((prev) =>
        prev.map((r) => {
          if (r.id !== recordId) return r;
          const current = Number(r.values[`_${groupKey}_count`] ?? 1);
          if (current <= 1) return r;

          /*
           * Shift every instance above the removed one down by one, so the
           * numbering stays contiguous. A gap would mean "Owner 3" with no
           * Owner 2, and a percentage split nobody can check.
           */
          const values = { ...r.values };
          const suffixes = FIELDS.filter((f) => f.repeatGroup?.key === groupKey).map((f) =>
            f.id.replace(new RegExp(`^${groupKey}_1_`), ''),
          );
          for (let n = index; n < current; n++) {
            for (const suffix of suffixes) {
              values[`${groupKey}_${n}_${suffix}`] = values[`${groupKey}_${n + 1}_${suffix}`] ?? null;
            }
          }
          for (const suffix of suffixes) delete values[`${groupKey}_${current}_${suffix}`];
          values[`_${groupKey}_count`] = current - 1;
          return { ...r, values };
        }),
      );
      log(recordId, 'field', `${groupKey} ${index} removed`);
    },
    [log],
  );

  const value: Store = {
    now: TODAY,
    records,
    updates,
    cases,
    activity,
    notes,
    customEntries,
    navCollapsed,
    toggleNav: () => setNavCollapsed((c) => !c),
    viewer,
    setViewerId,
    visibleModules,
    grantFor,
    canSeeRecord,
    columnsForViewer,
    rowsFor,
    readValue,
    setValue,
    toggleMembership,
    setMemberships,
    setPipelineStep,
    clearPipeline,
    deleteRecord,
    restoreRecord,
    addUpdate,
    addCase,
    addCaseReply,
    setCaseSolution,
    toggleCaseState,
    logCredentialReveal,
    notesFor,
    addNote,
    editNote,
    deleteNote,
    entriesFor,
    addEntry,
    updateEntry,
    deleteEntry,
    instanceCount,
    addInstance,
    removeInstance,
    setColumnOrder,
    resetColumnOrder,
    hasCustomColumnOrder,
    fieldOrderFor,
    setFieldOrder,
    resetFieldOrder,
    hasCustomFieldOrder,
    filtersFor,
    setFilters,
    clearFilters,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function userName(id: string): string {
  return USER_BY_ID.get(id)?.name ?? 'Unknown user';
}
