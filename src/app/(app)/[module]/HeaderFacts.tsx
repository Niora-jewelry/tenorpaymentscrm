'use client';

/**
 * Vital Info — the drawer header's field section, editable in place.
 *
 * UI spec §2: a titled section using the same 4-equal-column grid as every
 * tab, holding the fields an admin configured for it (Current Status, Risk
 * Level, Team member(s) assigned, Relationship manager, Pricing Model, MID,
 * MCC code), collapsed to one row until expanded (7.5).
 *
 * These were once read-only. They are the most-looked-at values on the record and
 * the only ones you had to go and find a tab for in order to change, which is
 * what the client asked about: "any column item should also be able to be
 * changed in the drawer".
 *
 * ── IT REUSES THE WRITE PATH, IT DOES NOT ADD ONE ────────────────────────
 * `setValueAction` already carries the whole permission chain (module → tab →
 * subtab → field), the compare-and-swap, the activity-log row and the
 * duplicate rules. The dashboard's inline cell edit goes through the same
 * action for the same reason, and its comment says it plainly: a second
 * server path for "the same edit, from a different screen" is a second place
 * for those to drift. There is no new action here and no new rule.
 *
 * ── THE TOKEN LIVES IN `recordVersion.ts`, NOT IN THIS COMPONENT ─────────
 * ⚠️ This held its own `useState` token, and that was a real bug a client
 * hit within minutes of being given the CRM.
 *
 * `set_record_value` compares and swaps on `records.updated_at` — ONE token
 * for the whole record, not one per field or per component. The field grid
 * keeps that token in a module-level store precisely so a remount cannot lose
 * it, and because `setValueAction` deliberately skips `revalidatePath` (a
 * ~1.9s cost on the most frequent interaction in the app) no fresh server
 * render ever corrects a stale one.
 *
 * A private token here therefore went stale the instant ANY other edit landed
 * on the record — one field typed in the grid below, and the next header edit
 * arrived with a token the row no longer had. The client saw
 *
 *     "Someone else changed this a moment ago — current value: (empty)"
 *
 * on a record nobody else had ever opened, and his MCC code was not saved.
 * Two independent token holders on one record cannot be made to agree; there
 * has to be one, so this now reads and writes the same store the grid does,
 * through the same queue.
 *
 * The queue matters as much as the token: it makes writes to one record
 * strictly sequential, so editing two header facts briskly cannot have both
 * capture the same token and the second lose.
 *
 * A refusal rolls the value back. Nothing stays on screen that the database
 * did not accept.
 *
 * ── A VIEW-ONLY FACT STILL RENDERS, AND STILL READS THE SAME ─────────────
 * The grant comes from the same chain the field grid uses, already capped by
 * module, tab and subtab. `edit` gets a control; `view` keeps exactly the
 * presentation it had. A `hidden` fact never reaches this component at all —
 * it is filtered server-side, because absent is not the same as disabled
 * (CLAUDE.md §3).
 */
import { type ReactNode, useCallback, useState, useSyncExternalStore } from 'react';
import { FieldRenderer } from '@/proto/ui/value';
import type { Field as ProtoField, FieldValue } from '@/proto/schema';
import { Icon } from '@/proto/ui/icons';
import { setValueAction } from './actions';
import { FieldMentionButton, FieldMentionNote, valueText } from './FieldMention';
import type { NotificationView } from '@/lib/records/notifications';
import {
  seedRecordVersion, currentToken, commitToken, isOwnToken, enqueueWrite,
  publishValue, publishedValue, subscribeToValues, valuesSnapshot,
} from './recordVersion';
import { FIELD_GRID, FIELD_GRID_CONTAINER, FIELD_VALUE_SLOT, FieldLabelRow, SectionHeading, fieldCardClass } from './FieldCard';

const VITAL_KEY = 'tapdash.vitalInfo.expanded';
const VITAL_EVENT = 'tapdash:vital-info';
/* Used only when storage throws, so the toggle still works for this page. */
let fallbackVital = false;

function readVital(): boolean {
  try {
    return window.localStorage.getItem(VITAL_KEY) === '1';
  } catch {
    return fallbackVital;
  }
}

function writeVital(next: boolean): void {
  try {
    window.localStorage.setItem(VITAL_KEY, next ? '1' : '0');
  } catch {
    /* storage unavailable — the event below still updates this page */
  }
  fallbackVital = next;
  window.dispatchEvent(new Event(VITAL_EVENT));
}

