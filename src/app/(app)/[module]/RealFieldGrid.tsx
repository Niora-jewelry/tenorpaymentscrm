'use client';

/**
 * The drawer's field grid — real data, same visual language as
 * `src/proto/ui/tabs.tsx`'s `FieldGrid`/`FieldCell` (flex-wrap, content-aware
 * width per the 19 Aug amendment: "no strict 3-per-row, space efficient"),
 * reusing `FieldRenderer` from `src/proto/ui/value.tsx` verbatim for the
 * actual per-type editing UI — it is already a pure, props-driven component
 * with no store dependency, so every field type it already handles (typed
 * grid, must-total-100% split, multi-select, identifier digit validation…)
 * works here unchanged.
 *
 * Local optimistic state: a field's new value appears the instant it's
 * typed, the server call happens in the background, and only a genuine
 * conflict (someone else saved first) or an error rolls it back — MODULE-2-
 * PLAN §13.3/§13.4's "value retained, red ring, inline reason" and "loser is
 * told, both values shown."
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, useTransition, type ReactNode } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { FieldRenderer } from '@/proto/ui/value';
import { VISIBILITY_FIELD_KEY } from '@/lib/records/grantRules';
import { Icon } from '@/proto/ui/icons';
import { Button, CountPill, IconButton } from '@/proto/ui/kit';
import { FieldMentionButton, FieldMentionNote, valueText } from './FieldMention';
import { FLASH_CLASS, targetId, useFlashTarget } from './mentionTarget';
import type { NotificationView } from '@/lib/records/notifications';
import type { Field as ProtoField, FieldValue } from '@/proto/schema';
import {
  setValuesAction, addRepeatInstanceAction, removeRepeatInstanceAction,
  reorderFieldsAction, resetFieldOrderAction,
} from './actions';
import {
  seedRecordVersion, currentToken, commitToken, isOwnToken, enqueueWrite,
  publishValue, publishedValue, subscribeToValues, valuesSnapshot,
  queueEdit, flushPendingEdits, type PendingEdit,
} from './recordVersion';
import type { RepeatGroupDef } from './DrawerTabs';
import { NoteThread } from './NoteThread';
import type { Note } from '@/lib/records/notes';

type Grant = 'hidden' | 'view' | 'edit';

/**
 * How many grid columns a field occupies.
 *
 * The drawer used `flex-wrap`, which lays every row out independently, so
 * column edges moved from row to row and nothing lined up. It is a grid with
 * one repeating track now, and a field asks for a number of tracks:
 *
 *   * repeat groups and the One Time Charges grid are tables in their own
 *     right, with column headers — the full row;
 *   * an address, long text, percent split, month picker, and a team-member
 *     list take two tracks. Two for the team list matters: in one track its
 *     chips stacked vertically and made the whole row three times taller,
 *     leaving every field beside it floating in empty space;
 *   * everything else takes one.
 *
 * Keyed by TYPE, so a field added in Presets is placed correctly with no
 * change here.
 */
const FULL_WIDTH_TYPES = new Set<ProtoField['type']>(['repeat_group', 'grid']);
const DOUBLE_WIDTH_TYPES = new Set<ProtoField['type']>([
  'address', 'long_text', 'percent_split', 'months', 'team_member',
]);

function spanFor(field: ProtoField): string {
  if (FULL_WIDTH_TYPES.has(field.type)) return '1 / -1';
  if (DOUBLE_WIDTH_TYPES.has(field.type) || field.wide) return 'span 2';
  return 'span 1';
}

/** One shared track for every field grid in the drawer, so tabs line up with
 *  each other as well as within themselves. `auto-fill` rather than
 *  `auto-fit`: `auto-fit` stretches a short tab's few fields across the whole
 *  width and brings the unevenness straight back. */
const GRID_TRACKS = 'grid items-stretch [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]';

/**
 * Tucks a grid's outer cell borders under the card that contains it.
 *
 * Every cell draws its own bottom and right border. That is right between
 * cells and wrong at the edges: a short last row drew a bottom line that
 * stopped partway across (under Owner 1's Email and Percentage it ended at
 * column two), and every rightmost cell drew a second line against the card's
 * own border.
 *
 * Shifting the grid one pixel past the card's bottom and right edge puts
 * those outer lines exactly under the card border, where `overflow-hidden`
 * clips them — so the card's single full-width edge closes the box. Only ever
 * used inside an `overflow-hidden` parent; without one this would spill a
 * pixel.
 */
const GRID_EDGE = '-mb-px -mr-px';

/** A repeat group's stored value should always be an array of instances —
 * but a value written before the `setValueAction` JSON round-trip fix
 * (earlier this session: object/array-shaped values were being saved as
 * double-JSON-encoded TEXT instead of real JSONB) could still have a plain
 * string sitting in an older record's `values[group.key]`. `Array.isArray`
 * guards every read site against that shape instead of crashing with
 * "`.map` is not a function" the moment that field renders or is edited. */
