'use client';

/**
 * The permission grant matrix — read (Phase 6b), write (Phase 6c).
 *
 * One component, two subjects: a template (`/admin/templates/[templateId]`)
 * and a real person (`/admin/users/[userId]/permissions`). The difference is a
 * column, not a screen — a template has grants, a user has grants *and*
 * overrides — and building it twice is how the two would come to disagree about
 * what "not set" means.
 *
 * ── EXACTLY ONE COLUMN IS EDITABLE, AND WHICH ONE DEPENDS ON THE ROUTE ───
 * The template screen edits the Template column. A person's screen edits their
 * Override column and shows the template's as read-only, with a link to go and
 * change it there. That is not a simplification: editing a template from inside
 * one person's screen would silently change everyone else attached to it, on a
 * page whose entire framing is "this person". The write path each route passes
 * in decides which column is live, so the component cannot offer the wrong one.
 *
 * ── FOUR STATES ──────────────────────────────────────────────────────────
 * Hidden / View / Edit / **Not set**. The fourth was the whole point of 6b: an
 * unset scope resolves to *Edit*, so rendering it as an empty cell would read as
 * "no access" and be wrong in the most dangerous direction. It is drawn as a
 * real state, it is a real choice in the editor (clearing a grant, not setting
 * one), and the legend says what it does.
 *
 * ── TWO RESOLUTION COLUMNS, NOT ONE ──────────────────────────────────────
 * "Resolves" is `effective_grant()`'s answer. "In the app" is what the person
 * actually experiences after the admin shortcut, the admin-only module floor and
 * the two field caps. They differ constantly — for an admin subject, *every* row
 * differs — and collapsing them into one column would either hide the caps or
 * misattribute them to the template.
 *
 * Both are recomputed here the instant a cell is clicked, by `resolveScope` —
 * the SAME function that produced the server-rendered values, imported from the
 * client-safe `grantRules.ts` rather than copied. Without that, the two columns
 * that explain the screen would lag a round trip behind the column being edited,
 * which on a 148-row grid reads as the screen being wrong.
 *
 * ── LOCKED OPTIONS (Phase 6d) ────────────────────────────────────────────
 * Two levels can be set, stored, and then silently overridden by a read-time
 * floor: Edit on a read-only field, Hidden on Deal Name. 6c made the writer
 * refuse both with a message; 6d greys them out so an honest click never reaches
 * that refusal. The greyed set comes from `lockedGrantLevels`, which is *derived
 * from the writer's own refusal function* rather than listed again here — a UI
 * whose locks were maintained separately would eventually forbid something the
 * server allows, which is the same lie as this phase's, pointing the other way.
 *
 * The admin shortcut and the admin-only module floor are NOT locked, for that
 * reason: both are no-ops only while a role or a module setting stays as it is
 * today, and 6c already declined to refuse them at the writer. They keep the
 * padlock's hover and a live control. See `lockedGrantLevels`.
 */
import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { OutlineChip } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { PlaceholderNotice } from './PlaceholderNotice';
// Types only from the data layer — it is `server-only`, and importing a VALUE
// from it here is a build error by design (`CLAUDE.md` § Secrets). The
// enforcement notes and the resolution rules therefore live in their own
// client-safe modules rather than being copied into this file, where they would
// drift.
import type { GrantMatrix as Matrix, GrantResult, ScopeRow } from '@/lib/records/adminGrants';
import { ENFORCEMENT_NOTE } from '@/lib/records/grantEnforcement';
import {
  GRANT_LEVELS,
  lockedGrantLevels,
  resolveScope,
  capGrant,
  maxGrant,
  type Grant,
  type GrantScope,
  type ScopeCaps,
} from '@/lib/records/grantRules';

/* -------------------------------------------------------------------------- */
/* Cells                                                                      */
/* -------------------------------------------------------------------------- */

const GRANT_STYLE: Record<Grant, { label: string; className: string }> = {
  hidden: { label: 'Hidden', className: 'border-[#f7cfd1] bg-[#fce9ea] text-[#b02a30]' },
  view: { label: 'View', className: 'border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]' },
  edit: { label: 'Edit', className: 'border-brand-100 bg-brand-50 text-brand-700' },
};

/** The fourth state. Deliberately not styled like an empty cell — it is the
 * most permissive value in the model, and it looks like the least. */
const NOT_SET = {
  label: 'Not set',
  className: 'border-dashed border-line text-ink-400 bg-white',
};

