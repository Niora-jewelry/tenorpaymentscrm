'use client';

/**
 * The pipeline step bar — same design as `src/proto/ui/Drawer.tsx`'s
 * `PipelineBar` (the swatch-colored step chips, done/current/upcoming
 * states, "step N of M") reused faithfully, wired to the real
 * `set_pipeline_step`/`clear_pipeline` server actions instead of the
 * in-memory store. "Independent per module" still holds for real: this
 * reads/writes `record_pipelines` keyed on `(record_id, module_id)`.
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
      <div className="flex flex-wrap items-center gap-2 border-t border-line-soft py-2">
        <Icon name="route" size={13} className="text-ink-400" />
        <span className="text-[12px] text-ink-400">No pipeline on this record in this module.</span>
        {assignable.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={pending}
            onClick={() => setStep(p.id, p.steps[0]!.id)}
            className="text-[12px] font-semibold text-brand-700 hover:underline disabled:cursor-wait disabled:opacity-60"
          >
            Assign &ldquo;{p.label}&rdquo;
          </button>
        ))}
      </div>
    );
  }

  const index = pipeline.steps.findIndex((s) => s.id === assignment.stepId);

  return (
    <div className="border-t border-line-soft py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="route" size={13} className="text-ink-400" />
        <span className="text-[11px] font-semibold uppercase tracking-[.06em] text-ink-400">{pipeline.label}</span>
        <span className="text-[11.5px] text-ink-400 tabular">
          step {index + 1} of {pipeline.steps.length}
        </span>
        <button
          type="button"
          disabled={pending}
          onClick={clear}
          className="text-[11px] text-ink-400 transition-colors hover:text-brand-700 hover:underline disabled:cursor-wait disabled:opacity-60"
        >
          Remove
        </button>
        <span className="ml-auto text-[11px] text-ink-400">Independent per module</span>
      </div>

      <div className="mt-1.5 flex items-center gap-1 overflow-x-auto pb-1">
        {pipeline.steps.map((step, i) => {
          const done = i < index;
          const current = i === index;
          const s = SWATCHES[step.swatch];
          return (
            <button
              key={step.id}
              type="button"
              disabled={pending}
              onClick={() => setStep(pipeline.id, step.id)}
              className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-[3px] text-[11.5px] font-semibold transition-all duration-200 active:scale-95 disabled:cursor-wait ${
                current
                  ? ''
                  : done
                    ? 'border-line bg-white text-ink-500 hover:border-ink-400'
                    : 'border-line bg-white text-ink-400/70 hover:border-ink-400 hover:text-ink-700'
              }`}
              style={current ? { background: s.bg, color: s.text, borderColor: s.border } : undefined}
            >
              {done ? (
                <Icon name="check" size={10} strokeWidth={2.5} style={{ color: s.dot }} />
              ) : (
                <span aria-hidden className="size-[5px] rounded-full" style={{ background: current ? s.dot : '#c7d3dd' }} />
              )}
              {step.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
