'use client';

/**
 * The automation builder. Reads top to bottom the way a run does: what starts
 * it, what it checks once, then the waits and actions in the order the admin
 * sets. The rail says how many of the ten steps are used and what still stops
 * it from running. `steps.ts` holds the rules, so this and the server agree.
 */
import { useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Catalog } from '@/lib/automations/catalog';
import type { AutomationDetail, AutomationFile } from '@/lib/automations/service';
import {
  ACTIONS, CONDITIONS, EMPTY_STEPS, MAX_STEPS, STATUSES, TRIGGERS, conditionSchema, everyTriggerInModule, flowStepSchema, problemsIn, stepCount, triggerSchema,
  type ActionType, type AutomationStatus, type AutomationSteps, type ConditionStep, type ConditionType, type FlowStep, type TriggerStep, type TriggerType,
} from '@/lib/automations/steps';
import { toLabels, toTokens } from '@/lib/automations/template';
import { Icon } from '@/proto/ui/icons';
import { Button, Dialog, IconButton } from '@/proto/ui/kit';
import { MenuSurface } from '@/proto/ui/MenuSurface';
import { deleteAutomationAction, saveAutomationAction, searchRecordsAction, setStatusAction } from './actions';
import { StatusBadge } from './bits';
import { ConditionFields, FlowFields, TriggerFields, inputClass, labelClass, CheckRow } from './StepFields';

const newId = () => crypto.randomUUID().slice(0, 8);

// Built by the schema, so a new step has exactly the shape a saved one comes back
// with, and a save leaves nothing looking changed.
const blankTrigger = (type: TriggerType): TriggerStep => triggerSchema.parse({ id: newId(), type });
const blankCondition = (type: ConditionType): ConditionStep => conditionSchema.parse({ id: newId(), type });
const blankFlow = (type: ActionType | 'wait'): FlowStep => flowStepSchema.parse({ id: newId(), type });

/** Email words as the admin reads them; stored with field keys. */
function forEditing(steps: AutomationSteps, catalog: Catalog): AutomationSteps {
  return { ...steps, flow: steps.flow.map((f) => (f.type === 'send_email' ? { ...f, subject: toLabels(f.subject, catalog.variables), body: toLabels(f.body, catalog.variables) } : f)) };
}

function forSaving(steps: AutomationSteps, catalog: Catalog): { steps: AutomationSteps; unknown: string[] } {
  const unknown: string[] = [];
  const flow = steps.flow.map((f) => {
    if (f.type !== 'send_email') return f;
    const subject = toTokens(f.subject, catalog.variables);
    const body = toTokens(f.body, catalog.variables);
    unknown.push(...subject.unknown, ...body.unknown);
    return { ...f, subject: subject.text, body: body.text };
  });
  return { steps: { ...steps, flow }, unknown: [...new Set(unknown)] };
}

function Menu({ label, disabled, options, onPick }: { label: string; disabled?: boolean; options: { value: string; label: string; off?: string }[]; onPick?: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        disabled={disabled}
        title={disabled ? `Up to ${MAX_STEPS} steps` : undefined}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-line px-2.5 py-1.5 text-[12.5px] font-semibold text-ink-600 transition-colors hover:border-ink-400 hover:bg-white hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Icon name="plus" size={13} /> {label}
      </button>
      <MenuSurface open={open} onClose={() => setOpen(false)} anchorRef={anchor} align="left" width={270} label={label}>
        <div className="max-h-[320px] overflow-y-auto">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitem"
              disabled={Boolean(o.off)}
              title={o.off}
              onClick={() => {
                setOpen(false);
                onPick?.(o.value);
              }}
              className="block w-full rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink-700 hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-45"
            >
              {o.label}
            </button>
          ))}
        </div>
      </MenuSurface>
    </>
  );
}

function StepCard({ kind, title, onRemove, readOnly, handle, children }: { kind: string; title: string; onRemove?: () => void; readOnly: boolean; handle?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-white">
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        {handle}
        <span className="text-[10.5px] font-semibold uppercase tracking-[.07em] text-ink-400">{kind}</span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink-900">{title}</span>
        {!readOnly && onRemove ? <IconButton icon="trash" size={24} tone="danger" title={`Remove ${title}`} onClick={onRemove} /> : null}
      </div>
      {children ? <div className="border-t border-line-faint px-3.5 py-3">{children}</div> : null}
    </div>
  );
}

