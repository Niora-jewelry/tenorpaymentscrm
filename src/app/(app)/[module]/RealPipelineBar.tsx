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
 * The steps are a PROCESS, and a process has a direction. A connector line runs
 * behind the chips and fills up to the current step, so progress is legible
 * before any label is read. Completed steps keep their own colour rather than
 * going grey — a finished stage is not a disabled one, and greying it makes a
 * record at step 6 of 7 look mostly switched off.
 *
 * ── AND IT TELLS YOU WHAT MOVING WILL DO ─────────────────────────────────
 * Every step change is activity-logged with actor and timestamp (Modules §2.4),
 * so this is not a toggle. Hovering an upcoming step says "Move here"; hovering
 * one already behind says "Move back". The chips are buttons and always were —
 * what was missing was any hint that clicking one is a recorded action.
 */
import { useTransition } from 'react';
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

  const setStep = (pipelineId: string, stepId: string) => {
    startTransition(async () => {
      await setPipelineStepAction(moduleSlug, recordId, moduleId, pipelineId, stepId);
      router.refresh();
    });
  };

  const clear = () => {
    startTransition(async () => {
      await clearPipelineAction(moduleSlug, recordId, moduleId);
      router.refresh();
    });
  };

  // A pipeline with no steps has nothing to assign — "Assign" puts the record
  // on the FIRST step, and there isn't one. `create_pipeline` (migration 37)
  // refuses to author that state, and this is the other half of the same rule:
  // one created by direct SQL, or one whose steps were removed the same way,
  // is skipped rather than rendering a button that throws when clicked.
  const assignable = pipelines.filter((p) => p.steps.length > 0);
  if (!assignable.length) return <div className="h-2" />;

  const pipeline = assignable.find((p) => p.id === assignment?.pipelineId);

  if (!assignment || !pipeline) {
    return (
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t border-line-soft py-2.5">
        <Icon name="route" size={13} className="text-ink-300" />
        <span className="text-[12px] text-ink-400">Not on a pipeline in this module.</span>
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

  /* How far the filled connector runs. Measured to the CENTRE of the current
     chip, which is why a single step sits at 0 rather than at 100 — a record on
     step 1 of 6 has not finished a sixth of anything. */
  const progress =
    pipeline.steps.length > 1 ? (index / (pipeline.steps.length - 1)) * 100 : 0;

  /* The fill takes the CURRENT step's colour, so the track and the chip the
     record is standing on agree. `index` is -1 only if the stored step was
     removed from under the record, which the writers refuse — the fallback
     keeps the bar rendering rather than throwing on a state that should not
     exist. */
  const currentSwatch = SWATCHES[pipeline.steps[Math.max(0, index)]?.swatch ?? 'slate'];

  return (
    <div className="border-t border-line-soft py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Icon name="route" size={13} className="text-ink-400" />
        <span className="text-[11px] font-semibold uppercase tracking-[.06em] text-ink-500">
          {pipeline.label}
        </span>

        {/* The position, as a fraction AND as the step's own name. "step 7 of 7"
            alone makes someone count along the bar to find out where that is. */}
        <span className="inline-flex items-center gap-1 rounded-full bg-canvas px-1.5 py-[1px] text-[11px] tabular text-ink-500 ring-1 ring-inset ring-line">
          {index + 1} / {pipeline.steps.length}
        </span>
        {atEnd ? (
          <span className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-[#1c7a4f]">
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
        overflow edge — the border did not disappear, it was cropped. The
        padding gives the lift somewhere to go.
      */}
      <div className="relative mt-2 overflow-x-auto px-0.5 pb-2 pt-1.5">
        <div className="relative flex min-w-max items-center gap-1.5">
          <span
            aria-hidden
            className="absolute left-3 right-3 top-1/2 h-[2px] -translate-y-1/2 rounded-full bg-line-soft"
          />
          <span
            aria-hidden
            className="absolute left-3 top-1/2 h-[2px] -translate-y-1/2 rounded-full transition-[width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
            style={{ width: `calc(${progress}% - 0.75rem)`, background: currentSwatch.dot }}
          />

          {pipeline.steps.map((step, i) => {
            const done = i < index;
            const current = i === index;
            const s = SWATCHES[step.swatch];
            return (
              <button
                key={step.id}
                type="button"
                disabled={pending}
                title={
                  current
                    ? 'This record is here now'
                    : i > index
                      ? `Move forward to "${step.label}"`
                      : `Move back to "${step.label}"`
                }
                onClick={() => setStep(pipeline.id, step.id)}
                className={`relative z-[1] flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-semibold transition-all duration-200 active:scale-95 disabled:cursor-wait ${
                  current
                    ? 'shadow-[0_1px_2px_rgba(8,32,47,.14)]'
                    : done
                      ? 'hover:-translate-y-px'
                      : 'border-line bg-white text-ink-400 hover:-translate-y-px hover:border-ink-300 hover:text-ink-700'
                }`}
                style={
                  current
                    ? { background: s.bg, color: s.text, borderColor: s.border }
                    : done
                      ? { background: '#fff', color: s.text, borderColor: s.border }
                      : undefined
                }
              >
                {done ? (
                  <Icon name="check" size={10} strokeWidth={2.6} style={{ color: s.dot }} />
                ) : (
                  <span
                    aria-hidden
                    className={`size-[6px] rounded-full ${current ? 'ring-2 ring-white/70' : ''}`}
                    style={{ background: current ? s.dot : '#c7d3dd' }}
                  />
                )}
                {step.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
