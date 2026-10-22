'use client';

/**
 * The drawer's header strip, editable in place.
 *
 * These are the fields an admin put in the module's header strip — Current
 * Status, Team member(s) assigned, Relationship manager, MID, MCC code — and
 * they were read-only. They are the most-looked-at values on the record and
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
import { useCallback, useState, useSyncExternalStore } from 'react';
import { FieldRenderer, HeaderValue } from '@/proto/ui/value';
import type { Field as ProtoField, FieldValue, Swatch } from '@/proto/schema';
import { setValueAction } from './actions';
import { FieldMentionButton, FieldMentionNote, valueText } from './FieldMention';
import type { NotificationView } from '@/lib/records/notifications';
import {
  seedRecordVersion, currentToken, commitToken, isOwnToken, enqueueWrite,
  publishValue, publishedValue, subscribeToValues, valuesSnapshot,
} from './recordVersion';
import { SWATCHES } from '@/proto/ui/tokens';

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
  pipeline,
  viewerId,
  viewerIsAdmin,
  visibilityFieldKey,
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
  /**
   * Where the record stands on this module's pipeline, or null.
   *
   * Not a field, and deliberately not dressed as one — a pipeline assignment
   * lives at (record, module) in `record_pipelines`, not in `record.values`,
   * so it has no field grant and no `setValueAction` path to save through.
   * It is shown here because it answers the same kind of question as the
   * facts beside it, and changed on the pipeline bar below, where the whole
   * step track is visible to move along.
   */
  pipeline?: { pipelineLabel: string; stepLabel: string; swatch: Swatch } | null;
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
}) {
  /* Local overlay so an edit paints immediately, keyed by field id. */
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

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

  if (facts.length === 0 && !pipeline) return null;

  return (
    <>
      {error ? (
        <p role="alert" className="mt-3 text-[11.5px] text-danger">
          {error}
        </p>
      ) : null}
      {/*
        ⚠️ The fixed `min-h` on the value row is load-bearing, not padding.
        A cell holding a StatusPill and one holding plain text are then the
        same height, so rows stay aligned and nothing jitters as records
        change.
      */}
      <dl className="mt-4 grid gap-x-6 gap-y-3.5 border-t border-line-soft pt-3.5 [grid-template-columns:repeat(auto-fill,minmax(168px,1fr))]">
        {pipeline ? (
          <div className="min-w-0">
            <dt className="block truncate text-[11px] leading-none text-ink-400" title={pipeline.pipelineLabel}>
              {pipeline.pipelineLabel}
            </dt>
            <dd className="mt-1.5 flex min-h-[22px] min-w-0 items-center gap-1.5 truncate text-[13.5px] font-medium">
              <span
                aria-hidden
                className="size-[6px] shrink-0 rounded-full"
                style={{ background: SWATCHES[pipeline.swatch].dot }}
              />
              <span className="truncate" style={{ color: SWATCHES[pipeline.swatch].text }}>
                {pipeline.stepLabel}
              </span>
            </dd>
          </div>
        ) : null}
        {facts.map((fact) => {
          /* Our own in-flight edit wins, then anything the field grid (or
             any other surface) published for this record, then the value the
             server rendered. */
          /*
             ⚠️ KEYED BY `fact.field.id`, THE FIELD KEY — NOT `fact.id`.

             `fact.id` is the field's database UUID; `fact.field.id` is its
             KEY, which is what the adapter uses as the identity everywhere
             the client works (`adapter.ts`: "the prototype's own identity").
             The field grid publishes under the key, and `setValueAction` on
             line 178 is already called with the key.

             This read, and the three publishes above, used the UUID. So the
             two surfaces wrote to and read from different entries of the same
             store and never saw each other — the sync was wired, connected to
             nothing, and passed its own unit test because that test used one
             key consistently. It took changing Pricing Model in the header and
             watching the grid keep the old value to find it.
           */
          const shared = publishedValue(recordId, fact.field.id);
          const value = fact.id in values
            ? values[fact.id]
            : shared.has
              ? (shared.value as FieldValue)
              : fact.value;
          const empty =
            value == null
            || value === ''
            || (Array.isArray(value) && value.length === 0)
            || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);

          return (
            /* `min-w-0` on every cell is mandatory: without it `truncate`
               silently does nothing inside a grid track and one long value
               blows its whole column out. */
            <div
              key={fact.id}
              className="min-w-0"
              /*
                A team-member list takes two tracks, as it does in the field
                grid below. In one 168px track its chips stacked vertically —
                three people plus "Edit team" made the first row of the strip
                three times taller than the rest and pushed MID, MCC code and
                the affiliate name onto a second row with empty columns beside
                them. With two tracks the chips sit side by side.
              */
              style={fact.field.type === 'team_member' ? { gridColumn: 'span 2' } : undefined}
            >
              <dt className="group/cell flex items-center gap-1 text-[11px] leading-none text-ink-400" title={fact.label}>
                <span className="truncate">{fact.label}</span>
                <FieldMentionNote mentions={mentionsByField[fact.field.id] ?? []} autoOpen={openMention?.fieldKey === fact.field.id ? openMention : null} onRead={onMentionRead} />
                <FieldMentionButton recordId={recordId} fieldKey={fact.field.id} fieldLabel={fact.label} currentValue={valueText(value)} />
              </dt>
              {/*
                ⚠️ `min-w-0` ON THE CHILD, NOT JUST ON THE CELL.
                
                A flex item will not shrink below its own content width unless
                it is told to, and `min-w-0` here only applied to the <dd>. Its
                child — the team-member picker, which lays its chips out in a
                flex row of its own — kept its intrinsic width and ran straight
                out of a 168px grid track into the next column. Reported as
                Relationship manager overlapping MID, and it would have done it
                to any long value, not just that one.
                
                `overflow-hidden` is the backstop for a control that cannot
                wrap at all; the picker itself wraps once it is given a width
                to wrap inside.
              */}
              <dd
                className={`mt-1.5 flex min-h-[22px] min-w-0 items-center overflow-hidden text-[13.5px] font-medium text-ink-900 ${
                  savingId === fact.id ? 'opacity-60' : ''
                }`}
              >
                {fact.grant === 'edit' ? (
                  <span className="w-full min-w-0">
                  <FieldRenderer
                    field={fact.field}
                    value={value}
                    grant="edit"
                    moduleSlug={moduleSlug}
                    grantsVisibility={fact.field.id === visibilityFieldKey}
                    viewerId={viewerId}
                    viewerIsAdmin={viewerIsAdmin}
                    onChange={(next) => void commit(fact, next)}
                  />
                  </span>
                ) : empty ? (
                  /* Lighter than its own label, so it reads as "nothing here"
                     and does not attract the eye. The label still shows:
                     "this module tracks MCC code and this record has not got
                     one" is information. */
                  <span className="truncate text-ink-300">&mdash;</span>
                ) : (
                  <span className="truncate">
                    <HeaderValue field={fact.field} value={value} moduleSlug={moduleSlug} />
                  </span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </>
  );
}