function SortableFlow({ step, index, count, catalog, onChange, onRemove, readOnly, stageModule, files, setFiles, automationId }: {
  step: FlowStep; index: number; count: number; catalog: Catalog; onChange: (s: FlowStep) => void; onRemove: () => void; readOnly: boolean;
  stageModule: boolean; files: AutomationFile[]; setFiles: (f: AutomationFile[]) => void; automationId: string | null;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: step.id });
  const isWait = step.type === 'wait';
  const position = isWait ? 'Wait' : `Action`;
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={isDragging ? 'relative z-10 opacity-70' : ''}>
      <StepCard
        kind={position}
        title={isWait ? `${step.amount} ${step.amount === 1 ? step.unit.replace(/s$/, '') : step.unit}` : ACTIONS[step.type]}
        onRemove={onRemove}
        readOnly={readOnly}
        handle={
          !readOnly && count > 1 ? (
            <button type="button" aria-label={`Reorder step ${index + 1}`} {...attributes} {...listeners} className="cursor-grab touch-none text-ink-300 hover:text-ink-600 active:cursor-grabbing">
              <Icon name="list" size={14} />
            </button>
          ) : (
            <span className="grid size-[18px] place-items-center rounded-full bg-canvas text-[10px] font-bold text-ink-500">{index + 1}</span>
          )
        }
      >
        <FlowFields step={step} catalog={catalog} onChange={onChange} stageModule={stageModule} files={files} setFiles={setFiles} automationId={automationId} />
      </StepCard>
    </li>
  );
}

