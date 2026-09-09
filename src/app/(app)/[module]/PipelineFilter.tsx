'use client';

/**
 * The dashboard's pipeline filter.
 *
 * ── WHAT THE CLIENT ASKED FOR ────────────────────────────────────────────
 * Admin Plan §3.6 and Modules §2: "module dashboards can be filtered by
 * pipeline, and by step via the synced Status field's standard column filter."
 *
 * ── HOW BOTH HALVES ARE THE SAME MECHANISM ───────────────────────────────
 * Migration 57 gives every pipeline a Status field whose stored value IS the
 * step id and whose options ARE the steps. So:
 *
 *   filter by PIPELINE  →  that field has any value at all   (`present`)
 *   filter by STEP      →  that field is one of these values (`values`)
 *
 * Both are ordinary filters on an ordinary field, saved and restored by the
 * same per-user machinery every column filter uses ("active filters persist per
 * user and are restored when the user returns to the module"), and both are
 * applied by the database rather than to the page of rows already fetched.
 *
 * The step half is also reachable exactly as the client described it — an admin
 * who adds the synced Status field as a dashboard column gets its standard
 * column filter. This control exists so the filter is there without that step,
 * and so choosing a pipeline is one action rather than "know which of these
 * columns belongs to which pipeline".
 *
 * ── ONE PIPELINE AT A TIME ───────────────────────────────────────────────
 * A record holds at most one pipeline per module (Admin §3.6), so two pipeline
 * filters at once can only ever return nothing. Selecting a pipeline therefore
 * clears every other pipeline's filter rather than adding to it — the
 * alternative is a control that offers a combination guaranteed to show an
 * empty table.
 */
import { Popover, StatusPill } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import type { Filter, Swatch } from '@/proto/schema';

export type PipelineFilterOption = {
  id: string;
  label: string;
  /** The synced Status field's key — the `fieldId` a filter is saved under.
   * Filters are keyed by the ADAPTED field id, which is the field's `key`
   * rather than its uuid (`adapter.ts`), and this must match or the saved
   * filter never resolves back to its field. */
  statusFieldKey: string;
  steps: { id: string; label: string; swatch: Swatch }[];
};

export function PipelineFilter({
  pipelines,
  filters,
  onSetFilters,
}: {
  pipelines: PipelineFilterOption[];
  filters: Record<string, Filter>;
  onSetFilters: (next: Record<string, Filter>) => void;
}) {
  if (!pipelines.length) return null;

  const active = pipelines.find((p) => filters[p.statusFieldKey]);
  const activeFilter = active ? filters[active.statusFieldKey] : undefined;
  const activeSteps =
    activeFilter && activeFilter.kind === 'values' ? activeFilter.values : [];

  /** Drop every pipeline filter, then apply whatever this change asks for. */
  const apply = (mutate: (next: Record<string, Filter>) => void) => {
    const next = { ...filters };
    for (const p of pipelines) delete next[p.statusFieldKey];
    mutate(next);
    onSetFilters(next);
  };

  const choosePipeline = (p: PipelineFilterOption | null) => {
    apply((next) => {
      if (p) next[p.statusFieldKey] = { fieldId: p.statusFieldKey, kind: 'present' };
    });
  };

  const toggleStep = (p: PipelineFilterOption, stepId: string) => {
    const current = active?.id === p.id ? activeSteps : [];
    const values = current.includes(stepId)
      ? current.filter((v) => v !== stepId)
      : [...current, stepId];
    apply((next) => {
      // No step selected means "anywhere on this pipeline", which is the
      // `present` filter — not an empty `values` list, which would read as
      // "match nothing" to anyone looking at the saved filter later.
      next[p.statusFieldKey] = values.length
        ? { fieldId: p.statusFieldKey, kind: 'values', values }
        : { fieldId: p.statusFieldKey, kind: 'present' };
    });
  };

  const summary = !active
    ? 'Any pipeline'
    : activeSteps.length
      ? `${active.label} · ${activeSteps.length} step${activeSteps.length === 1 ? '' : 's'}`
      : active.label;

  return (
    <Popover
      width={280}
      trigger={(open) => (
        <span
          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12.5px] font-semibold transition-colors ${
            active
              ? 'border-brand-100 bg-brand-50 text-brand-700'
              : 'border-line bg-white text-ink-600 hover:bg-canvas'
          } ${open ? 'ring-2 ring-brand-100' : ''}`}
        >
          <Icon name="shuffle" size={13} />
          <span className="max-w-[220px] truncate">{summary}</span>
          <Icon name="chevron-down" size={12} className="opacity-60" />
        </span>
      )}
    >
      {() => (
        <div className="max-h-[60vh] overflow-auto">
          <button
            type="button"
            onClick={() => choosePipeline(null)}
            className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-canvas ${
              active ? 'text-ink-600' : 'font-semibold text-brand-700'
            }`}
          >
            <span className="grid size-4 place-items-center">
              {active ? null : <Icon name="check" size={12} />}
            </span>
            Any pipeline
          </button>

          {pipelines.map((p) => (
            <div key={p.id} className="mt-1">
              <button
                type="button"
                onClick={() => choosePipeline(active?.id === p.id ? null : p)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-canvas ${
                  active?.id === p.id ? 'font-semibold text-brand-700' : 'text-ink-700'
                }`}
              >
                <span className="grid size-4 place-items-center">
                  {active?.id === p.id ? <Icon name="check" size={12} /> : null}
                </span>
                <span className="truncate">{p.label}</span>
              </button>

              {/* Steps appear only under the chosen pipeline: a record holds one
                  pipeline per module, so another pipeline's steps are not a
                  narrowing of this filter, they are a different one. */}
              {active?.id === p.id ? (
                <div className="mb-1 ml-6 mt-0.5 space-y-0.5 border-l border-line-soft pl-2">
                  {p.steps.map((s) => (
                    <label
                      key={s.id}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-canvas"
                    >
                      <input
                        type="checkbox"
                        checked={activeSteps.includes(s.id)}
                        onChange={() => toggleStep(p, s.id)}
                        className="size-3.5 accent-[var(--brand-600,#0d6f8a)]"
                      />
                      <StatusPill label={s.label} swatch={s.swatch} />
                    </label>
                  ))}
                  {p.steps.length ? (
                    <p className="px-1.5 pb-0.5 pt-1 text-[11px] text-ink-400">
                      No step ticked shows every record on this pipeline.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </Popover>
  );
}