const CELL_BASE = 'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11.5px] font-medium';

function GrantCell({ grant, muted }: { grant: Grant | null; muted?: boolean }) {
  const s = grant ? GRANT_STYLE[grant] : NOT_SET;
  return <span className={`${CELL_BASE} ${s.className} ${muted ? 'opacity-55' : ''}`}>{s.label}</span>;
}

/**
 * The editable version of the same cell — Phase 6c.
 *
 * A native `<select>` rather than a four-button segmented control, deliberately:
 * this grid is 148 rows deep and every row would otherwise carry four buttons,
 * and a select is keyboard- and screen-reader-navigable for free. It is styled
 * as the chip it replaces so an editable column reads as the same kind of thing
 * as the read-only one next to it, only live.
 *
 * `''` is "Not set" — clearing the grant, which is a real choice and not the
 * same as Hidden. It is listed FIRST because it is the state a scope starts in,
 * not last as a "none of the above". It is also never locked: clearing is always
 * allowed, whatever the caps say.
 *
 * Phase 6d: a level the writer would refuse is `disabled` AND says so in its own
 * text. Greying alone is not enough — a disabled `<option>` is a faint visual
 * difference and nothing at all to a screen reader, so the reason has to be in
 * the text and in the control's hover, not only in the colour.
 */
