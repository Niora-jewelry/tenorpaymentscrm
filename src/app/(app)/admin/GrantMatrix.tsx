'use client';

/**
 * The permission screen — one row per scope, one control, one answer.
 *
 * One component, two subjects: a template (`/admin/templates/[templateId]`) and
 * a real person (`/admin/users/[userId]/permissions`). Building it twice is how
 * the two would come to disagree about what "not set" means.
 *
 * ── THE REDESIGN, AND WHAT IT REMOVED ────────────────────────────────────
 * This screen used to show FOUR columns per row — Template, Override, Resolves,
 * In the app — plus a four-entry legend explaining them and three notice blocks
 * above the grid. Everything was accurate and almost nobody could read it: two
 * of the columns were intermediate values that only matter when they disagree,
 * and the disagreement was exactly what the reader had to work out for
 * themselves.
 *
 * It is now two things per row:
 *
 *   SETTING — the one control, a visible four-state segmented button rather
 *             than a dropdown. The states are what you set; nothing is nested.
 *   RESULT  — what the person actually gets, after every cap. A padlock appears
 *             only when the result differs from the setting, and says why.
 *
 * The intermediate "Resolves" value did not vanish — it is in the padlock's
 * explanation, which is the only moment it is worth knowing. On the person's
 * screen the template's value is an inline hint on the row ("Sales Rep: Hidden")
 * instead of a column, because it is context, not a second thing to compare.
 *
 * ── WHAT DID NOT CHANGE ──────────────────────────────────────────────────
 * Every rule underneath. The four states, the module → tab → subtab → field
 * ceiling chain, the locked levels derived from the writer's own refusal
 * function, optimistic edits with rollback and per-row errors, the counts
 * recomputed over pending edits, orphan grants, and the admin short-circuit.
 * This was a presentation change; `resolveScope` still produces every value on
 * screen, imported from the client-safe `grantRules.ts` so it cannot drift from
 * what the server will render next.
 *
 * ── EXACTLY ONE COLUMN IS WRITABLE, AND THE ROUTE DECIDES ────────────────
 * The template screen writes the template. A person's screen writes their
 * override and shows the template's value read-only. Editing a template from
 * inside one person's screen would silently change everyone else attached to
 * it, on a page whose entire framing is "this person".
 */
