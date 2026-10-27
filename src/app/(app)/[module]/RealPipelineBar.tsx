'use client';

/**
 * The pipeline step bar — same design as `src/proto/ui/Drawer.tsx`'s
 * `PipelineBar` (the swatch-colored step chips, done/current/upcoming
 * states, "step N of M") reused faithfully, wired to the real
 * `set_pipeline_step`/`clear_pipeline` server actions instead of the
 * in-memory store. "Independent per module" still holds for real: this
 * reads/writes `record_pipelines` keyed on `(record_id, module_id)`.
 *
 * ── IT READS AS ONE TRACK, NOT A ROW OF PILLS ────────────────────────────
 * The steps are a PROCESS, and a process has a direction. Short connectors sit
 * BETWEEN the chips and fill in behind the record's position, so progress is
 * legible before any label is read.
 *
 * ⚠️ The connectors are real flex items, not one absolutely-positioned line.
 * That line was sized with a percentage of its container — and the container is
 * a flex row that stretches to the full width of the drawer while the chips
 * only occupy the left of it. So the "progress" fill was measured against the
 * wrong thing and painted a stray orange segment out past the last chip. A
 * segment between each pair of chips needs no measurement at all and cannot
 * drift.
 *
 * ── ONE STEP IS OBVIOUSLY THE CURRENT ONE ────────────────────────────────
 * An earlier pass let completed steps keep their own swatch colour, on the
 * reasoning that a finished stage is not a disabled one. In practice four
 * coloured chips in a row left nothing to tell you which one the record is
 * actually standing on. Done steps are now quiet — a muted tick and grey text —
 * and the whole of the colour budget goes to the current chip, which is filled,
 * ringed and slightly raised. The header names it in words as well, because a
 * fraction alone ("5 / 7") still makes you count along the bar.
 *
 * ── AND IT TELLS YOU WHAT MOVING WILL DO ─────────────────────────────────
 * Every step change is activity-logged with actor and timestamp (Modules §2.4),
 * so this is not a toggle. Hovering an upcoming step says "Move here"; hovering
 * one already behind says "Move back". The chips are buttons and always were —
 * what was missing was any hint that clicking one is a recorded action.
 */