function asInstanceArray(v: unknown, fallback: Record<string, unknown>[]): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : fallback;
}

/**
 * One draggable field cell — a DEDICATED drag handle, not the whole cell.
 *
 * The whole cell used to carry `{...attributes}{...listeners}` (matching
 * native HTML5 drag's "whole card is draggable" feel), but that was a real,
 * serious bug: dnd-kit's `KeyboardSensor` attaches its own keydown listener
 * to whatever element gets `listeners` — its Space-to-lift activator calls
 * `preventDefault()` on Space to stop the page from scrolling, and since a
 * keydown fired inside a child `<input>` bubbles up to an ancestor's
 * listener, that `preventDefault()` silently ate every space bar keystroke
 * typed into any field in the whole grid (address lines, long text, notes —
 * anything with multiple words). Native HTML5 `draggable` never had this
 * problem because it has no keyboard activation at all. A small, separate
 * handle (a sibling of the field's own content, not an ancestor) is the
 * standard dnd-kit pattern for exactly this reason.
 */
/**
 * The cards a sub-tab draws: the unsectioned fields first (the main grid),
 * then one card per section label in order of first appearance. A section is
 * configuration (`fields.section`), so a new one needs no code.
 */
function sectionsOf(fields: ProtoField[]): { key: string; label: string | null; fields: ProtoField[] }[] {
  const out: { key: string; label: string | null; fields: ProtoField[] }[] = [];
  const index = new Map<string, number>();
  for (const f of fields) {
    const label = f.section?.trim() || null;
    const k = label ?? '';
    let i = index.get(k);
    if (i === undefined) {
      i = out.length;
      index.set(k, i);
      out.push({ key: k || '__main', label, fields: [] });
    }
    out[i].fields.push(f);
  }
  out.sort((x, y) => (x.label === null ? -1 : y.label === null ? 1 : 0));
  return out;
}

type DragHandleProps = { attributes: ReturnType<typeof useSortable>['attributes']; listeners: ReturnType<typeof useSortable>['listeners'] };

/** `children` is a render prop so the caller can place the handle INLINE in
 * its own label row (matching the prototype's shuffle icon sitting before
 * the field label) — never as an absolutely-positioned overlay, which would
 * collide with the label row's own trailing notes-toggle button. */