import { useCallback, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { BarAction, BarCount, FloatingBar, OutlineChip, Spinner } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { PlaceholderNotice } from './PlaceholderNotice';
// Types only from the data layer — it is `server-only`, and importing a VALUE
// from it here is a build error by design (`CLAUDE.md` § Secrets). The
// enforcement notes and the resolution rules therefore live in their own
// client-safe modules rather than being copied into this file, where they would
// drift.
import type { GrantMatrix as Matrix, GrantResult, GrantBatchResult, ScopeRow } from '@/lib/records/adminGrants';
import { ENFORCEMENT_NOTE } from '@/lib/records/grantEnforcement';
import {
  GRANT_LEVELS,
  lockedGrantLevels,
  resolveScope,
  resolveMembership,
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

/**
 * The add/remove-records row (`membership` scope, migration 9766) has two
 * answers, not three. It stores `edit` for Yes and `view` for No — the same
 * enum as every other grant, so one resolver and one writer serve it — but
 * drawing "Edit" and "View" on a row that asks "may they move records?"
 * would be the wrong words. `hidden` is never stored for it; it shows as No
 * for a module the person cannot see at all.
 */
type CellVariant = 'levels' | 'yesno' | 'full' | 'copy';
const MEMBERSHIP_STYLE: Record<Grant, { label: string; className: string }> = {
  hidden: { label: 'No', className: GRANT_STYLE.hidden.className },
  view: { label: 'No', className: GRANT_STYLE.view.className },
  edit: { label: 'Yes', className: GRANT_STYLE.edit.className },
};
/* The spec's own words for two tabs (Permissions spec, Tab levels): Marketing
 * is "Hidden · Full access", and View on Logins is "View / copy only". */
const styleFor = (variant: CellVariant, grant: Grant) => {
  if (variant === 'yesno') return MEMBERSHIP_STYLE[grant];
  if (variant === 'full' && grant === 'edit') return { ...GRANT_STYLE.edit, label: 'Full access' };
  if (variant === 'copy' && grant === 'view') return { ...GRANT_STYLE.view, label: 'View / copy' };
  return GRANT_STYLE[grant];
};
const variantOf = (row: ScopeRow): CellVariant => {
  if (row.kind === 'membership') return 'yesno';
  if (row.caps.kind === 'tab' && row.caps.hiddenOrFull) return 'full';
  if (row.caps.kind === 'tab' && row.caps.viewCopies) return 'copy';
  return 'levels';
};

function GrantCell({ grant, muted, variant = 'levels' }: { grant: Grant | null; muted?: boolean; variant?: CellVariant }) {
  const s = grant ? styleFor(variant, grant) : NOT_SET;
  return <span className={`${CELL_BASE} ${s.className} ${muted ? 'opacity-55' : ''}`}>{s.label}</span>;
}

/**
 * The one control: four states, all visible, one click each.
 *
 * ── WHY A SEGMENTED CONTROL AND NOT A DROPDOWN ───────────────────────────
 * It used to be a `<select>`, chosen when the grid was 148 rows deep and four
 * buttons a row seemed extravagant. But tabs collapse by default, so a normal
 * screen shows about twenty rows, not a hundred and fifty — and a dropdown
 * hides the very thing this screen exists to communicate: that there are four
 * states and which one is chosen. Reading a column of dropdowns tells you
 * nothing until you open one.
 *
 * ── "NOT SET" IS FIRST, AND LABELLED ─────────────────────────────────────
 * It is the state a scope starts in, not a "none of the above", and it is the
 * MOST permissive value in the model — an unset scope resolves to Edit. Drawing
 * it as an empty cell would read as "no access" and be wrong in the most
 * dangerous direction, so it is a button like the others with a word on it.
 *
 * ── LOCKED LEVELS ────────────────────────────────────────────────────────
 * A level the writer would refuse is disabled and carries its reason on hover.
 * The list comes from `lockedGrantLevels`, derived from the writer's own
 * refusal function rather than restated here — a UI maintaining its own copy
 * would eventually forbid something the server allows, which is the same lie
 * pointing the other way.
 *
 * The value the cell currently HOLDS is never disabled: a capped grant can
 * genuinely exist, and a control refusing to show what it is holding would
 * misreport the database.
 */
function GrantToggle({
  value,
  caps,
  busy,
  label,
  variant = 'levels',
  onChange,
}: {
  value: Grant | null;
  caps: ScopeCaps;
  busy: boolean;
  label: string;
  variant?: CellVariant;
  onChange: (next: Grant | null) => void;
}) {
  const locks = lockedGrantLevels(caps);
  const reasonFor = (g: Grant) => locks.find((l) => l.level === g)?.reason ?? null;

  // The yes/no row offers its two answers only — Hidden is a level the writer
  // refuses for it (`grantWriteRefusal`), so it is not drawn at all rather
  // than drawn disabled with a tooltip explaining itself.
  // Likewise Marketing's View, which the spec does not offer.
  const levels: readonly Grant[] =
    variant === 'yesno' ? ['view', 'edit'] : variant === 'full' ? ['hidden', 'edit'] : GRANT_LEVELS;
  const options: { key: string; level: Grant | null; text: string }[] = [
    { key: 'unset', level: null, text: 'Not set' },
    ...levels.map((g) => ({ key: g, level: g as Grant | null, text: styleFor(variant, g).label })),
  ];

  return (
    <div
      role="group"
      aria-label={label}
      // The tab header strip toggles the tab on click and this sits inside one:
      // without stopping propagation, changing a tab's grant collapses the tab
      // out from under the cursor doing it.
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex overflow-hidden rounded-lg border border-line bg-canvas/60 ${
        busy ? 'opacity-40' : ''
      }`}
    >
      {options.map((o) => {
        const active = value === o.level;
        // Never disable what the cell holds — see the header.
        const reason = active || o.level === null ? null : reasonFor(o.level);
        const disabled = busy || Boolean(reason);

        return (
          <button
            key={o.key}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            title={reason ?? undefined}
            onClick={() => onChange(o.level)}
            className={`px-2 py-1 text-[11.5px] font-semibold transition-colors ${
              active
                ? o.level
                  ? `${styleFor(variant, o.level).className} border-0`
                  : 'bg-ink-800 text-white'
                : 'text-ink-500 hover:bg-white hover:text-ink-800'
            } ${disabled && !active ? 'cursor-not-allowed opacity-35 hover:bg-transparent' : ''}`}
          >
            {o.text}
          </button>
        );
      })}
    </div>
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
  templateName,
  onEdit,
  selectable,
  selected,
  onSelect,
}: {
  row: ScopeRow;
  showOverride: boolean;
  indent: boolean;
  alt?: boolean;
  editable: EditableColumn;
  busy: boolean;
  error: string | null;
  /** The template this person is attached to, for the inline hint. */
  templateName: string | null;
  onEdit: (row: ScopeRow, column: 'template' | 'user', next: Grant | null) => void;
  /** Bulk selection (the client's Addition 4). Only a writable matrix selects. */
  selectable: boolean;
  selected: boolean;
  onSelect: (row: ScopeRow, shiftKey: boolean) => void;
}) {
  const variant = variantOf(row);
  /*
   * The padlock appears only when the RESULT differs from what this row is set
   * to — which is the only moment the distinction is worth a reader's attention.
   * Its title carries what the old "Resolves" column used to show, plus the
   * reason, so nothing was lost by removing that column: "Set to Edit, but the
   * module caps it at View."
   */
  const capped = row.effective !== row.resolved;

  const writeLocks = editable ? lockedGrantLevels(row.caps) : [];
  const lockNote =
    (capped
      ? `This row resolves to ${styleFor(variant, row.resolved).label}, but the app gives ${
          styleFor(variant, row.effective).label
        }. ${row.lock ?? ''}`.trim()
      : row.lock) ?? (writeLocks.length ? writeLocks.map((l) => l.reason).join(' ') : null);

  // Which value this screen is responsible for, and which is context.
  const ownValue = editable === 'user' ? row.userGrant : row.templateGrant;
  const inherited = editable === 'user' ? row.templateGrant : null;

  return (
    <div
      className={`border-b border-line-faint last:border-b-0 ${indent ? 'pl-8' : ''} ${
        alt ? 'bg-canvas/40' : ''
      } ${selected ? 'bg-brand-50/70' : ''}`}
    >
      <div className="flex items-center gap-3 px-3 py-1.5">
        {selectable ? (
          <input
            type="checkbox"
            checked={selected}
            aria-label={`Select ${row.label}`}
            // Shift-click extends from the last row ticked to this one
            // (Addition 4). The browser would also start a text selection on
            // a shift-click, which is the one thing it must not do here.
            onMouseDown={(e) => {
              if (e.shiftKey) e.preventDefault();
            }}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(row, e.shiftKey);
            }}
            onChange={() => {}}
            className="size-3.5 shrink-0 accent-[#1d4ed8]"
          />
        ) : null}
        <span className="min-w-0 flex-1">
          <span className={`${indent ? 'text-[13px]' : 'text-[14px] font-medium'} text-ink-800`}>
            {row.label}
          </span>
          <span className="ml-1.5 font-mono text-[11px] text-ink-300">{row.detail}</span>
        </span>

        {/* The template's value as CONTEXT, not a column to compare against.
            Only rendered when the template actually says something — an empty
            column on every row was most of what made this screen unreadable. */}
        {showOverride && editable === 'user' ? (
          <span className="w-[150px] shrink-0 text-right text-[11.5px] text-ink-400">
            {inherited ? (
              <>
                {templateName ?? 'Their type'}:{' '}
                <span className="font-medium text-ink-600">{styleFor(variant, inherited).label}</span>
              </>
            ) : null}
          </span>
        ) : null}

        <span className="shrink-0">
          {editable ? (
            <GrantToggle
              value={ownValue}
              caps={row.caps}
              busy={busy}
              variant={variant}
              label={
                editable === 'user' ? `Permission for ${row.label}` : `Type permission for ${row.label}`
              }
              onChange={(next) => onEdit(row, editable, next)}
            />
          ) : (
            <GrantCell grant={ownValue} variant={variant} />
          )}
        </span>

        <span className="flex w-[92px] shrink-0 items-center justify-end gap-1">
          {/*
            A save in flight says "Saving", not just "this row went grey".
            The toggle dims and disables while `busy`, which tells you the
            click registered and nothing about whether it reached the
            database — on a permission row that is the only part worth
            knowing, and a failure arrives as a message against the row a
            moment later.
          */}
          {busy ? (
            <span role="status" className="flex items-center gap-1 text-[11.5px] text-ink-400">
              <span aria-hidden className="inline-block text-[11px] leading-none">
                <Spinner />
              </span>
              Saving
            </span>
          ) : (
            <>
              <GrantCell grant={row.effective} variant={variant} />
              {lockNote ? (
                <span className="inline-flex items-center text-ink-300" title={lockNote}>
                  <Icon name="lock" size={11} />
                </span>
              ) : null}
            </>
          )}
        </span>
      </div>

      {/* Against the row, not in a toast at the top: an error that does not say
          WHICH cell it belongs to is barely an error at all. The optimistic
          value has already been rolled back by the time this renders. */}
      {error ? (
        <p className="flex items-start gap-1.5 px-3 pb-1.5 text-[12px] text-[#b02a30]">
          <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

function HeaderRow({
  showOverride,
  first,
  editable,
}: {
  showOverride: boolean;
  first: string;
  editable: EditableColumn;
}) {
  const th = 'shrink-0 text-right text-[10.5px] font-semibold uppercase tracking-[.04em] text-ink-400';
  return (
    <div className="flex items-center gap-3 border-b border-line-soft bg-canvas px-3 py-1.5">
      <span className={`min-w-0 flex-1 text-left ${th}`}>{first}</span>
      {showOverride && editable === 'user' ? <span className={`w-[150px] ${th}`}>From their type</span> : null}
      {/* Two headers now, matching the two things on a row. "Resolves" is gone
          as a column: it was an intermediate value that only matters when it
          disagrees with the result, and that case is exactly what the padlock
          on the result now explains. */}
      <span className={`${th} w-[196px]`}>Setting</span>
      <span className={`w-[92px] ${th}`}>Result</span>
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
  /**
   * Several cells in one request — the client's Addition 4. A `null` level is
   * "Not set". Optional only so a route without it still renders; without it
   * the selection controls are not offered at all.
   */
  setMany?: (items: { scopeKind: GrantScope; scopeId: string; level: Grant | null }[]) => Promise<GrantBatchResult>;
};

/**
 * A row's identity, INCLUDING the module it is being set for.
 *
 * ⚠️ THIS WAS `${kind}:${id}` AND THAT IS THE STALE-PERMISSION BUG.
 *
 * A grant is stored per (scope, module) — `user_grants` is keyed on
 * `(user_id, scope_kind, scope_id, module_id)`. The optimistic-edit map below
 * was keyed without the module, so one field had ONE key across all six.
 *
 * Set a field to Hidden in Leads, switch to Deals, and the overlay for
 * `field:<id>` was still in the map and still applied — so the Deals row
 * showed Hidden although the database said nothing of the kind. It cleared
 * only on a full page load, because that is the one thing that discards this
 * component's state. Reported exactly that way: "it shows blocked in the
 * other module until I refresh the whole page."
 */
type RowKey = `${GrantScope}:${string}@${string}`;
const rowKeyIn = (moduleScopeId: string | null, row: ScopeRow): RowKey =>
  `${row.kind}:${row.id}@${moduleScopeId ?? 'all'}`;

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

  /*
   * ── BULK SELECTION (the client's Addition 4, 16 Oct 2026) ──────────────
   * "Select multiple at once and choose the permission", and "select a
   * permission item and then scroll down and select another while holding
   * shift which will automatically select all items in between."
   *
   * `selected` holds row keys. `anchor` is the last row ticked without shift;
   * a shift-click selects every row drawn between the anchor and the row
   * clicked, in the order they are on screen. That order is collected while
   * rendering (`line()` below pushes each key it draws into `orderRef`), so
   * "in between" means exactly what the admin sees — rows inside a collapsed
   * tab are not on screen and are not selected.
   */
  const [selected, setSelected] = useState<Set<RowKey>>(new Set());
  const [anchor, setAnchor] = useState<RowKey | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNote, setBulkNote] = useState<string | null>(null);
  const selectable = Boolean(writer?.setMany);

  /** This matrix's rows, keyed for the module it is actually describing. */
  const rowKey = useCallback(
    (row: ScopeRow) => rowKeyIn(matrix.moduleScopeId, row),
    [matrix.moduleScopeId],
  );

  /*
   * Switching module discards the overlay, rather than letting it age out.
   *
   * Keying by module (above) is already enough to stop one module's edit
   * painting onto another's row. This is the second half: when the subject
   * changes the pending state belongs to a view nobody is looking at any
   * more, and an in-flight `busyKey` or a per-row error from the previous
   * module would otherwise sit on the new screen with no row to explain it.
   *
   * Done during render against a snapshot rather than in an effect, which is
   * the idiom this codebase already uses for derived-from-props state (see
   * `DrawerTabs`) — an effect would paint the stale overlay for one frame
   * first, which is the exact flicker being removed.
   */
  const [scopeSnapshot, setScopeSnapshot] = useState(matrix.moduleScopeId);
  if (scopeSnapshot !== matrix.moduleScopeId) {
    setScopeSnapshot(matrix.moduleScopeId);
    if (edits.size > 0) setEdits(new Map());
    if (errors.size > 0) setErrors(new Map());
    if (busyKey !== null) setBusyKey(null);
    // A selection belongs to the module it was made in, like the overlay.
    if (selected.size > 0) setSelected(new Set());
    if (anchor !== null) setAnchor(null);
    if (bulkNote !== null) setBulkNote(null);
  }

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
  }, [edits, writer, matrix.subjectIsAdmin, rowKey]);

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

  // A search narrows the tree to something small enough to read at once, so
  // opening every surviving tab is the useful default — collapsing is only
  // there because 129 fields at once is not.
  const filtering = Boolean(needle) || onlySet;
  const isOpen = useCallback((tabId: string) => filtering || openTabs.has(tabId), [filtering, openTabs]);

  /* ── selection handlers ── */
  const onSelect = (row: ScopeRow, shiftKey: boolean) => {
    const key = rowKey(row);
    setBulkNote(null);
    setSelected((prev) => {
      const next = new Set(prev);
      const from = anchor ? order.indexOf(anchor) : -1;
      const to = order.indexOf(key);
      if (shiftKey && from >= 0 && to >= 0) {
        // Every row on screen between the anchor and this one, inclusive —
        // added to the selection, never toggled, so a second shift-click
        // extends rather than flips.
        const [a, b] = from < to ? [from, to] : [to, from];
        for (let i = a; i <= b; i++) next.add(order[i]);
        return next;
      }
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (!shiftKey) setAnchor(key);
  };

  /**
   * Applies one level to every selected row, in one request.
   *
   * Rows the writer would refuse at this level (a read-only field at Edit,
   * Deal Name at Hidden, the yes/no row at Hidden) are skipped and counted
   * rather than sent to fail — the same locks the single control greys out.
   * Optimistic like a single click; rows the server reports back as failed
   * are rolled back individually with their message against the row.
   */
  const applyBulk = (level: Grant | null) => {
    if (!writer?.setMany || selected.size === 0) return;
    const items: { scopeKind: GrantScope; scopeId: string; level: Grant | null }[] = [];
    const keys: RowKey[] = [];
    let skipped = 0;
    for (const key of selected) {
      const row = rowByKey.get(key);
      if (!row) continue;
      if (level !== null && lockedGrantLevels(row.caps).some((l) => l.level === level)) {
        skipped++;
        continue;
      }
      items.push({ scopeKind: row.kind, scopeId: row.id, level });
      keys.push(key);
    }
    if (items.length === 0) {
      setBulkNote(`Nothing changed — that level is not allowed on ${skipped === 1 ? 'the selected row' : 'any of the selected rows'}.`);
      return;
    }

    setEdits((prev) => {
      const m = new Map(prev);
      for (const k of keys) m.set(k, level);
      return m;
    });
    setErrors((prev) => {
      const m = new Map(prev);
      for (const k of keys) m.delete(k);
      return m;
    });
    setBulkBusy(true);

    startTransition(async () => {
      const result = await writer.setMany!(items);
      setBulkBusy(false);
      const failedKeys = new Map<RowKey, string>();
      for (const f of result.failed) {
        const k = keys.find((key) => {
          const r = rowByKey.get(key);
          return r && r.kind === f.scopeKind && r.id === f.scopeId;
        });
        if (k) failedKeys.set(k, f.message);
      }
      if (failedKeys.size) {
        setEdits((prev) => {
          const m = new Map(prev);
          for (const k of failedKeys.keys()) m.delete(k);
          return m;
        });
        setErrors((prev) => new Map([...prev, ...failedKeys]));
      }
      const done = items.length - failedKeys.size;
      const parts = [`${done} row${done === 1 ? '' : 's'} set to ${level === null ? 'Not set' : GRANT_STYLE[level].label}`];
      if (skipped) parts.push(`${skipped} skipped — that level is not allowed there`);
      if (failedKeys.size) parts.push(`${failedKeys.size} failed — see the rows`);
      setBulkNote(parts.join(' · '));
      setSelected(new Set());
      setAnchor(null);
    });
  };

  // One matcher, defined inside the memo it belongs to — a `matches` closure
  // declared in the component body would be a new function every render and
  // would have to be listed as a dependency of the memo below, which is a lint
  // fight for no benefit.
  const { tabs } = useMemo(() => {
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

    /*
     * The add/remove-records row under each module. Its answer depends on
     * the module's own result (`resolveMembership`, mirroring
     * `module_membership_allowed()` in SQL): a module the person cannot see
     * is No whatever is set, and an unset row follows the module — Edit means
     * Yes. The padlock carries that explanation, since "Not set" here does
     * not mean what it means on every other row.
     */
    const membershipRows = matrix.memberships.map(withEdits).map((r) => {
      const mod = moduleEffective.get(r.id) ?? 'edit';
      const raw = r.userGrant ?? r.templateGrant;
      const effective = resolveMembership(mod, raw, matrix.subjectIsAdmin);
      let lock = r.lock;
      if (!matrix.subjectIsAdmin) {
        if (mod === 'hidden') lock = 'The module is Hidden for this person, so they cannot add or remove records in it whatever this row says.';
        else if (raw === null) lock = `Not set — follows the module row: ${mod === 'edit' ? 'Edit means Yes' : 'View means No'}.`;
      }
      return { ...r, effective, lock };
    });

    return {
      modules: moduleRows.filter(matches),
      // Shown under its module when that module is shown; "only scopes with
      // an entry" applies to the row's own entry, like every other row.
      memberships: membershipRows.filter(
        (r) => !onlySet || edits.has(rowKey(r)) || r.templateGrant !== null || r.userGrant !== null,
      ),
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
  }, [matrix.modules, matrix.memberships, matrix.tabs, matrix.subjectIsAdmin, needle, onlySet, edits, withEdits, rowKey]);

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
    // The yes/no rows count as entries, not as "below Edit" — a No there is
    // a different kind of restriction from a View, and the chip says "below
    // Edit".
    for (const r of matrix.memberships.map(withEdits)) {
      if (r.templateGrant !== null) templateSet++;
      if (r.userGrant !== null) userSet++;
    }
    for (const t of matrix.tabs) {
      const tab = applyCeiling(withEdits(t.tab), ceilingOf(t.moduleIds, moduleEffective), MODULE_CEILING_NOTE);
      tally(tab);
      for (const g of t.groups) {
        if (g.subtab) tally(applyCeiling(withEdits(g.subtab), tab.effective, TAB_CEILING_NOTE));
        for (const f of g.fields) tally(applyCeiling(withEdits(f), tab.effective, TAB_CEILING_NOTE));
      }
    }
    return { ...matrix.counts, templateSet, userSet, restricted };
  }, [matrix.counts, matrix.modules, matrix.memberships, matrix.tabs, withEdits]);

  /*
   * The rows on screen, in the order they are drawn — the same walk the JSX
   * below makes, so "every row between these two" for a shift-click and
   * "every row shown" for select-all mean exactly what the admin sees. Rows
   * inside a collapsed tab are not on screen and are not in this list.
   */
  const { order, rowByKey } = useMemo(() => {
    const rows: ScopeRow[] = [];
    for (const t of tabs) {
      rows.push(t.tab);
      if (!isOpen(t.tab.id)) continue;
      for (const g of t.groups) {
        if (g.subtab) rows.push(g.subtab);
        rows.push(...g.fields);
      }
    }
    return {
      order: rows.map(rowKey),
      rowByKey: new Map(rows.map((r) => [rowKey(r), r] as const)),
    };
  }, [tabs, isOpen, rowKey]);

  const allShownSelected = order.length > 0 && order.every((k) => selected.has(k));
  const toggleAllShown = () => {
    setBulkNote(null);
    setSelected(allShownSelected ? new Set() : new Set(order));
  };

  /** One row, with everything the write path needs threaded through it. */
  const line = (row: ScopeRow, indent: boolean, alt = false) => {
    const key = rowKey(row);
    return (
      <ScopeLine
        key={key}
        row={row}
        showOverride={showOverride}
        indent={indent}
        alt={alt}
        editable={writer?.column ?? null}
        busy={bulkBusy ? selected.has(key) || edits.has(key) : busyKey === key}
        error={errors.get(key) ?? null}
        templateName={subject.kind === 'user' ? subject.templateLabel : null}
        onEdit={onEdit}
        selectable={selectable}
        selected={selected.has(key)}
        onSelect={onSelect}
      />
    );
  };

  const toggle = (tabId: string) =>
    setOpenTabs((prev) => {
      const next = new Set(prev);
      if (next.has(tabId)) next.delete(tabId);
      else next.add(tabId);
      return next;
    });

  return (
    <div className="space-y-4">
      {/*
        ONE rule, stated once. This used to be three notice blocks and a
        four-entry legend totalling about 400 words, which is more text than the
        grid it explained — and the one thing a reader must know was buried in
        the middle of it.
      */}
      <p className="flex items-start gap-2 rounded-xl border border-[#f7e0af] bg-[#fdf1d8] px-3.5 py-2.5 text-[12.5px] leading-relaxed text-[#8a5a09]">
        <Icon name="alert-triangle" size={14} className="mt-[2px] shrink-0" />
        <span>
          <strong className="font-semibold">Not set means Edit, not none.</strong> A tab nobody has set
          is Edit, inside what module access allows; a sub-tab or field follows its tab until it is set.
          Communication, Updates and Cases are not here — their settings above decide them.
          {writer ? ' Changes save as you click them.' : ' This screen is read-only.'}
        </span>
      </p>

      {subject.kind === 'user' && subject.isAdmin ? (
        /*
         * ── STICKY, AND LOUD, BECAUSE IT GOVERNS EVERY ROW BELOW IT ────────
         * This was a quiet grey note at the top of a long scrolling list. Set
         * a tab to View, scroll to it, and the Result says Edit — with the one
         * sentence that explains why now several screens above, and the only
         * in-context cue a padlock you have to hover.
         *
         * It was reported exactly that way: "I chose View and the result shows
         * Edit." Nothing was wrong — an admin resolves to Edit everywhere by
         * design — but the screen made it look wrong, which for a permission
         * screen is nearly as bad.
         *
         * So it sticks to the top of the scroll area and carries the same
         * amber as the other rule that changes how the whole grid reads. One
         * fact, visible wherever you are in the list.
         */
        <p className="sticky top-0 z-20 flex items-start gap-2 rounded-xl border border-[#f7e0af] bg-[#fdf1d8] px-3.5 py-2.5 text-[12.5px] leading-relaxed text-[#8a5a09] shadow-[0_2px_8px_-4px_rgba(8,32,47,.25)]">
          <Icon name="alert-triangle" size={14} className="mt-[2px] shrink-0" />
          <span>
            <strong className="font-semibold">
              {subject.label} is a Super admin, so everything below resolves to Edit
            </strong>{' '}
            — including any row set to Hidden or View. To limit them, change their user type.
          </span>
        </p>
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
            className="w-[280px] rounded-md border border-line py-1 pl-7 pr-2 text-[12.5px] outline-none focus-field"
          />
        </span>
        <label className="flex items-center gap-1.5 text-[12.5px] text-ink-600">
          <input type="checkbox" checked={onlySet} onChange={(e) => setOnlySet(e.target.checked)} />
          Only scopes with an entry
        </label>
        {selectable ? (
          <label className="flex items-center gap-1.5 text-[12.5px] text-ink-600" title="Tick every row currently shown. Shift-click a row's box to select a range.">
            <input type="checkbox" checked={allShownSelected} onChange={toggleAllShown} className="accent-[#1d4ed8]" />
            Select all shown
          </label>
        ) : null}
        <span className="ml-auto flex items-center gap-2 text-[12px] text-ink-400">
          <OutlineChip>{counts.scopes} scopes</OutlineChip>
          <OutlineChip tone={counts.templateSet ? 'brand' : 'neutral'}>
            {counts.templateSet} from the type
          </OutlineChip>
          {showOverride ? (
            <OutlineChip tone={counts.userSet ? 'brand' : 'neutral'}>
              {counts.userSet} override{counts.userSet === 1 ? '' : 's'}
            </OutlineChip>
          ) : null}
          <OutlineChip tone={counts.restricted ? 'warn' : 'neutral'}>{counts.restricted} below Edit</OutlineChip>
        </span>
      </div>

      {/* Module access and "Display / remove from modules" are settings now
          (Permissions spec), edited in the Settings panel above this matrix —
          a module or membership grant row has no effect anywhere. */}
      {/* ---- tabs and their fields ---- */}
      <section className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.05)]">
        <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-3">
          <h2 className="text-[14px] font-semibold text-ink-900">Tabs &amp; fields</h2>
          <EnforcementChip kind="tab" />
          {/* This line used to read "Tabs and fields are global — one set for
              the whole CRM, so a grant here applies in every module at once."
              That was true until per-module grants landed and is now exactly
              backwards, which is worse than saying nothing. The module picker
              above the grid says which scope is being edited. */}
        </div>
        <HeaderRow showOverride={showOverride} first="Tab / field" editable={writer?.column ?? null} />

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

      {bulkNote ? (
        <p role="status" className="text-[12.5px] text-ink-500">
          {bulkNote}
        </p>
      ) : null}

      {/*
        The bulk bar — the same floating bar the records table uses for its
        selection, so the two screens agree about what "N selected" looks
        like. One action per level; "Not set" clears, like the control.
      */}
      {selectable ? (
        <FloatingBar
          open={selected.size > 0}
          lead={<BarCount n={selected.size} label={selected.size === 1 ? 'row selected' : 'rows selected'} />}
          onClose={() => {
            setSelected(new Set());
            setAnchor(null);
          }}
        >
          <BarAction icon="x" label="Not set" disabled={bulkBusy} onClick={() => applyBulk(null)} title="Clear the grant on every selected row" />
          {GRANT_LEVELS.map((g) => (
            <BarAction
              key={g}
              icon={g === 'hidden' ? 'eye-off' : g === 'view' ? 'eye' : 'pencil'}
              label={GRANT_STYLE[g].label}
              disabled={bulkBusy}
              onClick={() => applyBulk(g)}
              title={`Set every selected row to ${GRANT_STYLE[g].label}${g === 'edit' ? ' (Yes on an add/remove row)' : g === 'view' ? ' (No on an add/remove row)' : ''}`}
            />
          ))}
        </FloatingBar>
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