import { Fragment, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { SWATCHES } from '@/proto/ui/tokens';
import { setPipelineStepAction, clearPipelineAction } from './actions';

type Step = { id: string; label: string; swatch: keyof typeof SWATCHES };
type Pipeline = { id: string; label: string; steps: Step[] };

export function RealPipelineBar({
  moduleSlug,
  moduleId,
  recordId,
  pipelines,
  assignment,
}: {
  moduleSlug: string;
  moduleId: string;
  recordId: string;
  pipelines: Pipeline[];
  assignment: { pipelineId: string; stepId: string } | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  /*
   * Moving a record's stage is a real state change, and these actions return
   * void and throw on refusal. Unguarded, a denied move skipped
   * `router.refresh()` and the bar simply did not budge — the classic "the
   * button does nothing", with nothing to click next except the same button.
   */
  const [error, setError] = useState<string | null>(null);

  const setStep = (pipelineId: string, stepId: string) => {
    startTransition(async () => {
      try {
        setError(null);
        await setPipelineStepAction(moduleSlug, recordId, moduleId, pipelineId, stepId);
        router.refresh();
      } catch {
        setError('Could not move this record.');
      }
    });
  };

  const clear = () => {
    startTransition(async () => {
      try {
        setError(null);
        await clearPipelineAction(moduleSlug, recordId, moduleId);
        router.refresh();
      } catch {
        setError('Could not take this record off the pipeline.');
      }
    });
  };

  // A pipeline with no steps has nothing to assign — "Assign" puts the record
  // on the FIRST step, and there isn't one. `create_pipeline` (migration 37)
  // refuses to author that state, and this is the other half of the same rule:
  // one created by direct SQL, or one whose steps were removed the same way,
  // is skipped rather than rendering a button that throws when clicked.
  const assignable = pipelines.filter((p) => p.steps.length > 0);
  if (!assignable.length) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-ink-400">
        <Icon name="route" size={13} className="text-ink-300" />
        No pipeline in this module.
      </div>
    );
  }

  const pipeline = assignable.find((p) => p.id === assignment?.pipelineId);

  if (!assignment || !pipeline) {
    return (
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <Icon name="route" size={13} className="text-ink-300" />
        <span className="text-[12px] text-ink-400">Not on a pipeline in this module.</span>
        {error ? <span role="alert" className="text-[11.5px] text-danger">{error}</span> : null}
        {assignable.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={pending}
            title={`Put this record on the first step of ${p.label}`}
            onClick={() => setStep(p.id, p.steps[0]!.id)}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-line px-2.5 py-1 text-[11.5px] font-semibold text-brand-700 transition-colors hover:border-brand-200 hover:bg-brand-50 disabled:cursor-wait disabled:opacity-60"
          >
            <Icon name="plus" size={11} strokeWidth={2.4} />
            {p.label}
          </button>
        ))}
      </div>
    );
  }

  const index = pipeline.steps.findIndex((s) => s.id === assignment.stepId);
  const atEnd = index === pipeline.steps.length - 1;

  /* The fill takes the CURRENT step's colour, so the track and the chip the
     record is standing on agree. `index` is -1 only if the stored step was
     removed from under the record, which the writers refuse — the fallback
     keeps the bar rendering rather than throwing on a state that should not
     exist. */
  const currentSwatch = SWATCHES[pipeline.steps[Math.max(0, index)]?.swatch ?? 'slate'];

  return (
    <div>
      {error ? (
        <p role="alert" className="mb-1.5 text-[11.5px] text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Icon name="route" size={13} className="text-ink-400" />
        {/*
          ── MOVING A RECORD BETWEEN PIPELINES ────────────────────────────
          The bar could move a record along its pipeline and take it off one
          entirely, but never move it to a DIFFERENT one — so changing
          pipeline meant Remove, then find the right button, then re-assign,
          losing the record's place in between.

          `set_pipeline_step` already supported it the whole time: it upserts
          `on conflict (record_id, module_id) do update set pipeline_id =
          excluded.pipeline_id`. Only the UI never asked. So this is a
          control, not a new capability, and the module scoping is unchanged —
          the RPC still refuses a pipeline that does not belong to this
          module, which is what keeps a record off the Lead pipeline inside
          Deals.

          Rendered as a select only when there is somewhere to go; with one
          pipeline it stays the plain label it was.
        */}
        {assignable.length > 1 ? (
          <label className="inline-flex items-center">
            <span className="sr-only">Pipeline for this record in this module</span>
            <select
              value={pipeline.id}
              disabled={pending}
              title="Move this record to another pipeline — it starts at that pipeline's first step"
              onChange={(e) => {
                const next = assignable.find((p) => p.id === e.target.value);
                if (next && next.id !== pipeline.id) setStep(next.id, next.steps[0]!.id);
              }}
              className="cursor-pointer rounded border border-transparent bg-transparent py-0 pl-0 pr-4 text-[11px] font-semibold uppercase tracking-[.06em] text-ink-500 outline-none transition-colors hover:text-ink-900 focus-field disabled:cursor-wait disabled:opacity-60"
            >
              {assignable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="text-[11px] font-semibold uppercase tracking-[.06em] text-ink-500">
            {pipeline.label}
          </span>
        )}

        <span aria-hidden className="text-line">·</span>

        {/* The current step BY NAME, in its own colour, before the fraction.
            This is the answer to "where is this record", and it was previously
            only obtainable by finding the one filled chip among seven. */}
        <span
          className="inline-flex items-center gap-1.5 text-[12px] font-semibold"
          style={{ color: currentSwatch.text }}
        >
          <span aria-hidden className="size-[6px] rounded-full" style={{ background: currentSwatch.dot }} />
          {pipeline.steps[Math.max(0, index)]?.label}
        </span>

        <span className="inline-flex items-center rounded-full bg-canvas px-1.5 py-[1px] text-[11px] tabular text-ink-400 ring-1 ring-inset ring-line">
          {index + 1} of {pipeline.steps.length}
        </span>
        {atEnd ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-ok">
            <Icon name="check" size={11} strokeWidth={2.5} />
            Final step
          </span>
        ) : null}

        <span className="ml-auto flex items-center gap-2.5">
          <span className="hidden text-[11px] text-ink-400 sm:inline">Independent per module</span>
          <button
            type="button"
            disabled={pending}
            onClick={clear}
            className="text-[11px] text-ink-400 transition-colors hover:text-[#b02a30] hover:underline disabled:cursor-wait disabled:opacity-60"
          >
            Remove
          </button>
        </span>
      </div>

      {/*
        The track. `pb-1.5` leaves room for the chips' own shadow, and the
        connector is drawn as a single absolutely-positioned line behind them
        rather than as a border on each chip — a per-chip border cannot span the
        gaps, which is what made the old row read as separate pills.
      */}
      {/*
        ⚠️ `pt-1.5` is not spacing, it is CLIPPING ROOM.

        `overflow-x-auto` cannot clip on one axis alone: the moment either axis
        is not `visible`, the other computes to `auto` too. So a chip lifting one
        pixel on hover had its top border sliced off by this container's own
        overflow edge — the border did not disappear, it was cropped.
      */}
      <div className="overflow-x-auto px-0.5 pb-2 pt-1.5">
        <div className="flex w-max items-center">
          {pipeline.steps.map((step, i) => {
            const done = i < index;
            const current = i === index;
            const sw = SWATCHES[step.swatch];
            return (
              <Fragment key={step.id}>
                {/* The connector into this chip. Filled when the record has
                    already passed the join, so the filled run always ends at
                    the chip it is standing on. */}
                {i > 0 ? (
                  <span
                    aria-hidden
                    className={`h-[2px] w-3.5 shrink-0 transition-colors duration-300 ${
                      i <= index ? '' : 'bg-line-soft'
                    }`}
                    style={i <= index ? { background: currentSwatch.dot } : undefined}
                  />
                ) : null}

                <button
                  type="button"
                  disabled={pending}
                  aria-current={current ? 'step' : undefined}
                  title={
                    current
                      ? 'This record is here now'
                      : i > index
                        ? `Move forward to "${step.label}"`
                        : `Move back to "${step.label}"`
                  }
                  onClick={() => setStep(pipeline.id, step.id)}
                  className={`relative flex shrink-0 items-center gap-1.5 rounded-full border transition-all duration-200 active:scale-95 disabled:cursor-wait ${
                    current
                      ? 'px-3 py-[5px] text-[12px] font-semibold shadow-[0_2px_6px_-1px_rgba(8,32,47,.22)]'
                      : done
                        ? 'border-line bg-white px-2.5 py-1 text-[11.5px] font-medium text-ink-400 hover:-translate-y-px hover:border-ink-300 hover:text-ink-700'
                        : 'border-dashed border-line bg-white px-2.5 py-1 text-[11.5px] font-medium text-ink-300 hover:-translate-y-px hover:border-solid hover:border-ink-300 hover:text-ink-700'
                  }`}
                  style={
                    current
                      ? { background: sw.bg, color: sw.text, borderColor: sw.dot }
                      : undefined
                  }
                >
                  {done ? (
                    <Icon name="check" size={10} strokeWidth={2.6} className="text-ink-300" />
                  ) : (
                    <span
                      aria-hidden
                      className={`rounded-full ${current ? 'size-[7px] ring-2 ring-white/60' : 'size-[5px]'}`}
                      style={{ background: current ? sw.dot : '#cfdae3' }}
                    />
                  )}
                  {step.label}
                </button>
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