export function Builder({ automation, catalog, canEdit }: { automation: AutomationDetail | null; catalog: Catalog; canEdit: boolean }) {
  const router = useRouter();
  const readOnly = !canEdit;
  const start = useMemo(() => forEditing(automation?.steps ?? EMPTY_STEPS, catalog), [automation, catalog]);
  const [name, setName] = useState(automation?.name ?? '');
  const [steps, setSteps] = useState<AutomationSteps>(start);
  const [stopTeams, setStopTeams] = useState<string[]>(automation?.stopTeamIds ?? []);
  const [stopUsers, setStopUsers] = useState<string[]>(automation?.stopUserIds ?? []);
  const [files, setFiles] = useState<AutomationFile[]>(automation?.files ?? []);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, run] = useTransition();
  const [askWaiting, setAskWaiting] = useState<number | null>(null);
  const [choice, setChoice] = useState<'old' | 'new'>('new');
  const [dialog, setDialog] = useState<null | 'test' | 'off' | 'delete'>(null);

  const status = automation?.status ?? 'draft';
  const used = stepCount(steps);
  const full = used >= MAX_STEPS;
  const problems = useMemo(() => problemsIn(steps), [steps]);
  const dirty =
    name !== (automation?.name ?? '') ||
    JSON.stringify(steps) !== JSON.stringify(start) ||
    JSON.stringify(stopTeams) !== JSON.stringify(automation?.stopTeamIds ?? []) ||
    JSON.stringify(stopUsers) !== JSON.stringify(automation?.stopUserIds ?? []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const inModule = steps.triggers.length === 0 || everyTriggerInModule(steps);
  const stageModule = steps.triggers.some((t) => !TRIGGERS[t.type].inModule);

  const patchTrigger = (id: string, next: TriggerStep) => setSteps((s) => ({ ...s, triggers: s.triggers.map((t) => (t.id === id ? next : t)) }));
  const patchFlow = (id: string, next: FlowStep) => setSteps((s) => ({ ...s, flow: s.flow.map((f) => (f.id === id ? next : f)) }));
  const patchGroups = (groups: AutomationSteps['conditions']['groups']) => setSteps((s) => ({ ...s, conditions: { ...s.conditions, groups: groups.filter((g) => g.conditions.length > 0) } }));

  const addCondition = (groupId: string | null, type: ConditionType) => {
    const c = blankCondition(type);
    if (groupId) patchGroups(steps.conditions.groups.map((g) => (g.id === groupId ? { ...g, conditions: [...g.conditions, c] } : g)));
    else patchGroups([...steps.conditions.groups, { id: newId(), join: 'and', conditions: [c] }]);
  };

  const conditionOptions = Object.entries(CONDITIONS).map(([value, label]) => ({
    value,
    label,
    off: value === 'in_module' && !inModule ? 'Not available with an email, application or contract trigger' : undefined,
  }));

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setSteps((s) => {
      const from = s.flow.findIndex((f) => f.id === active.id);
      const to = s.flow.findIndex((f) => f.id === over.id);
      return { ...s, flow: arrayMove(s.flow, from, to) };
    });
  };

  const save = (waiting: 'old' | 'new' | null, then?: (id: string) => void) => {
    const prepared = forSaving(steps, catalog);
    if (prepared.unknown.length) {
      setError(`Send email: there is no variable called {${prepared.unknown[0]}}.`);
      return;
    }
    run(async () => {
      setError(null);
      const r = await saveAutomationAction({ id: automation?.id ?? null, name, steps: prepared.steps, stopTeamIds: stopTeams, stopUserIds: stopUsers, waiting });
      if (!r.ok) return setError(r.message);
      if ('needsChoice' in r.data) return setAskWaiting(r.data.needsChoice);
      setAskWaiting(null);
      setSaved(true);
      if (then) then(r.data.id);
      else if (!automation) router.replace(`/admin/automations/${r.data.id}`);
      else router.refresh();
    });
  };

  const changeStatus = (next: AutomationStatus, testRecordId: string | null = null) => {
    if (!automation) return;
    run(async () => {
      setError(null);
      const r = await setStatusAction({ id: automation.id, status: next, testRecordId });
      if (!r.ok) return setError(r.message);
      setDialog(null);
      router.refresh();
    });
  };

  const pickStatus = (next: AutomationStatus) => {
    if (next === status) return;
    if (next === 'test') return setDialog('test');
    if ((next === 'off' || next === 'draft') && (automation?.waiting ?? 0) > 0) return setDialog('off');
    changeStatus(next);
  };

  const remove = () =>
    run(async () => {
      if (!automation) return;
      const r = await deleteAutomationAction(automation.id);
      if (!r.ok) return setError(r.message);
      router.push('/admin/automations');
    });

  return (
    <div className="p-6">
      <Link href="/admin/automations" className="inline-flex items-center gap-1 text-[12.5px] font-medium text-ink-500 hover:text-ink-900">
        <Icon name="chevron-left" size={13} /> Automations
      </Link>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <input
          aria-label="Automation name"
          value={name}
          disabled={readOnly}
          onChange={(e) => { setName(e.target.value); setSaved(false); }}
          placeholder="Name this automation"
          className="min-w-[220px] flex-1 rounded-lg border border-transparent bg-transparent px-1 py-1 text-xl font-semibold text-ink-900 outline-none transition-colors placeholder:text-ink-300 hover:border-line focus-field disabled:hover:border-transparent"
        />
        <StatusBadge status={status} />
        {canEdit ? (
          <Button variant="primary" onClick={() => save(null)} loading={pending} loadingLabel="Saving…" disabled={!name.trim() || (!dirty && Boolean(automation))}>
            Save
          </Button>
        ) : null}
      </div>

      {error ? <p role="alert" className="mt-2 rounded-lg border border-[#f7cfd1] bg-[#fce9ea] px-3 py-2 text-[12.5px] text-[#b02a30]">{error}</p> : null}
      {saved && !dirty && !error ? <p className="mt-2 text-[12.5px] text-ink-500">Saved.</p> : null}
      {readOnly ? (
        <p className="mt-2 flex items-center gap-2 rounded-lg border border-line-soft bg-canvas px-3 py-2 text-[12.5px] text-ink-600">
          <Icon name="eye" size={13} className="text-ink-400" /> View only. You can see this automation but change nothing.
        </p>
      ) : null}

      <div className="mt-5 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        <fieldset disabled={readOnly} className="min-w-0 space-y-6">
          <section>
            <SectionHead title="When" hint="Any one of these starts it. Only changes made by people count." />
            <ul className="space-y-2">
              {steps.triggers.map((t) => (
                <li key={t.id}>
                  <StepCard kind="Trigger" title={TRIGGERS[t.type].label} readOnly={readOnly} onRemove={() => setSteps((s) => ({ ...s, triggers: s.triggers.filter((x) => x.id !== t.id) }))}>
                    <TriggerFields step={t} catalog={catalog} onChange={(n) => patchTrigger(t.id, n)} />
                  </StepCard>
                </li>
              ))}
            </ul>
            {!readOnly ? (
              <div className="mt-2">
                <Menu label="Add trigger" disabled={full} options={Object.entries(TRIGGERS).map(([value, t]) => ({ value, label: t.label }))} onPick={(v) => setSteps((s) => ({ ...s, triggers: [...s.triggers, blankTrigger(v as TriggerType)] }))} />
              </div>
            ) : null}
          </section>

          <section>
            <SectionHead title="Only if" hint="Checked once, when it starts. When a wait ends, the next steps run without checking again." />
            {steps.conditions.groups.length > 1 ? (
              <JoinSwitch label="Between groups" value={steps.conditions.join} onChange={(join) => setSteps((s) => ({ ...s, conditions: { ...s.conditions, join } }))} />
            ) : null}
            <ul className="space-y-2">
              {steps.conditions.groups.map((g, gi) => (
                <li key={g.id}>
                  {gi > 0 ? <p className="py-1 text-center text-[11px] font-semibold uppercase tracking-[.08em] text-ink-400">{steps.conditions.join}</p> : null}
                  <div className="rounded-xl border border-line-soft bg-canvas/60 p-2.5">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="text-[11px] font-semibold uppercase tracking-[.06em] text-ink-500">Group {gi + 1}</span>
                      {g.conditions.length > 1 ? (
                        <JoinSwitch label={`Inside group ${gi + 1}`} value={g.join} onChange={(join) => patchGroups(steps.conditions.groups.map((x) => (x.id === g.id ? { ...x, join } : x)))} />
                      ) : null}
                    </div>
                    <ul className="space-y-2">
                      {g.conditions.map((c) => (
                        <li key={c.id}>
                          <StepCard
                            kind="Condition"
                            title={CONDITIONS[c.type]}
                            readOnly={readOnly}
                            onRemove={() => patchGroups(steps.conditions.groups.map((x) => (x.id === g.id ? { ...x, conditions: x.conditions.filter((y) => y.id !== c.id) } : x)))}
                          >
                            <ConditionFields
                              step={c}
                              catalog={catalog}
                              onChange={(n) => patchGroups(steps.conditions.groups.map((x) => (x.id === g.id ? { ...x, conditions: x.conditions.map((y) => (y.id === c.id ? n : y)) } : x)))}
                            />
                          </StepCard>
                        </li>
                      ))}
                    </ul>
                    {!readOnly ? (
                      <div className="mt-2">
                        <Menu label="Add to this group" disabled={full} options={conditionOptions} onPick={(v) => addCondition(g.id, v as ConditionType)} />
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            {!readOnly ? (
              <div className="mt-2">
                <Menu label={steps.conditions.groups.length ? 'Add group' : 'Add condition'} disabled={full} options={conditionOptions} onPick={(v) => addCondition(null, v as ConditionType)} />
              </div>
            ) : null}
          </section>

          <section>
            <SectionHead title="Then" hint="One after another, in this order. If one is skipped or fails, it stops for that record and you get an alert." />
            <DndContext id="automation-flow" sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={steps.flow.map((f) => f.id)} strategy={verticalListSortingStrategy}>
                <ul className="space-y-2">
                  {steps.flow.map((f, i) => (
                    <SortableFlow
                      key={f.id}
                      step={f}
                      index={i}
                      count={steps.flow.length}
                      catalog={catalog}
                      readOnly={readOnly}
                      stageModule={stageModule}
                      files={files}
                      setFiles={setFiles}
                      automationId={automation?.id ?? null}
                      onChange={(n) => patchFlow(f.id, n)}
                      onRemove={() => setSteps((s) => ({ ...s, flow: s.flow.filter((x) => x.id !== f.id) }))}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
            {!readOnly ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <Menu label="Add action" disabled={full} options={Object.entries(ACTIONS).map(([value, label]) => ({ value, label }))} onPick={(v) => setSteps((s) => ({ ...s, flow: [...s.flow, blankFlow(v as ActionType)] }))} />
                <button
                  type="button"
                  disabled={full}
                  onClick={() => setSteps((s) => ({ ...s, flow: [...s.flow, blankFlow('wait')] }))}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-line px-2.5 py-1.5 text-[12.5px] font-semibold text-ink-600 transition-colors hover:border-ink-400 hover:bg-white hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Icon name="clock" size={13} /> Add wait
                </button>
              </div>
            ) : null}
          </section>

          <section>
            <SectionHead title="Who can switch it off" hint="While a record is waiting, these people can stop its remaining steps from the drawer. Everyone else sees the icon." />
            <div className="rounded-xl border border-line bg-white p-3.5">
              <p className={labelClass}>Teams</p>
              <div className="mt-1.5 grid gap-1 sm:grid-cols-2">
                {catalog.teams.map((t) => (
                  <CheckRow key={t.id} label={t.label} checked={stopTeams.includes(t.id)} onChange={(on) => {
                    setStopTeams((l) => (on ? [...l, t.id] : l.filter((x) => x !== t.id)));
                    if (!on) setStopUsers((l) => l.filter((u) => !t.members.some((m) => m.value === u)));
                  }} />
                ))}
              </div>
              {stopTeams.length > 0 ? (
                <div className="mt-3">
                  <p className={labelClass}>Narrow to specific users (optional)</p>
                  <div className="mt-1.5 grid gap-1 sm:grid-cols-2">
                    {catalog.teams.filter((t) => stopTeams.includes(t.id)).flatMap((t) => t.members).map((m) => (
                      <CheckRow key={m.value} label={m.label} checked={stopUsers.includes(m.value)} onChange={(on) => setStopUsers((l) => (on ? [...l, m.value] : l.filter((x) => x !== m.value)))} />
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        </fieldset>

        <aside className="space-y-3 xl:sticky xl:top-4">
          <div className="rounded-xl border border-line bg-white p-3.5">
            <p className="flex items-baseline justify-between text-[12.5px] font-semibold text-ink-700">
              Steps <span className={`tabular-nums ${used > MAX_STEPS ? 'text-[#b02a30]' : 'text-ink-500'}`}>{used} of {MAX_STEPS}</span>
            </p>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-canvas">
              <div className="h-full rounded-full bg-brand-600 transition-[width]" style={{ width: `${Math.min(100, (used / MAX_STEPS) * 100)}%` }} />
            </div>
            {problems.length > 0 ? (
              <>
                <p className="mt-3 text-[12px] font-semibold text-ink-700">Before it can run</p>
                <ul className="mt-1 space-y-1">
                  {problems.map((p) => (
                    <li key={p} className="flex items-start gap-1.5 text-[12px] leading-snug text-ink-500">
                      <Icon name="circle-dot" size={11} className="mt-[2px] shrink-0 text-ink-300" /> {p}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="mt-3 flex items-center gap-1.5 text-[12px] text-[#1f7a4d]"><Icon name="check" size={12} /> Ready to run</p>
            )}
          </div>

          {automation ? (
            <div className="rounded-xl border border-line bg-white p-3.5">
              <p className="text-[12.5px] font-semibold text-ink-700">Status</p>
              <div role="radiogroup" aria-label="Status" className="mt-2 space-y-1">
                {(Object.keys(STATUSES) as AutomationStatus[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={status === s}
                    disabled={readOnly || pending || dirty}
                    onClick={() => pickStatus(s)}
                    title={dirty ? 'Save your changes first' : undefined}
                    className={`block w-full rounded-lg border px-2.5 py-1.5 text-left transition-colors disabled:cursor-not-allowed ${status === s ? 'border-brand-600 bg-brand-50' : 'border-line hover:border-ink-300 disabled:hover:border-line'}`}
                  >
                    <span className="block text-[13px] font-semibold text-ink-900">{STATUSES[s].label}</span>
                    <span className="block text-[11.5px] leading-snug text-ink-500">{STATUSES[s].meaning}</span>
                  </button>
                ))}
              </div>
              {status === 'test' && automation.testRecordLabel ? <p className="mt-2 text-[12px] text-ink-500">Testing on <span className="font-semibold text-ink-700">{automation.testRecordLabel}</span></p> : null}
              {automation.waiting > 0 ? <p className="mt-2 text-[12px] text-ink-500">{automation.waiting} {automation.waiting === 1 ? 'record is' : 'records are'} waiting.</p> : null}
              <div className="mt-3 flex items-center justify-between gap-2 border-t border-line-faint pt-2.5">
                <Link href={`/admin/automations/runs?automation=${automation.id}`} className="text-[12.5px] font-medium text-brand-700 hover:underline">Run history</Link>
                {canEdit ? <button type="button" onClick={() => setDialog('delete')} className="text-[12.5px] font-medium text-[#b02a30] hover:underline">Delete</button> : null}
              </div>
            </div>
          ) : (
            <p className="px-1 text-[12px] text-ink-500">Save it as a Draft first. It won&rsquo;t run until you switch it to Test or On.</p>
          )}
        </aside>
      </div>

      {askWaiting !== null ? (
        <Dialog title="Records are waiting" confirmLabel="Save" onConfirm={() => save(choice)} onClose={() => setAskWaiting(null)}>
          <p className="text-[13px] text-ink-600">{askWaiting} {askWaiting === 1 ? 'record is' : 'records are'} partway through a wait. How should {askWaiting === 1 ? 'it' : 'they'} finish?</p>
          <div className="mt-3 space-y-1.5">
            {([['new', 'On the new version', 'The remaining steps follow what you just saved.'], ['old', 'On the old version', 'They finish the steps they started with.']] as const).map(([v, title, sub]) => (
              <label key={v} className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 ${choice === v ? 'border-brand-600 bg-brand-50' : 'border-line'}`}>
                <input type="radio" name="waiting" checked={choice === v} onChange={() => setChoice(v)} className="mt-[3px]" />
                <span><span className="block text-[13px] font-semibold text-ink-900">{title}</span><span className="block text-[12px] text-ink-500">{sub}</span></span>
              </label>
            ))}
          </div>
        </Dialog>
      ) : null}

      {dialog === 'test' ? <TestDialog onClose={() => setDialog(null)} onPick={(id) => changeStatus('test', id)} /> : null}
      {dialog === 'off' ? (
        <Dialog title="Stop what is waiting?" confirmLabel="Switch off" onConfirm={() => changeStatus('off')} onClose={() => setDialog(null)}>
          <p className="text-[13px] text-ink-600">{automation?.waiting} {automation?.waiting === 1 ? 'record is' : 'records are'} waiting on this automation. {automation?.waiting === 1 ? 'Its' : 'Their'} remaining steps won&rsquo;t run.</p>
        </Dialog>
      ) : null}
      {dialog === 'delete' ? (
        <Dialog title="Delete this automation?" tone="danger" confirmLabel="Delete" onConfirm={remove} onClose={() => setDialog(null)}>
          <p className="text-[13px] text-ink-600">It stops running, and any record waiting on it won&rsquo;t finish. Its run history stays.</p>
        </Dialog>
      ) : null}
    </div>
  );
}

function SectionHead({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mb-2">
      <h2 className="text-[11.5px] font-semibold uppercase tracking-[.08em] text-ink-500">{title}</h2>
      <p className="text-[12.5px] text-ink-500">{hint}</p>
    </div>
  );
}

function JoinSwitch({ label, value, onChange }: { label: string; value: 'and' | 'or'; onChange: (v: 'and' | 'or') => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="mb-1 inline-flex overflow-hidden rounded-md border border-line bg-white text-[11.5px] font-semibold">
      {(['and', 'or'] as const).map((v) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)} className={`px-2 py-0.5 ${value === v ? 'bg-brand-950 text-white' : 'text-ink-500 hover:bg-canvas'}`}>
          {v}
        </button>
      ))}
    </div>
  );
}

function TestDialog({ onClose, onPick }: { onClose: () => void; onPick: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ id: string; label: string }[]>([]);
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(null);
  const [searching, run] = useTransition();

  const search = (text: string) => {
    setQ(text);
    run(async () => {
      const r = await searchRecordsAction(text);
      if (r.ok) setHits(r.data);
    });
  };

  return (
    <Dialog title="Test on one record" confirmLabel="Start test" onConfirm={() => picked && onPick(picked.id)} onClose={onClose}>
      <p className="text-[13px] text-ink-600">It runs for real, but only on this record, and only when something happens on it after now.</p>
      <label className="mt-3 block">
        <span className={labelClass}>Record</span>
        <input value={q} onChange={(e) => search(e.target.value)} placeholder="Search by name…" className={inputClass} autoFocus />
      </label>
      <ul className="mt-2 max-h-[200px] space-y-0.5 overflow-y-auto">
        {hits.map((h) => (
          <li key={h.id}>
            <button type="button" onClick={() => setPicked(h)} className={`block w-full truncate rounded-lg px-2.5 py-1.5 text-left text-[13px] ${picked?.id === h.id ? 'bg-brand-50 font-semibold text-brand-800' : 'text-ink-700 hover:bg-canvas'}`}>
              {h.label}
            </button>
          </li>
        ))}
        {!searching && q.trim() && hits.length === 0 ? <li className="px-2.5 py-1.5 text-[12.5px] text-ink-400">No record by that name.</li> : null}
      </ul>
    </Dialog>
  );
}