function GrantSelect({
  value,
  caps,
  busy,
  label,
  onChange,
}: {
  value: Grant | null;
  caps: ScopeCaps;
  busy: boolean;
  label: string;
  onChange: (next: Grant | null) => void;
}) {
  const s = value ? GRANT_STYLE[value] : NOT_SET;
  const locks = lockedGrantLevels(caps);
  const reasonFor = (g: Grant) => locks.find((l) => l.level === g)?.reason ?? null;

  // Fills its cell rather than hugging its text: the chip was a ~46px target in
  // a 76px column, so a click that plainly landed "on the column" missed it. The
  // hover is what says the whole cell is the control.
  return (
    <select
      aria-label={label}
      title={locks.length ? locks.map((l) => l.reason).join(' ') : undefined}
      value={value ?? ''}
      disabled={busy}
      onChange={(e) => onChange((e.target.value || null) as Grant | null)}
      // A tab's whole header strip toggles the tab on click, and this select
      // sits inside one. Without this, changing a tab's own grant would collapse
      // the tab out from under the cursor doing it.
      onClick={(e) => e.stopPropagation()}
      className={`${CELL_BASE} w-full cursor-pointer appearance-none justify-center text-center outline-none transition hover:brightness-[.96] hover:shadow-[0_1px_2px_rgba(8,32,47,.12)] focus:ring-2 focus:ring-brand-600/20 ${s.className} ${
        busy ? 'opacity-40 hover:brightness-100 hover:shadow-none' : ''
      }`}
    >
      <option value="">{NOT_SET.label}</option>
      {GRANT_LEVELS.map((g) => {
        // Never disable the value the cell actually holds. A capped grant can
        // still exist — migration 39 guards the scope, not the level, and rows
        // predating 6c or written by direct SQL are real — and a control that
        // refused to display what it is holding would misreport the database.
        // The floors cancel such a grant on read anyway; clearing it is always
        // available on the option above.
        const reason = value === g ? null : reasonFor(g);
        return (
          <option key={g} value={g} disabled={Boolean(reason)}>
            {GRANT_STYLE[g].label}
            {reason ? ' — not available' : ''}
          </option>
        );
      })}
    </select>
  );
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

/** Which column this screen may write. `null` keeps the whole matrix read-only,
 * which is still a reachable state — a route that renders it without a write
 * path gets 6b's screen exactly. */
type EditableColumn = 'template' | 'user' | null;

const MODULE_CEILING_NOTE =
  'Capped by the module. A module set to View or Hidden is the ceiling on every tab it shows, whatever this row says.';
const TAB_CEILING_NOTE =
  'Capped by its tab. A tab set to View or Hidden is the ceiling on every field in it, whatever this row says.';
/** Why a field's level is capped by the subtab it sits in. A separate note
 *  from the tab's, so the padlock names the level that actually did it. */
const SUBTAB_CEILING_NOTE = 'Capped by this subtab';

/**
 * The ceiling a set of modules puts on a tab: the MOST permissive of them,
 * because the person meets the tab through whichever module suits them best.
 * A tab attached to no module is unreachable, so its ceiling is Hidden.
 */
function ceilingOf(moduleIds: string[], effectiveByModule: Map<string, Grant>): Grant {
  let ceiling: Grant = 'hidden';
  for (const id of moduleIds) {
    const g = effectiveByModule.get(id);
    if (g) ceiling = maxGrant(ceiling, g);
  }
  return ceiling;
}

/**
 * One row with its ceiling folded into the "In the app" column.
 *
 * `resolved` is deliberately untouched: that column is `effective_grant()`'s
 * answer for THIS scope and stays the honest report of what is stored. Only
 * "In the app" — the column that claims to say what the person experiences —
 * takes the chain, and the padlock gains the reason why.
 */
function applyCeiling(row: ScopeRow, ceiling: Grant, note: string): ScopeRow {
  const effective = capGrant(ceiling, row.effective);
  if (effective === row.effective) return row;
  return { ...row, effective, lock: row.lock ? `${row.lock} ${note}` : note };
}

function ScopeLine({
  row,
  showOverride,
  indent,
  alt,
  editable,
  busy,
  error,
  onEdit,
}: {
  row: ScopeRow;
  showOverride: boolean;
  indent: boolean;
  alt?: boolean;
  editable: EditableColumn;
  busy: boolean;
  error: string | null;
  onEdit: (row: ScopeRow, column: 'template' | 'user', next: Grant | null) => void;
}) {
  const capped = row.effective !== row.resolved;

  /**
   * The padlock's hover — Phase 6d gave it a second source.
   *
   * `row.lock` explains the RESOLUTION: why "In the app" differs from
   * "Resolves", which is the pair of columns the padlock sits beside. A write
   * lock explains the CONTROL: why an option is greyed out. For a read-only
   * field both exist and describe one rule in two directions, so the resolution
   * wording wins and the control carries its own; for Deal Name in its ordinary
   * state there is no resolution lock at all, and without this the only hint
   * that Hidden is unavailable would be inside an unopened dropdown.
   */
  const writeLocks = editable ? lockedGrantLevels(row.caps) : [];
  const lockNote = row.lock ?? (writeLocks.length ? writeLocks.map((l) => l.reason).join(' ') : null);

  return (
    <div
      className={`border-b border-line-faint last:border-b-0 ${indent ? 'pl-8' : ''} ${
        alt ? 'bg-gray-100' : ''
      }`}
    >
      <div className="flex items-center gap-3 px-3 py-1.5">
        <span className="min-w-0 flex-1">
          {/* Field rows sit inside an expanded tab and are the bulk of the 148;
              they stay at 13px, and only the module and tab rows they hang off
              take the larger size. */}
          <span className={`${indent ? 'text-[13px]' : 'text-base'} text-ink-800`}>{row.label}</span>
          <span className="ml-1.5 font-mono text-[11px] text-ink-300">{row.detail}</span>
          {lockNote ? (
            <span className="ml-1.5 inline-flex items-center gap-1 align-middle text-ink-300" title={lockNote}>
              <Icon name="lock" size={11} />
            </span>
          ) : null}
        </span>

        <span className="w-[76px] shrink-0 text-right">
          {editable === 'template' ? (
            <GrantSelect
              value={row.templateGrant}
              caps={row.caps}
              busy={busy}
              label={`Template grant for ${row.label}`}
              onChange={(next) => onEdit(row, 'template', next)}
            />
          ) : (
            <GrantCell grant={row.templateGrant} />
          )}
        </span>
        {showOverride ? (
          <span className="w-[76px] shrink-0 text-right">
            {editable === 'user' ? (
              <GrantSelect
                value={row.userGrant}
                caps={row.caps}
                busy={busy}
                label={`Personal override for ${row.label}`}
                onChange={(next) => onEdit(row, 'user', next)}
              />
            ) : (
              <GrantCell grant={row.userGrant} />
            )}
          </span>
        ) : null}
        <span className="w-[64px] shrink-0 text-right">
          <GrantCell grant={row.resolved} muted={capped} />
        </span>
        <span className="w-[64px] shrink-0 text-right">
          <GrantCell grant={row.effective} />
        </span>
      </div>

      {/* Against the row, not in a toast at the top: on a 148-row grid, an
          error that does not say WHICH cell it belongs to is barely an error at
          all. The optimistic value has already been rolled back by the time
          this renders. */}
      {error ? (
        <p className="flex items-start gap-1.5 px-3 pb-1.5 text-[12px] text-[#b02a30]">
          <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

function HeaderRow({ showOverride, first }: { showOverride: boolean; first: string }) {
  const th = 'shrink-0 text-right text-[10.5px] font-semibold uppercase tracking-[.04em] text-ink-400';
  return (
    <div className="flex items-center gap-3 border-b border-line-soft bg-canvas px-3 py-1.5">
      <span className={`min-w-0 flex-1 text-left ${th}`}>{first}</span>
      <span className={`w-[76px] ${th}`}>Template</span>
      {showOverride ? <span className={`w-[76px] ${th}`}>Override</span> : null}
      <span className={`w-[64px] ${th}`}>Resolves</span>
      <span className={`w-[64px] ${th}`}>In the app</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The screen                                                                 */
/* -------------------------------------------------------------------------- */

function EnforcementChip({ kind }: { kind: GrantScope }) {
  const { level, note } = ENFORCEMENT_NOTE[kind];
  if (level === 'enforced') return null;
  return (
    <span title={note}>
      <OutlineChip tone="warn" icon="alert-triangle">
        {level === 'unread' ? 'Not enforced yet' : 'Enforced on the page only'}
      </OutlineChip>
    </span>
  );
}

/**
 * How this screen writes — supplied by the route, which is what decides whether
 * the Template column or the Override column is the live one.
 *
 * Server actions passed as props, not imported here: the two live in different
 * `actions.ts` files (a template's grants are a Templates concern, a person's
 * overrides a Users one), and the guard test in `adminConfig.test.ts` only scans
 * `admin/<route>/actions.ts` — an action tucked under a dynamic segment would
 * silently escape both the Zod check and the never-cache check.
 */
export type GrantWriter = {
  column: 'template' | 'user';
  set: (scopeKind: GrantScope, scopeId: string, level: Grant) => Promise<GrantResult>;
  clear: (scopeKind: GrantScope, scopeId: string) => Promise<GrantResult>;
};

type RowKey = `${GrantScope}:${string}`;
const rowKey = (row: ScopeRow): RowKey => `${row.kind}:${row.id}`;

export function GrantMatrix({ matrix, writer }: { matrix: Matrix; writer?: GrantWriter }) {
  const [search, setSearch] = useState('');
  const [openTabs, setOpenTabs] = useState<Set<string>>(new Set());
  const [onlySet, setOnlySet] = useState(false);

  /**
   * Cells the admin has changed since this render of the server data.
   *
   * Kept until the server sends a render that already agrees — a successful
   * write revalidates the route, the fresh props arrive carrying the same value,
   * and the overlay becomes a no-op rather than something to time. Dropping it
   * on success instead would flash the old value for the length of the refresh.
   * A failed write removes its own entry, so the cell snaps back to what the
   * database actually holds.
   */
  const [edits, setEdits] = useState<Map<RowKey, Grant | null>>(new Map());
  const [busyKey, setBusyKey] = useState<RowKey | null>(null);
  const [errors, setErrors] = useState<Map<RowKey, string>>(new Map());
  const [, startTransition] = useTransition();

  const subject = matrix.subject;
  const showOverride = subject.kind === 'user';
  const needle = search.trim().toLowerCase();

  /**
   * Applies any pending edit to a row and re-resolves it.
   *
   * `resolveScope` is the same function `adminGrants.ts` used to build this row
   * server-side, imported from the client-safe `grantRules.ts` — so the two
   * explanation columns and the padlock's reason stay identical to what the next
   * server render will produce, rather than being a second guess at the rules.
   */
  const withEdits = useMemo(() => {
    return (row: ScopeRow): ScopeRow => {
      const key = rowKey(row);
      if (!edits.has(key) || !writer) return row;

      const next = edits.get(key) ?? null;
      const templateGrant = writer.column === 'template' ? next : row.templateGrant;
      const userGrant = writer.column === 'user' ? next : row.userGrant;
      const { resolved, effective, lock } = resolveScope(
        row.caps,
        userGrant,
        templateGrant,
        matrix.subjectIsAdmin,
      );
      return { ...row, templateGrant, userGrant, resolved, effective, lock };
    };
  }, [edits, writer, matrix.subjectIsAdmin]);

  const onEdit = (row: ScopeRow, column: 'template' | 'user', next: Grant | null) => {
    if (!writer || writer.column !== column) return;
    const key = rowKey(row);

    setEdits((prev) => new Map(prev).set(key, next));
    setErrors((prev) => {
      const m = new Map(prev);
      m.delete(key);
      return m;
    });
    setBusyKey(key);

    startTransition(async () => {
      const result = next === null ? await writer.clear(row.kind, row.id) : await writer.set(row.kind, row.id, next);
      setBusyKey(null);
      if (result.ok) return;

      // Roll the cell back to the server's value and say why against that row.
      setEdits((prev) => {
        const m = new Map(prev);
        m.delete(key);
        return m;
      });
      setErrors((prev) => new Map(prev).set(key, result.message));
    });
  };

  // One matcher, defined inside the memo it belongs to — a `matches` closure
  // declared in the component body would be a new function every render and
  // would have to be listed as a dependency of the memo below, which is a lint
  // fight for no benefit.
  const { modules, tabs } = useMemo(() => {
    const matches = (row: ScopeRow) => {
      if (needle && !row.label.toLowerCase().includes(needle) && !row.detail.toLowerCase().includes(needle)) {
        return false;
      }
      // A row the admin has just touched stays visible even under "only scopes
      // with an entry" — clearing a grant otherwise makes the row disappear
      // from under the cursor that cleared it, which reads as a crash.
      if (!onlySet || edits.has(rowKey(row))) return true;
      return row.templateGrant !== null || row.userGrant !== null;
    };

    const visible = (rows: ScopeRow[]) => rows.map(withEdits).filter(matches);

    // The chain, applied to the "In the app" column. A module's grant is the
    // ceiling on every tab it shows, and that capped tab is the ceiling on its
    // fields — so a module set to View reads View all the way down instead of
    // three rows each answering for itself and disagreeing with the app.
    const moduleRows = matrix.modules.map(withEdits);
    const moduleEffective = new Map(moduleRows.map((m) => [m.id, m.effective] as const));

    return {
      modules: moduleRows.filter(matches),
      tabs: matrix.tabs
        .map((t) => {
          const ceiling = ceilingOf(t.moduleIds, moduleEffective);
          const tab = applyCeiling(withEdits(t.tab), ceiling, MODULE_CEILING_NOTE);
          return {
            ...t,
            tab,
            groups: t.groups
              .map((g) => {
                // The subtab's own row is capped by its tab, exactly as the
                // fields are — and the FIELDS are then capped by the subtab
                // rather than the tab, so the chain the server enforces
                // (module → tab → subtab → field) is the chain shown here.
                const subtab = g.subtab
                  ? applyCeiling(withEdits(g.subtab), tab.effective, TAB_CEILING_NOTE)
                  : null;
                const above = subtab ? subtab.effective : tab.effective;
                return {
                  ...g,
                  subtab,
                  fields: visible(g.fields).map((f) =>
                    applyCeiling(f, above, subtab ? SUBTAB_CEILING_NOTE : TAB_CEILING_NOTE),
                  ),
                };
              })
              .filter((g) => g.fields.length > 0 || (g.subtab != null && matches(g.subtab))),
          };
        })
        .map((t) => ({ ...t, tabMatches: matches(t.tab) }))
        .filter((t) => t.tabMatches || t.groups.length > 0),
    };
  }, [matrix.modules, matrix.tabs, needle, onlySet, edits, withEdits]);

  /**
   * The header chips, recounted over the whole tree with pending edits applied
   * — 148 rows, so cheaper than caring.
   *
   * They have to move with the cells: "3 overrides" sitting above a column the
   * admin has just added a fourth to reads as the save having failed. Orphan
   * grants are excluded here for free, by counting rows rather than table rows,
   * which is what `buildMatrix` does the long way round by subtracting them.
   */
  const counts = useMemo(() => {
    let templateSet = 0;
    let userSet = 0;
    let restricted = 0;
    // Counted over the CHAINED effective, like the column it summarises —
    // `buildMatrix`'s own count is per scope and would say "4 restricted"
    // above a grid showing forty capped rows the moment a module goes to View.
    const tally = (row: ScopeRow) => {
      if (row.templateGrant !== null) templateSet++;
      if (row.userGrant !== null) userSet++;
      if (row.effective !== 'edit') restricted++;
    };
    const moduleRows = matrix.modules.map(withEdits);
    const moduleEffective = new Map(moduleRows.map((m) => [m.id, m.effective] as const));
    moduleRows.forEach(tally);
    for (const t of matrix.tabs) {
      const tab = applyCeiling(withEdits(t.tab), ceilingOf(t.moduleIds, moduleEffective), MODULE_CEILING_NOTE);
      tally(tab);
      for (const g of t.groups) {
        if (g.subtab) tally(applyCeiling(withEdits(g.subtab), tab.effective, TAB_CEILING_NOTE));
        for (const f of g.fields) tally(applyCeiling(withEdits(f), tab.effective, TAB_CEILING_NOTE));
      }
    }
    return { ...matrix.counts, templateSet, userSet, restricted };
  }, [matrix.counts, matrix.modules, matrix.tabs, withEdits]);

  /** One row, with everything the write path needs threaded through it. */
  const line = (row: ScopeRow, indent: boolean, alt = false) => (
    <ScopeLine
      key={row.id}
      row={row}
      showOverride={showOverride}
      indent={indent}
      alt={alt}
      editable={writer?.column ?? null}
      busy={busyKey === rowKey(row)}
      error={errors.get(rowKey(row)) ?? null}
      onEdit={onEdit}
    />
  );

  // A search narrows the tree to something small enough to read at once, so
  // opening every surviving tab is the useful default — collapsing is only
  // there because 129 fields at once is not.
  const filtering = Boolean(needle) || onlySet;
  const isOpen = (tabId: string) => filtering || openTabs.has(tabId);
  const toggle = (tabId: string) =>
    setOpenTabs((prev) => {
      const next = new Set(prev);
      if (next.has(tabId)) next.delete(tabId);
      else next.add(tabId);
      return next;
    });

  return (
    <div className="space-y-4">
      {writer ? (
        <PlaceholderNotice title="A scope with no entry resolves to Edit, not Hidden">
          <p>
            &ldquo;Not set&rdquo; is the <strong>most permissive</strong> state in this model, not the
            least — a template that grants nothing restricts nothing. Setting a cell back to Not set means{' '}
            {writer.column === 'template'
              ? 'inherit the default, which is Edit'
              : "fall back to the template's value, whatever that is"}
            .
          </p>
          <p>
            Changes save as you make them, and take effect on the affected person&rsquo;s{' '}
            <strong>next request</strong> — there is no push step and nothing to publish.
          </p>
        </PlaceholderNotice>
      ) : (
        <PlaceholderNotice title="Read-only — nothing on this screen changes a permission">
          <p>
            This is the resolved state as the database holds it today; every value here is reported, not
            editable.
          </p>
          <p>
            <strong>A scope with no entry resolves to Edit</strong>, not Hidden. &ldquo;Not set&rdquo; is
            the most permissive state in the model, which is why it is drawn as a state rather than an
            empty cell.
          </p>
        </PlaceholderNotice>
      )}

      {subject.kind === 'user' && subject.isAdmin ? (
        <PlaceholderNotice title={`${subject.label} is an admin — none of these grants apply to them`}>
          <p>
            Every module, tab and field resolves to <strong>Edit</strong> for an admin before any template
            or override is consulted, so the &ldquo;In the app&rdquo; column below reads Edit throughout
            regardless of what the other columns say. The one exception is a read-only field, which is
            capped at View for everyone.
          </p>
          <p>
            Testing that a grant actually restricts anything needs a non-admin account. Every profile in
            this database is currently a super admin.
          </p>
        </PlaceholderNotice>
      ) : null}

      {matrix.orphans.length > 0 ? (
        <PlaceholderNotice title={`${matrix.orphans.length} grant(s) point at something that no longer exists`}>
          <p>
            These rows still resolve in <code>effective_grant()</code> but have no scope to show — most
            likely an archived field. They are listed here because nothing else in the app would ever
            reveal them:{' '}
            {matrix.orphans.map((o) => `${o.source}/${o.kind}/${o.scopeId.slice(0, 8)}→${o.level}`).join(', ')}.
          </p>
        </PlaceholderNotice>
      ) : null}

      {/* ---- toolbar ---- */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-white px-3 py-2 shadow-[0_1px_2px_rgba(8,32,47,.05)]">
        <span className="relative">
          <Icon name="search" size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-300" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search module, tab, field or key…"
            className="w-[280px] rounded-md border border-line py-1 pl-7 pr-2 text-[12.5px] outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/20"
          />
        </span>
        <label className="flex items-center gap-1.5 text-[12.5px] text-ink-600">
          <input type="checkbox" checked={onlySet} onChange={(e) => setOnlySet(e.target.checked)} />
          Only scopes with an entry
        </label>
        <span className="ml-auto flex items-center gap-2 text-[12px] text-ink-400">
          <OutlineChip>{counts.scopes} scopes</OutlineChip>
          <OutlineChip tone={counts.templateSet ? 'brand' : 'neutral'}>
            {counts.templateSet} from the template
          </OutlineChip>
          {showOverride ? (
            <OutlineChip tone={counts.userSet ? 'brand' : 'neutral'}>
              {counts.userSet} override{counts.userSet === 1 ? '' : 's'}
            </OutlineChip>
          ) : null}
          <OutlineChip tone={counts.restricted ? 'warn' : 'neutral'}>{counts.restricted} below Edit</OutlineChip>
        </span>
      </div>

      {/* ---- modules ---- */}
      <section className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.05)]">
        <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-3">
          <h2 className="text-[14px] font-semibold text-ink-900">Modules</h2>
          <EnforcementChip kind="module" />
          <p className="w-full text-[12px] text-ink-400">{ENFORCEMENT_NOTE.module.note}</p>
        </div>
        <HeaderRow showOverride={showOverride} first="Module" />
        {modules.map((m) => line(m, false))}
        {modules.length === 0 ? (
          <p className="px-3 py-4 text-[12.5px] text-ink-400">No module matches that.</p>
        ) : null}
      </section>

      {/* ---- tabs and their fields ---- */}
      <section className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.05)]">
        <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-3">
          <h2 className="text-[14px] font-semibold text-ink-900">Tabs &amp; fields</h2>
          <EnforcementChip kind="tab" />
          <p className="w-full text-[12px] text-ink-400">
            Tabs and fields are global — one set for the whole CRM, so a grant here applies in every
            module at once. {ENFORCEMENT_NOTE.tab.note}
          </p>
        </div>
        <HeaderRow showOverride={showOverride} first="Tab / field" />

        {tabs.map((t) => {
          const open = isOpen(t.tab.id);
          const fieldCount = t.groups.reduce((n, g) => n + g.fields.length, 0);
          // Zebra stripe counted across the whole expanded tab, not per subtab
          // group — restarting it at each group heading puts two shaded rows
          // next to each other wherever a group has an odd number of fields,
          // which reads as a grouping that isn't there.
          let fieldIndex = 0;
          // The whole header strip toggles, not just the 36px chevron. The
          // button stays as the keyboard and screen-reader control and its click
          // simply bubbles to this handler, so there is one toggle path rather
          // than two that could disagree about the guard below.
          const canToggle = !filtering && !t.fieldless;
          const toggleProps = canToggle
            ? {
                onClick: () => toggle(t.tab.id),
                className: 'cursor-pointer transition-colors hover:bg-brand-50',
              }
            : { className: '' };
          return (
            <div key={t.tab.id} className="border-b border-line-soft last:border-b-0">
              <div
                onClick={toggleProps.onClick}
                className={`flex items-center gap-2 bg-canvas/60 ${toggleProps.className}`}
              >
                <button
                  type="button"
                  disabled={!canToggle}
                  aria-expanded={open}
                  className="grid size-9 shrink-0 place-items-center text-ink-400 transition-colors hover:text-ink-700 disabled:opacity-25"
                  title={t.fieldless ? 'This tab holds no fields' : open ? 'Collapse' : 'Expand'}
                >
                  <Icon name={open ? 'chevron-down' : 'chevron-right'} size={26} />
                </button>
                <div className="min-w-0 flex-1">{line(t.tab, false)}</div>
              </div>

              {open ? (
                <div className="bg-white">
                  {t.groups.map((g) => (
                    <div key={g.subtabId ?? '_'}>
                      {/* The subtab's own grant row. It used to be a heading
                          reading "subtabs are not a grant scope — these fields
                          inherit the tab", which was accurate until migration
                          50 gave `grant_scope` its fourth value. It is now a
                          settable level like any other, capped by its tab. */}
                      {g.subtab ? line(g.subtab, true, false) : null}
                      {g.fields.map((f) => line(f, true, fieldIndex++ % 2 === 1))}
                    </div>
                  ))}
                  {/* Two different nothings. A tab that HOLDS no fields is a
                      statement about the model — its grant is the only lever
                      over it, and that lever is the unread one. A tab whose
                      fields the filter removed is just a filter result. Saying
                      the first about the second told an admin that Pricing has
                      no fields, which is wrong by fifty. */}
                  {fieldCount === 0 ? (
                    t.fieldless ? (
                      <p className="px-3 py-2 pl-8 text-[12px] text-ink-400">
                        No fields on this tab. Its content is not field-shaped, so the tab grant above is the
                        only lever over it — and that lever is the one nothing reads yet.
                      </p>
                    ) : (
                      <p className="px-3 py-2 pl-8 text-[12px] text-ink-400">
                        No field on this tab matches the current filter.
                      </p>
                    )
                  ) : null}
                </div>
              ) : (
                <p
                  onClick={toggleProps.onClick}
                  className={`px-3 py-1 pl-[60px] text-[11.5px] text-ink-300 ${toggleProps.className}`}
                >
                  {t.fieldless ? 'No fields' : `${fieldCount} field${fieldCount === 1 ? '' : 's'}`}
                </p>
              )}
            </div>
          );
        })}
        {tabs.length === 0 ? (
          <p className="px-3 py-4 text-[12.5px] text-ink-400">Nothing matches that.</p>
        ) : null}
      </section>

      <Legend showOverride={showOverride} editable={writer?.column ?? null} />
    </div>
  );
}

function Legend({ showOverride, editable }: { showOverride: boolean; editable: EditableColumn }) {
  return (
    <div className="rounded-xl border border-line bg-white px-4 py-3 text-[12px] text-ink-500 shadow-[0_1px_2px_rgba(8,32,47,.05)]">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-[.04em] text-ink-400">What the columns mean</p>
      <dl className="grid gap-1.5 sm:grid-cols-2">
        <div>
          <dt className="inline font-medium text-ink-700">Template</dt>
          <dd className="inline">
            {' '}
            — the setting saved on this template. Blank means the template says nothing about it.
            {editable === 'user'
              ? ' You cannot change it from this screen, because it would change everyone else on the same template too.'
              : ''}
          </dd>
        </div>
        {showOverride ? (
          <div>
            <dt className="inline font-medium text-ink-700">Override</dt>
            <dd className="inline">
              {' '}
              — a setting for this one person only. When it is filled in, it wins over the template.
              {editable === 'user' ? ' Filling one in here is what makes the badge say “(edited)”.' : ''}
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="inline font-medium text-ink-700">Resolves</dt>
          <dd className="inline">
            {' '}
            — what the two columns on the left add up to: the person&rsquo;s own setting if there is one,
            otherwise the template&rsquo;s, and if neither is filled in, Edit.
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-ink-700">In the app</dt>
          <dd className="inline">
            {' '}
            — what the person actually gets when they use the CRM. This can be stricter than
            &ldquo;Resolves&rdquo;, because{' '}
            <strong className="font-medium text-ink-700">a module limits everything inside it</strong>:
            set a module to View and every tab and field inside it is view-only too, no matter what
            their own rows say — and a tab limits its fields the same way. Admins always get Edit, and
            some rows are fixed for other reasons. A{' '}
            <Icon name="lock" size={11} className="inline align-[-1px]" /> marks a row where something
            other than its own setting decided the answer; hover over it to see what.
          </dd>
        </div>
      </dl>
      <p className="mt-2.5 border-t border-line-faint pt-2">
        <strong className="font-medium text-ink-700">Blank does not mean hidden.</strong> If nothing is
        filled in — not here and not on the template — the person gets full{' '}
        <strong className="font-medium text-ink-700">Edit</strong> access. Access starts open, so a
        template that sets nothing takes nothing away. To make a whole module read-only, set the{' '}
        <em>module</em> row to View and everything inside it follows; leaving the rows underneath blank
        does not restrict anything on its own.
      </p>
      {editable ? (
        <p className="mt-2 border-t border-line-faint pt-2">
          <strong className="font-medium text-ink-700">Greyed-out choices</strong> are the two the app
          would ignore anyway: <strong className="font-medium text-ink-700">Edit</strong> on a field
          nobody is allowed to type into, and{' '}
          <strong className="font-medium text-ink-700">Hidden</strong> on Deal Name, which always has to
          stay visible. Choosing one would show a promise here that the app would not keep, so they
          cannot be picked or saved. Choices marked with a padlock{' '}
          <em>can</em> still be picked — they simply make no difference today, because of the
          person&rsquo;s role or because the module is admin-only, but they are worth saving for the day
          that changes.
        </p>
      ) : null}
    </div>
  );
}

/** Shared back-link, so both routes return to where they were opened from. */
export function MatrixBackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-500 transition-colors hover:text-ink-900"
    >
      <Icon name="chevron-left" size={13} />
      {label}
    </Link>
  );
}
