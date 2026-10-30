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
import { Dialog } from '@/proto/ui/kit';
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
  canMove = true,
  canChange = false,
}: {
  moduleSlug: string;
  moduleId: string;
  recordId: string;
  pipelines: Pipeline[];
  assignment: { pipelineId: string; stepId: string } | null;
  /** "Move records through pipeline stages" (Permissions spec). Without it
   *  the bar shows where the record is and offers nothing to click. */
  canMove?: boolean;
  /** "Change pipeline in drawer" (spec, 29 Oct 2026): Change pipeline and
   *  Remove. Without it the bar shows neither. */
  canChange?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [changing, setChanging] = useState(false);
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
            disabled={pending || !canMove}
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
        <span className="text-[11px] font-semibold uppercase tracking-[.06em] text-ink-500">
          {pipeline.label}
        </span>

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
          {/*
            ── CHANGE PIPELINE IN DRAWER (spec, 29 Oct 2026) ─────────────
            "A 'Change pipeline' option sits on the pipeline bar, next to the
            existing Remove link." Pick the new pipeline, then its starting
            stage, confirm — one step, no Remove first. Only in this module:
            `set_pipeline_step` keys on (record, module) and refuses a pipeline
            from another module. Both links need "Change pipeline in drawer".
          */}
          {canChange && assignable.some((p) => p.id !== pipeline.id) ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => setChanging(true)}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand-700 transition-colors hover:underline disabled:cursor-wait disabled:opacity-60"
            >
              <Icon name="shuffle" size={11} /> Change pipeline
            </button>
          ) : null}
          {canChange ? (
            <button
              type="button"
              disabled={pending}
              onClick={clear}
              className="text-[11px] text-ink-400 transition-colors hover:text-[#b02a30] hover:underline disabled:cursor-wait disabled:opacity-60"
            >
              Remove
            </button>
          ) : null}
        </span>
      </div>

      {changing ? (
        <ChangePipelineDialog
          current={pipeline}
          currentStep={pipeline.steps[Math.max(0, index)]?.label ?? ''}
          options={assignable.filter((p) => p.id !== pipeline.id)}
          onClose={() => setChanging(false)}
          onConfirm={(pipelineId, stepId) => {
            setChanging(false);
            setStep(pipelineId, stepId);
          }}
        />
      ) : null}

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
                  disabled={pending || !canMove}
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

/**
 * The pick: a different pipeline, then the stage it starts on, then a
 * confirmation that names the old pipeline, the new one and the stage.
 */
function ChangePipelineDialog({
  current,
  currentStep,
  options,
  onClose,
  onConfirm,
}: {
  current: Pipeline;
  currentStep: string;
  options: Pipeline[];
  onClose: () => void;
  onConfirm: (pipelineId: string, stepId: string) => void;
}) {
  const [pipelineId, setPipelineId] = useState(options.length === 1 ? options[0]!.id : '');
  const next = options.find((p) => p.id === pipelineId) ?? null;
  const [stepId, setStepId] = useState(options.length === 1 ? (options[0]!.steps[0]?.id ?? '') : '');
  const step = next?.steps.find((s) => s.id === stepId) ?? null;
  const choice = 'flex cursor-pointer items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-[13px] hover:bg-canvas has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50';

  return (
    <Dialog
      title="Change pipeline"
      confirmLabel={next && step ? 'Change pipeline' : undefined}
      confirmIcon="shuffle"
      width={480}
      onClose={onClose}
      onConfirm={next && step ? () => onConfirm(next.id, step.id) : undefined}
    >
      <p className="text-[12.5px] text-ink-500">
        This record is on <strong className="font-semibold text-ink-800">{current.label}</strong> at <strong className="font-semibold text-ink-800">{currentStep}</strong> in this module.
        Changing it here does not touch its pipeline in any other module.
      </p>
      <fieldset className="mt-3 space-y-1.5">
        <legend className="mb-1 text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400">Move it to</legend>
        {options.map((p) => (
          <label key={p.id} className={choice}>
            <input
              type="radio"
              name="pipeline-pick"
              value={p.id}
              checked={pipelineId === p.id}
              onChange={() => {
                setPipelineId(p.id);
                setStepId(p.steps[0]?.id ?? '');
              }}
              className="accent-[#1d4ed8]"
            />
            <span className="font-semibold text-ink-900">{p.label}</span>
            <span className="text-[12px] text-ink-400">
              {p.steps.length} stage{p.steps.length === 1 ? '' : 's'}
            </span>
          </label>
        ))}
      </fieldset>
      {next ? (
        <fieldset className="mt-3 space-y-1.5">
          <legend className="mb-1 text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400">Starting stage</legend>
          <div className="flex flex-wrap gap-1.5">
            {next.steps.map((s, i) => {
              const sw = SWATCHES[s.swatch];
              const on = stepId === s.id;
              return (
                <label key={s.id} className="cursor-pointer">
                  <input type="radio" name="stage-pick" value={s.id} checked={on} onChange={() => setStepId(s.id)} className="sr-only" />
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors ${on ? 'font-semibold' : 'border-line bg-white text-ink-600 hover:border-ink-300'}`}
                    style={on ? { background: sw.bg, color: sw.text, borderColor: sw.dot } : undefined}
                  >
                    <span aria-hidden className="size-[6px] rounded-full" style={{ background: on ? sw.dot : '#cfdae3' }} />
                    {i + 1}. {s.label}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}
      {next && step ? (
        <p className="mt-4 rounded-lg border border-line-soft bg-canvas/60 px-3 py-2.5 text-[13px] text-ink-800">
          <Icon name="shuffle" size={12} className="mr-1.5 inline text-ink-400" />
          <span className="text-ink-500">{current.label}</span> <span aria-hidden>→</span> <strong className="font-semibold">{next.label}</strong>, starting at <strong className="font-semibold">{step.label}</strong>.
          This is recorded on the record’s Updates.
        </p>
      ) : (
        <p className="mt-4 text-[12.5px] text-ink-400">Pick the pipeline and its starting stage to continue.</p>
      )}
    </Dialog>
  );
}