function subscribeVital(onChange: () => void): () => void {
  window.addEventListener(VITAL_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(VITAL_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

export type HeaderFact = {
  id: string;
  label: string;
  field: ProtoField;
  value: FieldValue;
  empty: boolean;
  /** Already capped by module → tab → subtab → field. Never 'hidden' here. */
  grant: 'view' | 'edit';
};

export function HeaderFacts({
  moduleSlug,
  recordId,
  updatedAt,
  facts,
  viewerId,
  viewerIsAdmin,
  visibilityFieldKey,
  teamSlot,
  mentionsByField = {},
  openMention = null,
  onMentionRead = () => undefined,
}: {
  moduleSlug: string;
  recordId: string;
  mentionsByField?: Record<string, NotificationView[]>;
  openMention?: NotificationView | null;
  onMentionRead?: (id: string) => void;
  /** The record's compare-and-swap token as the server last rendered it. */
  updatedAt: string;
  facts: HeaderFact[];
  viewerId: string;
  viewerIsAdmin: boolean;
  /**
   * Which field decides who can see the record — see `FieldRenderer`.
   *
   * Compared against the ADAPTED field's `id`, which is the field key: three
   * fields carry the `team_member` type and exactly one of them governs row
   * visibility. The field grid makes the identical comparison.
   */
  visibilityFieldKey: string;
  /** Team member(s) assigned, drawn by the drawer. */
  teamSlot?: ReactNode;
}) {
  /* Local overlay so an edit paints immediately, keyed by field id. */
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  /* Remembered per viewer, in this browser only — a convenience, never state
     anyone else depends on. The server snapshot is "collapsed", so the server
     render and the first client render agree. */
  const expanded = useSyncExternalStore(subscribeVital, readVital, () => false);
  const setExpanded = (next: boolean) => writeVital(next);


  /*
   * Register what the server just rendered. `seedRecordVersion` only ever
   * moves the token FORWARD, so calling it on every render is safe and is
   * how a real navigation, refresh, or somebody else's edit gets picked up —
   * while a token this page has already advanced past is left alone.
   *
   * The same call is made by the field grid. That is the point: one store,
   * one token, whichever of them rendered last.
   */
  seedRecordVersion(recordId, updatedAt);

  /*
   * ── THE SAME FIELD IS OFTEN ON SCREEN TWICE ─────────────────────────────
   * Pricing Model, Current Status, MID, MCC code and the rest are configured
   * into BOTH this strip and the field grid below it. Each used to hold its
   * own copy, so editing one left the other showing the old value — reported
   * as "pricing model not syncing with header field" — and nothing corrected
   * it, because `setValueAction` skips revalidation on purpose.
   *
   * Subscribing to the shared store makes the strip re-read whenever any
   * surface on this page writes a value for this record. The grid does the
   * same in the other direction.
   */
  const subscribe = useCallback(
    (onChange: () => void) => subscribeToValues(recordId, onChange),
    [recordId],
  );
  const snapshot = useCallback(() => valuesSnapshot(recordId), [recordId]);
  useSyncExternalStore(subscribe, snapshot, snapshot);

  /*
   * The overlay is dropped when a fresh server render arrives, because those
   * props already carry whatever we painted and keeping it would pin stale
   * values on screen. Compared during render against a snapshot, which is
   * this codebase's idiom for state derived from props.
   */
  const [tokenSnapshot, setTokenSnapshot] = useState(updatedAt);
  if (tokenSnapshot !== updatedAt) {
    setTokenSnapshot(updatedAt);
    setValues({});
  }

  const commit = async (fact: HeaderFact, next: FieldValue) => {
    const previous = fact.id in values ? values[fact.id] : fact.value;
    setError(null);
    setSavingId(fact.id);
    setValues((v) => ({ ...v, [fact.id]: next }));
    /* And tell the field grid below, which renders this same field. */
    publishValue(recordId, fact.field.id, next);

    /* Same encoding the drawer and the dashboard use: objects and arrays as
       JSON, everything else as a string, and null as "" meaning clear it. */
    const encoded =
      next == null ? '' : typeof next === 'object' ? JSON.stringify(next) : String(next);

    const send = async (withToken: string) => {
      const formData = new FormData();
      formData.set('value', encoded);
      formData.set('expectedUpdatedAt', withToken);
      return setValueAction(moduleSlug, recordId, fact.field.id, formData);
    };

    try {
      /*
       * Queued, and the token is read at the moment the write actually
       * STARTS rather than when it was scheduled — otherwise two header
       * edits made in quick succession both capture the pre-edit token and
       * the second loses a conflict it caused itself.
       */
      const result = await enqueueWrite(recordId, updatedAt, async () => {
        const first = await send(currentToken(recordId, updatedAt));
        /*
         * A conflict against a token WE produced is bookkeeping, not a real
         * disagreement: nobody else touched the record, this component was
         * simply behind. Retried once against the row's current token. A
         * conflict against a token we have never seen is a genuine outside
         * edit and is reported, which is what §13.4 requires.
         */
        const lost = !first.ok ? first.conflict?.currentUpdatedAt : undefined;
        if (lost && isOwnToken(recordId, lost)) {
          commitToken(recordId, lost);
          return send(lost);
        }
        return first;
      });

      if (!result.ok) {
        setValues((v) => ({ ...v, [fact.id]: previous }));
        publishValue(recordId, fact.field.id, previous);
        setError(result.message ?? 'Could not save that.');
        return;
      }
      commitToken(recordId, result.updatedAt);
    } catch {
      setValues((v) => ({ ...v, [fact.id]: previous }));
      publishValue(recordId, fact.field.id, previous);
      setError('Could not save. Nothing was changed.');
    } finally {
      setSavingId(null);
    }
  };

  if (facts.length === 0) return null;

  /*
   * ── ONE ROW UNTIL ASKED (UI spec 7.5, approved) ─────────────────────────
   * Collapsed, Vital Info shows exactly one row of the grid — four boxes on a
   * wide drawer, two on a narrower one, one on a phone. The column count is
   * decided by container width, so "the first row" is decided the same way:
   * each box past the first row of the CURRENT layout is `display:none`,
   * which also takes it out of the tab order instead of hiding it visually
   * while a keyboard can still land in it.
   */
  const hiddenWhenCollapsed = (i: number): string =>
    expanded ? '' : i >= 4 ? 'hidden' : i >= 2 ? '@max-[50rem]:hidden' : i === 1 ? '@max-[30rem]:hidden' : '';
  /* The toggle exists only when something is actually folded away at this
     width — same three thresholds. */
  const toggleClass =
    facts.length > 4 ? '' : facts.length > 2 ? '@[50rem]:hidden' : facts.length === 2 ? '@[30rem]:hidden' : 'hidden';

  return (
    <section aria-labelledby={`vital-${recordId}`} className={`mt-4 ${FIELD_GRID_CONTAINER}`}>
      <SectionHeading label="Vital Info">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`vital-grid-${recordId}`}
          onClick={() => setExpanded(!expanded)}
          className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold text-brand-700 transition-colors hover:bg-brand-50 ${toggleClass}`}
        >
          {expanded ? 'Show less' : `Show all ${facts.length}`}
          <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={12} />
        </button>
      </SectionHeading>
      <span id={`vital-${recordId}`} className="sr-only">Vital Info</span>
      {error ? (
        <p role="alert" className="mb-2 text-[11.5px] text-danger">
          {error}
        </p>
      ) : null}
      <div id={`vital-grid-${recordId}`} className={FIELD_GRID}>
        {facts.map((fact, i) => {
          /* Our own in-flight edit wins, then anything the field grid (or
             any other surface) published for this record, then the value the
             server rendered. */
          /*
             ⚠️ KEYED BY `fact.field.id`, THE FIELD KEY — NOT `fact.id`.

             `fact.id` is the field's database UUID; `fact.field.id` is its
             KEY, which is what the adapter uses as the identity everywhere
             the client works (`adapter.ts`: "the prototype's own identity").
             The field grid publishes under the key, and `setValueAction` is
             called with the key. Reading by UUID once left the two surfaces
             writing to different entries of the same store — changing Pricing
             Model here and watching the grid keep the old value found it.
           */
          const shared = publishedValue(recordId, fact.field.id);
          const value = fact.id in values
            ? values[fact.id]
            : shared.has
              ? (shared.value as FieldValue)
              : fact.value;

          return (
            <div
              key={fact.id}
              className={`${fieldCardClass({})} ${hiddenWhenCollapsed(i)} ${savingId === fact.id ? 'opacity-70' : ''}`}
            >
              <FieldLabelRow field={fact.field}>
                <FieldMentionNote mentions={mentionsByField[fact.field.id] ?? []} autoOpen={openMention?.fieldKey === fact.field.id ? openMention : null} onRead={onMentionRead} />
                <FieldMentionButton recordId={recordId} fieldKey={fact.field.id} fieldLabel={fact.label} currentValue={valueText(value)} />
              </FieldLabelRow>
              {/* The same control the tab uses — "same behavior as on the
                  tab" (UI spec §2). A view-only grant renders it read-only,
                  exactly as the tab would. */}
              <div className={FIELD_VALUE_SLOT}>
                <FieldRenderer
                  field={fact.field}
                  value={value}
                  grant={fact.grant}
                  moduleSlug={moduleSlug}
                  card
                  grantsVisibility={fact.field.id === visibilityFieldKey}
                  teamSlot={fact.field.id === visibilityFieldKey ? teamSlot : undefined}
                  viewerId={viewerId}
                  viewerIsAdmin={viewerIsAdmin}
                  onChange={(next) => void commit(fact, next)}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
