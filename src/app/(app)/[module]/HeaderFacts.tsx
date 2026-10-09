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
 * ── THE TOKEN IS WHY THIS CAN BE OPTIMISTIC ──────────────────────────────
 * The value paints before the round trip, and the record's `updatedAt`
 * advances to whatever the server returns, so a second edit carries a fresh
 * compare-and-swap token rather than the one this component already spent.
 * Without adopting it back, editing two header fields in a row would have the
 * second one lose to the first — the bug `recordVersion.ts` exists to prevent
 * for the field grid.
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
import { useState } from 'react';
import { FieldRenderer, HeaderValue } from '@/proto/ui/value';
import type { Field as ProtoField, FieldValue, Swatch } from '@/proto/schema';
import { setValueAction } from './actions';
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
}: {
  moduleSlug: string;
  recordId: string;
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
  const [token, setToken] = useState(updatedAt);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  /*
   * The server's token wins whenever a fresh render arrives — a revalidation
   * from anywhere else on the page would otherwise leave this component
   * holding a token it spent, and the next header edit would be refused as a
   * conflict it did not cause. Compared during render against a snapshot,
   * which is this codebase's idiom for state derived from props.
   */
  const [tokenSnapshot, setTokenSnapshot] = useState(updatedAt);
  if (tokenSnapshot !== updatedAt) {
    setTokenSnapshot(updatedAt);
    setToken(updatedAt);
    /* The fresh props already carry whatever we painted, so the overlay has
       nothing left to say and would only pin stale values on screen. */
    setValues({});
  }

  const commit = async (fact: HeaderFact, next: FieldValue) => {
    const previous = fact.id in values ? values[fact.id] : fact.value;
    setError(null);
    setSavingId(fact.id);
    setValues((v) => ({ ...v, [fact.id]: next }));

    const formData = new FormData();
    /* Same encoding the drawer and the dashboard use: objects and arrays as
       JSON, everything else as a string, and null as "" meaning clear it. */
    formData.set(
      'value',
      next == null ? '' : typeof next === 'object' ? JSON.stringify(next) : String(next),
    );
    formData.set('expectedUpdatedAt', token);

    try {
      const result = await setValueAction(moduleSlug, recordId, fact.field.id, formData);
      if (!result.ok) {
        setValues((v) => ({ ...v, [fact.id]: previous }));
        setError(result.message ?? 'Could not save that.');
        return;
      }
      setToken(result.updatedAt);
    } catch {
      setValues((v) => ({ ...v, [fact.id]: previous }));
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
          const value = fact.id in values ? values[fact.id] : fact.value;
          const empty =
            value == null
            || value === ''
            || (Array.isArray(value) && value.length === 0)
            || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);

          return (
            /* `min-w-0` on every cell is mandatory: without it `truncate`
               silently does nothing inside a grid track and one long value
               blows its whole column out. */
            <div key={fact.id} className="min-w-0">
              <dt className="block truncate text-[11px] leading-none text-ink-400" title={fact.label}>
                {fact.label}
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