function SortableFieldCell({
  id,
  span,
  requiredEmpty,
  flash = false,
  children,
}: {
  id: string;
  /** A `grid-column` value — see `spanFor`. */
  span: string;
  requiredEmpty?: boolean;
  /** A mention link landed on this field: scroll to it and flash. */
  flash?: boolean;
  children: (handle: DragHandleProps) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const flashing = useFlashTarget(targetId.field(id), flash);

  return (
    <div
      ref={setNodeRef}
      style={{
        gridColumn: span,
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      /*
       * The focused cell TINTS. It does not draw a line, and it does not box.
       *
       * Originally a 2px brand rectangle around the whole cell, which in a grid
       * where every cell already has borders on two sides reads as a box inside
       * a box. Replacing that with a bottom line then collided with the input's
       * own underline sitting a couple of pixels above it.
       *
       * So the division is: the CONTROL owns the line (`focus-field`), and
       * the CELL owns the wash. One indicator each, at different scales, and
       * they cannot double up.
       *
       * A required-but-empty cell keeps its warning stripe on the LEFT edge.
       */
      id={targetId.field(id)}
      className={`group/cell relative border-b border-r border-line-soft px-3 py-2 transition-colors last:border-r-0 hover:bg-brand-50/30 focus-within:relative focus-within:z-10 focus-within:bg-brand-50/60 ${
        requiredEmpty ? 'bg-warn-bg/45 shadow-[inset_2px_0_0_var(--color-warn)]' : 'bg-white'
      } ${isDragging ? 'z-10 opacity-40' : ''} ${flashing ? `z-10 ${FLASH_CLASS}` : ''}`}
    >
      {children({ attributes, listeners })}
    </div>
  );
}

export function RealFieldGrid({
  moduleSlug,
  recordId,
  tabId,
  subtabId,
  fields,
  repeatGroups,
  hasCustomFieldOrder,
  grantByKey,
  values,
  setValues,
  conflicts,
  setConflicts,
  saving,
  setSaving,
  savedCount,
  onSaved,
  markEdited,
  initialUpdatedAt,
  notesByField,
  authorNames,
  viewerId,
  isAdmin,
  mentionsByField = {},
  openMention = null,
  onMentionRead = () => undefined,
}: {
  moduleSlug: string;
  recordId: string;
  tabId: string;
  /** The viewer's unread mentions on this tab's fields, by field key. */
  mentionsByField?: Record<string, NotificationView[]>;
  /** A field mention a link landed on. */
  openMention?: NotificationView | null;
  onMentionRead?: (id: string) => void;
  subtabId: string | null;
  fields: ProtoField[];
  repeatGroups: RepeatGroupDef[];
  hasCustomFieldOrder: boolean;
  grantByKey: Record<string, Grant>;
  /*
   * Values, conflicts and the in-flight count are OWNED BY `DrawerTabs`, not
   * by this component. They used to be local state, which meant every switch
   * to a non-field tab unmounted this grid and threw the edits away — see the
   * long note at the top of `DrawerTabs`. Nothing here should reintroduce
   * `useState` over these.
   */
  values: Record<string, unknown>;
  setValues: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
  conflicts: Record<string, string>;
  setConflicts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  saving: number;
  setSaving: React.Dispatch<React.SetStateAction<number>>;
  /** Successful writes so far this drawer session. Only used to decide whether
   *  "All changes saved" has anything to confirm yet. */
  savedCount: number;
  onSaved: () => void;
  /** Marks a key as locally written, so a later server render that predates
   *  the write cannot overwrite it. See `editedKeys` in `DrawerTabs`. */
  markEdited: (key: string) => void;
  initialUpdatedAt: string;
  notesByField: Record<string, Note[]>;
  authorNames: Record<string, string>;
  viewerId: string;
  isAdmin: boolean;
}) {
  const [openNotes, setOpenNotes] = useState<Set<string>>(new Set());
  /*
   * View preferences (field order) persist in the background. They were
   * `await someAction(...)` with nothing around them, so a failed save was
   * completely invisible: the UI had already applied the change locally, and
   * it silently reverted on the next page load — which reads as the CRM
   * forgetting your layout at random. Lower stakes than a refused write, so a
   * quiet line rather than an alert. But not silence.
   */
  const [prefError, setPrefError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  /* Fields whose last write did not land. Derived from `conflicts` rather than
   * counted separately, so it cannot drift out of step with the red rings
   * already shown on the cells themselves. */
  const failedCount = Object.keys(conflicts).length;

  // The compare-and-swap token lives in `recordVersion.ts`, NOT in this
  // component's state. It used to be `useState(initialUpdatedAt)`, which lost
  // it every time this grid unmounted (any trip through a non-field tab) and
  // let two concurrent edits capture the same value. Both made ordinary edits
  // fail with a phantom "someone else changed this". The full account is in
  // that file's header.
  seedRecordVersion(recordId, initialUpdatedAt);

  /*
   * ── THE OTHER HALF OF "NOT SYNCING WITH HEADER FIELD" ───────────────────
   * This grid already PUBLISHES its edits so the header strip above can
   * follow them. It did not subscribe, so the reverse never worked: editing
   * Pricing Model (or Current Status, or MID, or MCC code — they are all
   * configured into both places) in the HEADER left this grid showing the old
   * value until a full page render, which `setValueAction` deliberately does
   * not trigger.
   *
   * Half a fix is the worse kind here, because which direction a person
   * happens to edit in is arbitrary — the same field disagreeing with itself
   * looks like lost data either way round.
   *
   * A published value always wins over the server prop. That is safe in both
   * directions: this grid publishes its own edits too, so for a field IT
   * changed the published value is simply its own, and for a field the header
   * changed it is the newer one. Only this page ever writes to the store.
   */
  const subscribeValues = useCallback(
    (onChange: () => void) => subscribeToValues(recordId, onChange),
    [recordId],
  );
  const valuesRevision = useCallback(() => valuesSnapshot(recordId), [recordId]);
  useSyncExternalStore(subscribeValues, valuesRevision, valuesRevision);

  /** What a field should show: anything this page has set, else the server's. */
  const shownValue = (key: string): unknown => {
    const published = publishedValue(recordId, key);
    return published.has ? published.value : values[key];
  };

  /*
   * Send anything still buffered when this grid goes away.
   *
   * The buffer lives outside the component (keyed by record), so a tab switch
   * cannot lose it — but the drawer closing ends the page's life with the
   * user believing those fields were saved. Flushing here turns the last
   * ~350ms window into an immediate send instead of a silent loss.
   */
  /**
   * Send one batch of buffered edits.
   *
   * Everything the batch touches succeeds or fails together, which matches what
   * the server does: `set_record_values` applies the whole batch under a single
   * compare-and-swap, so a partial result is not a state that exists.
   */
  const flushBatch = async (batch: PendingEdit[]) => {
    const attempt = (token: string) =>
      setValuesAction(
        moduleSlug,
        recordId,
        batch.map((e) => ({ fieldKey: e.fieldKey, value: e.encoded })),
        token,
      );

    try {
      const first = await attempt(currentToken(recordId, initialUpdatedAt));
      let result = first;

      // The row moved on. If it moved on because of a write WE made, the
      // disagreement is bookkeeping rather than a real conflict — nobody else
      // touched the record, our token was simply behind — so retry once against
      // the token the row actually holds. If it was someone else, fall through
      // and tell the user; never silently overwrite a stranger's edit (§13.4).
      if (!first.ok && first.conflict && isOwnToken(recordId, first.conflict.currentUpdatedAt)) {
        commitToken(recordId, first.conflict.currentUpdatedAt);
        result = await attempt(first.conflict.currentUpdatedAt);
      }

      if (!result.ok) {
        if (result.conflict) commitToken(recordId, result.conflict.currentUpdatedAt);
        // Put every field in the batch back the way it was, and say why on each
        // one — never a silent overwrite (§13.4).
        setValues((v) => {
          const next = { ...v };
          for (const e of batch) next[e.fieldKey] = e.previous;
          return next;
        });
        setConflicts((c) => {
          const next = { ...c };
          for (const e of batch) next[e.fieldKey] = result.ok ? '' : (result.message ?? 'Save failed.');
          return next;
        });
      } else {
        // The SERVER's `updated_at`, never a locally-generated one. This is the
        // token the next batch sends back, and it has to be byte-identical to
        // what the row now holds — the client clock cannot reproduce
        // Postgres's `now()`.
        commitToken(recordId, result.updatedAt);
        onSaved();
      }
    } catch {
      // The action never completed — offline, a dropped connection, a server
      // error. Rolled back and named rather than left looking saved.
      setValues((v) => {
        const next = { ...v };
        for (const e of batch) next[e.fieldKey] = e.previous;
        return next;
      });
      setConflicts((c) => {
        const next = { ...c };
        for (const e of batch) {
          next[e.fieldKey] =
            'Could not reach the server. Your change was not saved — check your connection and try again.';
        }
        return next;
      });
    } finally {
      setSaving((n) => Math.max(0, n - batch.length));
    }
  };

  /*
   * Flush anything still buffered when this grid goes away.
   *
   * The buffer lives outside the component (keyed by record), so a tab switch
   * cannot lose it — but the drawer closing ends the page's life with the user
   * believing those fields were saved. Flushing on unmount turns the last
   * ~350ms window into an immediate send instead of a silent loss.
   *
   * Both hooks sit ABOVE the early return below, because hooks must run in the
   * same order on every render. The "latest ref" pattern (refreshed after every
   * render, no dep array) is what lets the unmount cleanup call the CURRENT
   * closure rather than the first render's stale one — and `flushBatch` is
   * reached through `latest` rather than directly, since it is declared further
   * down the component.
   */
  const flushRef = useRef<() => void>(() => {});
  useEffect(() => {
    flushRef.current = () => flushPendingEdits(recordId, initialUpdatedAt, flushBatch);
  });
  useEffect(() => () => flushRef.current(), []);

  /*
   * Field drag — personalization layer 2 (19 Aug amendment): "one
   * personalization per tab covers every module," resolved server-side
   * (page.tsx's `resolveOrder`) and re-fetched via the reorder Server
   * Action's own `revalidatePath` — no separate `router.refresh()` (that was
   * a fully redundant second round trip; see the comment at the call site) —
   * no local optimistic array state to keep in sync across a subtab switch
   * either, dnd-kit's own drag transform already makes the motion feel
   * instant.
   */
  const fieldDndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (!fields.length && !repeatGroups.length) return null;

  const handleFieldDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = fields.map((f) => f.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    startTransition(async () => {
      // No router.refresh() here: reorderFieldsAction already calls
      // revalidatePath, and a Server Action's own response already carries a
      // fresh RSC payload for the route it was invoked from — a follow-up
      // router.refresh() was a second, fully redundant ~2s round trip for the
      // exact same data (confirmed live: it fired its own separate _rsc GET
      // well after the action's POST had already resolved).
      try {
        setPrefError(null);
        await reorderFieldsAction(moduleSlug, tabId, subtabId, ids);
      } catch {
        setPrefError('Your field order could not be saved and will reset on reload.');
      }
    });
  };


  const handleChange = (fieldId: string, next: FieldValue) => {
    const previous = values[fieldId];

    // Optimistic — the value shows instantly.
    // Marked as locally written FIRST, so a server render that lands mid-flight
    // (from any other panel's `router.refresh()`) layers this key back on top
    // instead of resetting the cell to the value the page was rendered with.
    markEdited(fieldId);
    setValues((v) => ({ ...v, [fieldId]: next }));
    /* Tell the header strip, which renders several of these same fields
       above this grid and would otherwise keep showing the old value until
       the next full page render. See `publishValue`. */
    publishValue(recordId, fieldId, next);
    setConflicts((c) => {
      if (!(fieldId in c)) return c;
      const rest = { ...c };
      delete rest[fieldId];
      return rest;
    });
    /*
     * Buffered, not sent immediately.
     *
     * Each save costs three sequential network waves — the proxy's session
     * check, `authorize()`'s user validation, then the write — and the writes
     * are serialised per record because each needs the previous one's
     * compare-and-swap token. One request per field therefore multiplied the
     * whole chain by the number of fields: five fields measured over ten
     * seconds, with the badge reading "Saving 5 changes…" the entire time.
     *
     * Collecting a burst of edits into one request sends five fields for the
     * price of one, and `set_record_values` applies them under a single token
     * so there is nothing left to serialise within a batch.
     */
    const isNewPending = queueEdit(
      recordId,
      initialUpdatedAt,
      {
        fieldKey: fieldId,
        encoded: next == null ? null : typeof next === 'object' ? JSON.stringify(next) : String(next),
        previous,
      },
      flushBatch,
    );
    // Counted per FIELD, not per keystroke-commit — re-editing a field that is
    // already waiting does not add a second thing to save, and counting it
    // would leave the badge stuck at "Saving…" once the batch resolved.
    if (isNewPending) setSaving((n) => n + 1);
  };

  /**
   * Edit one member field of one repeat instance.
   *
   * ⚠️ PADDED FIRST, and that is the whole point. This used to be a bare
   * `.map`, which only ever reaches indices the stored array ALREADY has — so
   * every edit at an index past its end was silently dropped.
   *
   * That is not an edge case, it is the default state of a new record. The
   * grid renders `Math.max(1, arr.length, group.count)` instances and fills the
   * missing ones with `{}`, so a record whose `owner_ownership` has never been
   * written shows one empty Owner form over a ZERO-length array. Typing a name
   * into it produced `[].map(...)` → `[]` → a save of "no owners", and the
   * value blanked itself the moment the field lost focus. Any index beyond
   * `arr.length` behaved the same way: with 3 owners recorded but
   * `owner_private` still empty, all three SSNs vanished as they were typed.
   *
   * `handleAddInstance` already padded for exactly this reason — clicking
   * "Add owner" before typing was the accidental workaround that made it look
   * intermittent. This applies the same padding on the edit path.
   */
  const handleMemberChange = (group: RepeatGroupDef, index: number, memberKey: string, next: FieldValue) => {
    const currentArr = asInstanceArray(values[group.key], group.values);
    // Grow to cover the index being edited AND the instance count the grid is
    // actually rendering, so sibling arrays in the same group stay the same
    // length rather than drifting apart.
    const needed = Math.max(index + 1, group.count, currentArr.length);
    const padded = Array.from({ length: needed }, (_, i) => currentArr[i] ?? {});
    padded[index] = { ...padded[index], [memberKey]: next };
    handleChange(group.key, padded as unknown as FieldValue);
  };

  /**
   * Add/remove a repeat instance. These write the SAME record row as
   * `handleChange`, so they advance the same compare-and-swap token and must
   * share its queue — an add running alongside a field edit was one of the ways
   * two writes ended up holding the same stale token.
   *
   * They do not take an `expectedUpdatedAt` of their own (their actions
   * re-read the row server-side), so there is no retry arm here: queueing is
   * what they need, and committing the token they return is what keeps the
   * NEXT field edit from using a value these calls have already superseded.
   */
  const handleAddInstance = (group: RepeatGroupDef) => {
    const prevValues = values;
    const currentArr = asInstanceArray(values[group.key], group.values);
    const padded = [...currentArr, ...Array.from({ length: Math.max(0, group.count - currentArr.length) }, () => ({}))];
    markEdited(group.key);
    setValues((v) => ({ ...v, [group.key]: [...padded, {}] }));
    setConflicts((c) => {
      if (!(group.key in c)) return c;
      const rest = { ...c };
      delete rest[group.key];
      return rest;
    });
    setSaving((n) => n + 1);

    startTransition(async () => {
      try {
        const result = await enqueueWrite(recordId, initialUpdatedAt, () =>
          addRepeatInstanceAction(moduleSlug, recordId, group.key),
        );
        if (!result.ok) {
          setValues((v) => ({ ...v, [group.key]: prevValues[group.key] }));
          setConflicts((c) => ({ ...c, [group.key]: result.message }));
        } else {
          // No router.refresh(): the local optimistic array already reflects
          // the new instance, and addRepeatInstanceAction's own revalidatePath
          // already refreshed this route as part of the action round trip.
          commitToken(recordId, result.updatedAt);
        }
      } catch {
        setValues((v) => ({ ...v, [group.key]: prevValues[group.key] }));
        setConflicts((c) => ({ ...c, [group.key]: 'Could not reach the server. Nothing was added.' }));
      } finally {
        setSaving((n) => Math.max(0, n - 1));
      }
    });
  };

  const handleRemoveInstance = (group: RepeatGroupDef, index: number) => {
    const prevValues = values;
    const currentArr = asInstanceArray(values[group.key], group.values);
    markEdited(group.key);
    setValues((v) => ({ ...v, [group.key]: currentArr.filter((_, i) => i !== index) }));
    setSaving((n) => n + 1);

    startTransition(async () => {
      try {
        const result = await enqueueWrite(recordId, initialUpdatedAt, () =>
          removeRepeatInstanceAction(moduleSlug, recordId, group.key, index),
        );
        if (!result.ok) {
          setValues((v) => ({ ...v, [group.key]: prevValues[group.key] }));
          setConflicts((c) => ({ ...c, [group.key]: result.message }));
        } else {
          // Same reasoning as handleAddInstance: no router.refresh() needed.
          commitToken(recordId, result.updatedAt);
        }
      } catch {
        setValues((v) => ({ ...v, [group.key]: prevValues[group.key] }));
        setConflicts((c) => ({ ...c, [group.key]: 'Could not reach the server. Nothing was removed.' }));
      } finally {
        setSaving((n) => Math.max(0, n - 1));
      }
    });
  };

  return (
    <div className="relative space-y-4">
      {/*
        Saving feedback. A field edit is a network round trip measured in
        hundreds of milliseconds against the live database, and it had NO
        indicator of any kind: the optimistic value appeared instantly and
        nothing ever said whether it had actually reached the server. A save
        that then failed looked like a value that had saved and later reverted
        on its own.

        Pinned rather than inline so it cannot reflow the grid mid-edit, and it
        counts in-flight writes rather than tracking a boolean, so a burst of
        edits shows one steady indicator instead of flickering per field.
        `aria-live="polite"` announces it without stealing focus from the input
        the user is still typing in.
      */}
      <div
        aria-live="polite"
        className={`pointer-events-none sticky top-2 z-20 flex justify-end transition-opacity duration-200 ${
          saving > 0 || savedCount > 0 || failedCount > 0 ? 'opacity-100' : 'h-0 opacity-0'
        }`}
      >
        {saving > 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white/95 px-2.5 py-1 text-[11.5px] text-ink-500 shadow-[0_1px_3px_rgba(8,32,47,.10)] backdrop-blur">
            <span className="size-1.5 animate-pulse rounded-full bg-brand-600" />
            Saving{saving > 1 ? ` ${saving} changes` : ''}…
          </span>
        ) : failedCount > 0 ? (
          /* An unsaved field is the one state that must never be quiet. This
             is what makes auto-save honest: it is only safe to have no Save
             button if the screen always says whether the work is safe. */
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#f7cfd1] bg-[#fce9ea] px-2.5 py-1 text-[11.5px] font-semibold text-[#b02a30] shadow-[0_1px_3px_rgba(8,32,47,.10)]">
            <Icon name="alert-triangle" size={11} />
            {failedCount === 1 ? '1 change not saved' : `${failedCount} changes not saved`}
          </span>
        ) : savedCount > 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white/95 px-2.5 py-1 text-[11.5px] text-ink-500 shadow-[0_1px_3px_rgba(8,32,47,.10)] backdrop-blur">
            <Icon name="check" size={11} className="text-ok" />
            All changes saved
          </span>
        ) : null}
      </div>

      {fields.length ? (
        <DndContext
          id={`field-dnd-${tabId}-${subtabId ?? '_'}`}
          sensors={fieldDndSensors}
          collisionDetection={closestCenter}
          onDragEnd={handleFieldDragEnd}
        >
        <SortableContext items={fields.map((f) => f.id)} strategy={rectSortingStrategy}>
        {sectionsOf(fields).map((sec, si) => (
        <section key={sec.key} className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.04)]">
          {sec.label ? (
            /* A named section: the same card, headed like a repeating group. */
            <header className="flex items-center gap-2 border-b border-line-soft bg-canvas/60 px-3 py-2">
              <span className="text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-500">{sec.label}</span>
            </header>
          ) : null}
          {si === 0 && hasCustomFieldOrder ? (
            <div className="flex items-center gap-2 border-b border-line-soft bg-brand-50/60 px-3 py-1.5">
              <Icon name="shuffle" size={11} className="text-brand-600" />
              <span className="text-[11.5px] text-brand-700">
                Reordered by you — applies to this tab in every module.
              </span>
              <button
                type="button"
                onClick={() =>
                  // No router.refresh(): resetFieldOrderAction already calls
                  // revalidatePath, which already refreshes this route as
                  // part of the action's own response.
                  startTransition(async () => {
                    try {
                      setPrefError(null);
                      await resetFieldOrderAction(moduleSlug, tabId, subtabId);
                    } catch {
                      setPrefError('Could not reset the field order.');
                    }
                  })
                }
                className="ml-auto text-[11.5px] font-semibold text-brand-700 hover:underline"
              >
                Reset to default
              </button>
            </div>
          ) : null}
          {si === 0 && prefError ? (
            <p role="status" className="mt-1 text-[11px] text-ink-500">
              {prefError}
            </p>
          ) : null}
              <div className={`${GRID_TRACKS} ${GRID_EDGE}`}>
                {sec.fields.map((f) => {
                  const grant = grantByKey[f.id] ?? 'hidden';
                  if (grant === 'hidden') return null;
                  const v = shownValue(f.id);
                  const fieldEmpty =
                    v == null || v === '' || (Array.isArray(v) && !v.length) ||
                    (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v as object).length);
                  const fieldMentions = mentionsByField[f.id] ?? [];
                  const landedHere = openMention?.fieldKey === f.id;
                  return (
                    <SortableFieldCell key={f.id} id={f.id} span={spanFor(f)} requiredEmpty={f.required && fieldEmpty} flash={landedHere}>
                      {(handle) => (
                      <>
                      <div className="flex min-h-[18px] items-center gap-1.5">
                        <button
                          type="button"
                          aria-label={`Reorder ${f.label}`}
                          {...handle.attributes}
                          {...handle.listeners}
                          className="flex shrink-0 cursor-grab items-center text-ink-300 opacity-0 transition-opacity group-hover/cell:opacity-100 active:cursor-grabbing"
                        >
                          <Icon name="shuffle" size={11} />
                        </button>
                        <span className="truncate text-[11px] font-semibold uppercase tracking-[.05em] text-ink-500">
                          {f.label}
                        </span>
                        {f.system ? <Icon name="lock" size={10} className="text-ink-400" /> : null}
                        {f.sync ? <Icon name="link" size={10} className="text-brand-600" aria-label="Sync-enabled" /> : null}
                        {f.required && fieldEmpty ? (
                          <Icon name="alert-triangle" size={10} className="text-warn" />
                        ) : null}
                        {/* The client's "@ on any field": a mention arrives
                            with the dot; a mention leaves from the @. */}
                        <FieldMentionNote mentions={fieldMentions} autoOpen={landedHere ? openMention : null} onRead={onMentionRead} />
                        <FieldMentionButton recordId={recordId} fieldKey={f.id} fieldLabel={f.label} currentValue={valueText(v)} />

                        {f.notes ? (
                          <span className="ml-auto flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() =>
                                setOpenNotes((s) => {
                                  const next = new Set(s);
                                  if (next.has(f.id)) next.delete(f.id);
                                  else next.add(f.id);
                                  return next;
                                })
                              }
                              title={`${(notesByField[`field:${f.id}`] ?? []).length} note${(notesByField[`field:${f.id}`] ?? []).length === 1 ? '' : 's'} on this field`}
                              className={`inline-flex items-center gap-0.5 rounded px-1 py-px text-[10.5px] font-semibold transition-colors ${
                                (notesByField[`field:${f.id}`] ?? []).length
                                  ? 'bg-brand-50 text-brand-700 hover:bg-brand-100'
                                  : 'text-ink-400 hover:bg-canvas hover:text-ink-700'
                              }`}
                            >
                              <Icon name="sticky-note" size={10} />
                              {(notesByField[`field:${f.id}`] ?? []).length || ''}
                            </button>
                          </span>
                        ) : null}
                      </div>

                      <FieldRenderer
                        field={f}
                        value={shownValue(f.id) as FieldValue}
                        grant={grant === 'edit' ? 'edit' : 'view'}
                        moduleSlug={moduleSlug}
                        // Only the `team_member` control reads these three.
                        // `f.id` IS the field key here (`adapter.ts` makes that
                        // identity deliberate), and of the three fields of that
                        // type only this key is read by the trigger that
                        // decides record visibility.
                        grantsVisibility={f.id === VISIBILITY_FIELD_KEY}
                        viewerId={viewerId}
                        viewerIsAdmin={isAdmin}
                        onChange={(v) => handleChange(f.id, v)}
                      />

                      {f.hint ? (
                        <p title={f.hint} className="line-clamp-2 pt-0.5 text-[11px] leading-snug text-ink-400">
                          {f.hint}
                        </p>
                      ) : null}
                      {conflicts[f.id] ? (
                        <p className="mt-0.5 rounded border border-bad/25 bg-bad-bg px-1.5 py-1 text-[11px] text-bad">
                          {conflicts[f.id]}
                        </p>
                      ) : null}
                      {f.notes && openNotes.has(f.id) ? (
                        <NoteThread
                          moduleSlug={moduleSlug}
                          recordId={recordId}
                          scopeKind="field"
                          scopeId={f.id}
                          notes={notesByField[`field:${f.id}`] ?? []}
                          authorNames={authorNames}
                          viewerId={viewerId}
                          isAdmin={isAdmin}
                          title={f.label.toLowerCase()}
                          compact
                        />
                      ) : null}
                      </>
                      )}
                    </SortableFieldCell>
                  );
                })}
              </div>
        </section>
        ))}
        </SortableContext>
        </DndContext>
      ) : null}

      {repeatGroups.map((group) => {
        const grant = grantByKey[group.key] ?? 'hidden';
        if (grant === 'hidden') return null;
        const editable = grant === 'edit';
        const arr = asInstanceArray(values[group.key], group.values);
        const count = Math.max(1, arr.length, group.count);
        const atMax = count >= group.max;
        const singular = group.label.replace(/s$/, '');

        return (
          <section key={group.id} className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.04)]">
            <header className="flex items-center gap-2 border-b border-line-soft bg-canvas/60 px-3 py-2">
              <span className="text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-500">
                {group.label}
              </span>
              <CountPill n={count} />
              {editable ? (
                <span className="ml-auto">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="plus"
                    disabled={atMax}
                    title={atMax ? `Up to ${group.max} ${singular.toLowerCase()}s` : `Add another ${singular.toLowerCase()}`}
                    onClick={() => handleAddInstance(group)}
                  >
                    Add {singular.toLowerCase()}
                  </Button>
                </span>
              ) : null}
            </header>

            {Array.from({ length: count }, (_, i) => i).map((index) => {
              const instance = arr[index] ?? {};
              return (
                /*
                 * The key carries `count`, not just the index.
                 *
                 * Every control inside a repeat instance is UNCONTROLLED — the
                 * inputs in `proto/ui/value.tsx` render `defaultValue`, and a
                 * `defaultValue` is read once, at mount. Keyed by index alone,
                 * removing owner 2 of 3 leaves React reusing row 2's DOM for
                 * what is now owner 3: the props shift down, the mounted inputs
                 * do not, and the old text stays on screen against the wrong
                 * person. The masked-value toggle is worse — `shown` is local
                 * state on the same nodes, so a revealed SSN could survive the
                 * removal and end up displayed for a different owner.
                 *
                 * Folding the instance COUNT into the key makes every row a new
                 * element whenever one is added or removed, which remounts them
                 * against the values that just came back from the server. Rows
                 * are not remounted while merely typing, because `count` only
                 * moves when the shape does.
                 */
                <div key={`${group.key}-${count}-${index}`} className="overflow-hidden border-b border-line-soft last:border-0">
                  <div className="flex items-center gap-2 bg-canvas/70 px-3 py-1">
                    <span className="grid size-4 place-items-center rounded-full bg-brand-950 text-[10px] font-bold text-accent tabular">
                      {index + 1}
                    </span>
                    <span className="text-[11px] font-semibold uppercase tracking-[.06em] text-ink-500">
                      {singular} {index + 1}
                    </span>
                    <span className="ml-auto">
                      {index > 0 && editable ? (
                        <IconButton
                          icon="trash"
                          tone="danger"
                          size={22}
                          title={`Remove ${singular.toLowerCase()} ${index + 1}`}
                          onClick={() => handleRemoveInstance(group, index)}
                        />
                      ) : index === 0 ? (
                        <span className="text-[10.5px] text-ink-400">Primary</span>
                      ) : null}
                    </span>
                  </div>
                  <div className={`${GRID_TRACKS} ${GRID_EDGE}`}>
                    {group.schema.map((member) => {
                      const memberField: ProtoField = {
                        id: member.key, label: member.label, type: member.type,
                        sensitive: member.sensitive, tab: '', columnIn: [],
                      };
                      return (
                        <div
                          key={`${index}-${member.key}`}
                          style={{ gridColumn: spanFor(memberField) }}
                          className="border-b border-r border-line-soft bg-white px-3 py-2 last:border-r-0"
                        >
                          <div className="flex min-h-[18px] items-center gap-1.5">
                            <span className="truncate text-[11px] font-semibold uppercase tracking-[.06em] text-ink-400">
                              {member.label}
                            </span>
                          </div>
                          <FieldRenderer
                            field={memberField}
                            value={instance[member.key] as FieldValue}
                            grant={editable ? 'edit' : 'view'}
                            moduleSlug={moduleSlug}
                            onChange={(v) => handleMemberChange(group, index, member.key, v)}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {atMax ? (
              <p className="px-3 py-1.5 text-[11px] text-ink-400">
                The sheet caps this at {group.max} {singular.toLowerCase()}s.
              </p>
            ) : null}
            {conflicts[group.key] ? (
              <p className="mx-3 mb-2 rounded border border-bad/25 bg-bad-bg px-1.5 py-1 text-[11px] text-bad">
                {conflicts[group.key]}
              </p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
