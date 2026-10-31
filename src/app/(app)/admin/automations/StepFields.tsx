'use client';

/** The controls inside each step. Every list comes from the catalog. */
import { useRef, useState, useTransition } from 'react';
import type { Catalog, CatalogField, Option } from '@/lib/automations/catalog';
import type { AutomationFile } from '@/lib/automations/service';
import type { ConditionStep, EmailStep, FlowStep, TriggerStep } from '@/lib/automations/steps';
import { CONTACT_NAME, MERCHANT_NAME } from '@/lib/automations/template';
import { Icon } from '@/proto/ui/icons';
import { IconButton } from '@/proto/ui/kit';
import { removeFileAction, uploadFileAction } from './actions';

export const inputClass =
  'mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-[13px] text-ink-900 outline-none transition-colors hover:border-ink-300 focus-field disabled:bg-canvas disabled:text-ink-500';
export const labelClass = 'block text-[11px] font-semibold uppercase tracking-[.05em] text-ink-500';

function Pick({ label, value, onChange, options, none = 'Choose…' }: { label: string; value: string; onChange: (v: string) => void; options: Option[]; none?: string }) {
  return (
    <label className="block min-w-0">
      <span className={labelClass}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
        <option value="">{none}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

function FieldPick({ label, value, onChange, fields, extra }: { label: string; value: string; onChange: (v: string) => void; fields: CatalogField[]; extra?: Option[] }) {
  const groups = new Map<string, CatalogField[]>();
  for (const f of fields) groups.set(f.where, [...(groups.get(f.where) ?? []), f]);
  return (
    <label className="block min-w-0">
      <span className={labelClass}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
        <option value="">Choose…</option>
        {extra?.length ? (
          <optgroup label="Files tab">
            {extra.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </optgroup>
        ) : null}
        {[...groups].map(([where, list]) => (
          <optgroup key={where} label={where}>
            {list.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function Text({ label, value, onChange, placeholder, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <label className="block min-w-0">
      <span className={labelClass}>{label}</span>
      <input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={inputClass} />
    </label>
  );
}

const Row = ({ children }: { children: React.ReactNode }) => <div className="grid gap-3 sm:grid-cols-2">{children}</div>;

export function CheckRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[13px] text-ink-700 hover:bg-canvas">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="truncate">{label}</span>
    </label>
  );
}

const teamOptions = (c: Catalog): Option[] => c.teams.map((t) => ({ value: t.id, label: t.label }));
const pipelineOptions = (c: Catalog): Option[] => c.pipelines.map((p) => ({ value: p.id, label: `${p.label} (${p.moduleLabel})` }));
const stepOptions = (c: Catalog, pipelineId: string): Option[] => c.pipelines.find((p) => p.id === pipelineId)?.steps ?? [];

export function TriggerFields({ step, catalog, onChange }: { step: TriggerStep; catalog: Catalog; onChange: (s: TriggerStep) => void }) {
  switch (step.type) {
    case 'status':
      return <Pick label="Changes to" value={step.value} onChange={(value) => onChange({ ...step, value })} options={catalog.statuses} />;
    case 'stage':
      return (
        <Row>
          <Pick label="Pipeline" value={step.pipelineId} onChange={(pipelineId) => onChange({ ...step, pipelineId, stepId: '' })} options={pipelineOptions(catalog)} />
          <Pick label="Stage" value={step.stepId} onChange={(stepId) => onChange({ ...step, stepId })} options={stepOptions(catalog, step.pipelineId)} />
        </Row>
      );
    case 'team_assigned':
    case 'team_removed':
      return <Pick label="Team" value={step.teamId} onChange={(teamId) => onChange({ ...step, teamId })} options={teamOptions(catalog)} />;
    case 'module_assigned':
    case 'module_removed':
      return <Pick label="Module" value={step.moduleId} onChange={(moduleId) => onChange({ ...step, moduleId })} options={catalog.modules} />;
    case 'field': {
      const field = catalog.fields.find((f) => f.key === step.field);
      const changeable = catalog.fields.filter((f) => f.type !== 'file');
      return (
        <Row>
          <FieldPick label="Field" value={step.field} onChange={(f) => onChange({ ...step, field: f, value: '' })} fields={changeable} />
          {field?.choices.length ? (
            <Pick label="New value (optional)" value={step.value} none="Any value" onChange={(value) => onChange({ ...step, value })} options={field.choices} />
          ) : (
            <Text label="New value (optional)" value={step.value} placeholder="Any value" onChange={(value) => onChange({ ...step, value })} />
          )}
        </Row>
      );
    }
    default:
      return null;
  }
}

export function ConditionFields({ step, catalog, onChange }: { step: ConditionStep; catalog: Catalog; onChange: (s: ConditionStep) => void }) {
  const dates = catalog.fields.filter((f) => f.type === 'date' || f.type === 'datetime');
  switch (step.type) {
    case 'field_filled':
      return (
        <FieldPick
          label="Field"
          value={step.fileRow ? `row:${step.fileRow}` : step.field}
          onChange={(v) => onChange(v.startsWith('row:') ? { ...step, field: '', fileRow: v.slice(4) } : { ...step, field: v, fileRow: '' })}
          fields={catalog.fields}
          extra={catalog.fileRows.map((r) => ({ value: `row:${r}`, label: r }))}
        />
      );
    case 'all_filled':
      return (
        <Pick
          label="Tab or sub-tab"
          value={step.subtabId ? `${step.tabId}/${step.subtabId}` : step.tabId}
          onChange={(v) => {
            const [tabId = '', subtabId = ''] = v.split('/');
            onChange({ ...step, tabId, subtabId });
          }}
          options={catalog.tabs}
        />
      );
    case 'status_is':
      return <Pick label="Status" value={step.value} onChange={(value) => onChange({ ...step, value })} options={catalog.statuses} />;
    case 'pipeline_is':
      return <Pick label="Pipeline" value={step.pipelineId} onChange={(pipelineId) => onChange({ ...step, pipelineId })} options={pipelineOptions(catalog)} />;
    case 'in_module':
      return <Pick label="Module" value={step.moduleId} onChange={(moduleId) => onChange({ ...step, moduleId })} options={catalog.modules} />;
    case 'date_is':
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          <FieldPick label="Date field" value={step.field} onChange={(field) => onChange({ ...step, field })} fields={dates} />
          <Pick label="Is" value={step.op} none="on" onChange={(op) => onChange({ ...step, op: (op || 'on') as typeof step.op })} options={[{ value: 'before', label: 'before' }, { value: 'after', label: 'after' }]} />
          <Text label="Date" type="date" value={step.date} onChange={(date) => onChange({ ...step, date })} />
        </div>
      );
    case 'days_from':
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          <FieldPick label="Date field" value={step.field} onChange={(field) => onChange({ ...step, field })} fields={dates} />
          <Text label="Days" type="number" value={String(step.days)} onChange={(v) => onChange({ ...step, days: Math.max(0, Math.min(3650, Number(v) || 0)) })} />
          <label className="block min-w-0">
            <span className={labelClass}>Today is that many days</span>
            <select value={step.direction} onChange={(e) => onChange({ ...step, direction: e.target.value as typeof step.direction })} className={inputClass}>
              <option value="after">after the date</option>
              <option value="before">before the date</option>
            </select>
          </label>
        </div>
      );
  }
}

function RoundRobin({ step, catalog, onChange }: { step: Extract<FlowStep, { type: 'round_robin' }>; catalog: Catalog; onChange: (s: FlowStep) => void }) {
  return (
    <div>
      <p className="text-[12px] text-ink-500">Whole teams, or specific members. People are taken alphabetically by last name; inactive and archived users are skipped.</p>
      <ul className="mt-2 space-y-2">
        {catalog.teams.map((t) => {
          const whole = step.teamIds.includes(t.id);
          return (
            <li key={t.id} className="rounded-lg border border-line-soft p-2">
              <CheckRow label={`${t.label} (whole team)`} checked={whole} onChange={(on) => onChange({ ...step, teamIds: on ? [...step.teamIds, t.id] : step.teamIds.filter((x) => x !== t.id), userIds: on ? step.userIds.filter((u) => !t.members.some((m) => m.value === u)) : step.userIds })} />
              {!whole && t.members.length > 0 ? (
                <div className="mt-1 grid gap-0.5 pl-5 sm:grid-cols-2">
                  {t.members.map((m) => (
                    <CheckRow key={m.value} label={m.label} checked={step.userIds.includes(m.value)} onChange={(on) => onChange({ ...step, userIds: on ? [...step.userIds, m.value] : step.userIds.filter((x) => x !== m.value) })} />
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ChangeStage({ step, catalog, onChange, stageModule }: { step: Extract<FlowStep, { type: 'change_stage' }>; catalog: Catalog; onChange: (s: FlowStep) => void; stageModule: boolean }) {
  const pipelines = catalog.pipelines.filter((p) => !stageModule || !step.moduleId || p.moduleId === step.moduleId);
  const stages: Option[] = pipelines.flatMap((p) => p.steps.map((s) => ({ value: `${p.id}/${s.value}`, label: `${p.label} › ${s.label}` })));
  return (
    <Row>
      {stageModule ? <Pick label="Module" value={step.moduleId} onChange={(moduleId) => onChange({ ...step, moduleId, pipelineId: '', stepId: '' })} options={catalog.modules.filter((m) => catalog.pipelines.some((p) => p.moduleId === m.value))} /> : null}
      <Pick
        label="Stage"
        value={step.stepId ? `${step.pipelineId}/${step.stepId}` : ''}
        onChange={(v) => {
          const [pipelineId = '', stepId = ''] = v.split('/');
          onChange({ ...step, pipelineId, stepId });
        }}
        options={stages}
      />
      <p className="text-[12px] text-ink-500 sm:col-span-2">If the record isn&rsquo;t on this pipeline in that module, the step is skipped and the automation stops.</p>
    </Row>
  );
}

function SendEmail({ step, catalog, onChange, files, setFiles, automationId }: { step: EmailStep; catalog: Catalog; onChange: (s: FlowStep) => void; files: AutomationFile[]; setFiles: (f: AutomationFile[]) => void; automationId: string | null }) {
  const body = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, run] = useTransition();
  const [lastBox, setLastBox] = useState<'subject' | 'body'>('body');

  const insert = (name: string) => {
    if (!name) return;
    const token = `{${name}}`;
    if (lastBox === 'subject') return onChange({ ...step, subject: `${step.subject}${token}` });
    const el = body.current;
    const at = el?.selectionStart ?? step.body.length;
    onChange({ ...step, body: `${step.body.slice(0, at)}${token}${step.body.slice(at)}` });
  };

  const attached = files.filter((f) => step.fileIds.includes(f.id));
  const upload = (file: File) => {
    if (!automationId) return;
    const data = new FormData();
    data.set('automationId', automationId);
    data.set('file', file);
    run(async () => {
      const r = await uploadFileAction(data);
      if (!r.ok) return setError(r.message);
      setError(null);
      setFiles([...files, r.data]);
      onChange({ ...step, fileIds: [...step.fileIds, r.data.id] });
    });
  };
  const detach = (id: string) => {
    onChange({ ...step, fileIds: step.fileIds.filter((x) => x !== id) });
    setFiles(files.filter((f) => f.id !== id));
    void removeFileAction(id);
  };

  return (
    <div className="space-y-3">
      <Row>
        <Pick label="From" value={step.mailboxId} none={catalog.inboxes.length ? 'Choose an inbox…' : 'No inbox is connected'} onChange={(mailboxId) => onChange({ ...step, mailboxId })} options={catalog.inboxes} />
        <label className="block min-w-0">
          <span className={labelClass}>To</span>
          <select value={step.to} onChange={(e) => onChange({ ...step, to: e.target.value as EmailStep['to'] })} className={inputClass}>
            <option value="main_contact">The main contact (primary)</option>
            <option value="owners">All owners</option>
            <option value="custom">A custom email address</option>
          </select>
        </label>
      </Row>
      {step.to === 'custom' ? <Text label="Email address" value={step.customTo} placeholder="name@example.com" onChange={(customTo) => onChange({ ...step, customTo })} /> : null}
      <label className="block">
        <span className={labelClass}>Subject</span>
        <input value={step.subject} maxLength={255} onFocus={() => setLastBox('subject')} onChange={(e) => onChange({ ...step, subject: e.target.value })} className={inputClass} />
      </label>
      <label className="block">
        <span className={labelClass}>Body</span>
        <textarea ref={body} rows={6} value={step.body} onFocus={() => setLastBox('body')} onChange={(e) => onChange({ ...step, body: e.target.value })} className={inputClass} />
      </label>
      <label className="block max-w-[320px]">
        <span className={labelClass}>Insert a variable</span>
        <select
          value=""
          onChange={(e) => insert(e.target.value)}
          className={inputClass}
        >
          <option value="">Choose…</option>
          <option value={CONTACT_NAME}>{CONTACT_NAME}</option>
          <option value={MERCHANT_NAME}>{MERCHANT_NAME}</option>
          <optgroup label="Fields">
            {catalog.variables.map((f) => <option key={f.key} value={f.label}>{f.label}</option>)}
          </optgroup>
        </select>
      </label>

      <div>
        <p className={labelClass}>Attachments</p>
        <ul className="mt-1 space-y-1">
          {attached.map((f) => (
            <li key={f.id} className="flex items-center gap-2 rounded-md bg-canvas px-2 py-1 text-[12.5px] text-ink-700">
              <Icon name="paperclip" size={12} className="text-ink-400" />
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <IconButton icon="x" size={20} title={`Remove ${f.name}`} onClick={() => detach(f.id)} />
            </li>
          ))}
        </ul>
        <label className={`mt-1 inline-flex items-center gap-1.5 text-[12.5px] font-semibold ${automationId ? 'cursor-pointer text-brand-700 hover:underline' : 'text-ink-400'}`}>
          <Icon name="upload" size={13} />
          {uploading ? 'Uploading…' : automationId ? 'Upload a file' : 'Save first to upload a file'}
          <input
            type="file"
            className="sr-only"
            disabled={!automationId || uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
              e.target.value = '';
            }}
          />
        </label>
        {error ? <p role="alert" className="mt-1 text-[12px] text-[#b02a30]">{error}</p> : null}
        <p className="mt-2 text-[12px] text-ink-500">From the record&rsquo;s Files tab:</p>
        <div className="mt-0.5 grid gap-0.5 sm:grid-cols-2">
          {catalog.fileRows.map((r) => (
            <CheckRow key={r} label={r} checked={step.fileRows.includes(r)} onChange={(on) => onChange({ ...step, fileRows: on ? [...step.fileRows, r] : step.fileRows.filter((x) => x !== r) })} />
          ))}
        </div>
      </div>
      <p className="text-[12px] text-ink-500">Sent as a new message, not a reply. If a chosen Files row is empty, the email doesn&rsquo;t go and you get an alert.</p>
    </div>
  );
}

export function FlowFields({ step, catalog, onChange, stageModule, files, setFiles, automationId }: {
  step: FlowStep; catalog: Catalog; onChange: (s: FlowStep) => void; stageModule: boolean; files: AutomationFile[]; setFiles: (f: AutomationFile[]) => void; automationId: string | null;
}) {
  switch (step.type) {
    case 'wait':
      return (
        <div className="grid max-w-[320px] grid-cols-2 gap-3">
          <Text label="Wait" type="number" value={String(step.amount)} onChange={(v) => onChange({ ...step, amount: Math.max(1, Math.min(3650, Number(v) || 1)) })} />
          <label className="block min-w-0">
            <span className={labelClass}>Unit</span>
            <select value={step.unit} onChange={(e) => onChange({ ...step, unit: e.target.value as typeof step.unit })} className={inputClass}>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </label>
        </div>
      );
    case 'change_stage':
      return <ChangeStage step={step} catalog={catalog} onChange={onChange} stageModule={stageModule} />;
    case 'change_status':
      return <Pick label="Status" value={step.value} onChange={(value) => onChange({ ...step, value })} options={catalog.statuses} />;
    case 'send_email':
      return <SendEmail step={step} catalog={catalog} onChange={onChange} files={files} setFiles={setFiles} automationId={automationId} />;
    case 'assign_team':
      return (
        <>
          <Pick label="Team" value={step.teamId} onChange={(teamId) => onChange({ ...step, teamId })} options={teamOptions(catalog)} />
          <p className="mt-2 text-[12px] text-ink-500">It shows as Open until someone takes it.</p>
        </>
      );
    case 'remove_team':
      return (
        <>
          <Pick label="Team" value={step.teamId} onChange={(teamId) => onChange({ ...step, teamId })} options={teamOptions(catalog)} />
          <p className="mt-2 text-[12px] text-ink-500">If someone from that team took the record, they are removed too.</p>
        </>
      );
    case 'assign_user':
      return <Pick label="User" value={step.userId} onChange={(userId) => onChange({ ...step, userId })} options={catalog.users} />;
    case 'round_robin':
      return <RoundRobin step={step} catalog={catalog} onChange={onChange} />;
    case 'add_module':
      return <Pick label="Module" value={step.moduleId} onChange={(moduleId) => onChange({ ...step, moduleId })} options={catalog.movableModules} />;
    case 'remove_module':
      return (
        <>
          <Pick label="Module" value={step.moduleId} onChange={(moduleId) => onChange({ ...step, moduleId })} options={catalog.movableModules} />
          <p className="mt-2 text-[12px] text-ink-500">A record taken out of its last module is archived.</p>
        </>
      );
    case 'create_ticket':
      return (
        <div className="space-y-3">
          <Text label="Title" value={step.title} placeholder="Taken from the Issue if left empty" onChange={(title) => onChange({ ...step, title })} />
          <label className="block">
            <span className={labelClass}>Issue</span>
            <textarea rows={3} value={step.issue} onChange={(e) => onChange({ ...step, issue: e.target.value })} className={inputClass} />
          </label>
          <p className="text-[12px] text-ink-500">Required, and can&rsquo;t be edited once saved, the same as a ticket opened by hand.</p>
        </div>
      );
    case 'send_notification':
      return (
        <div className="space-y-3">
          <Row>
            <label className="block min-w-0">
              <span className={labelClass}>Who gets it</span>
              <select value={step.who} onChange={(e) => onChange({ ...step, who: e.target.value as typeof step.who })} className={inputClass}>
                <option value="team_members">The assigned team member(s)</option>
                <option value="team">An assigned team</option>
                <option value="relationship_manager">The relationship manager</option>
              </select>
            </label>
            {step.who === 'team' ? <Pick label="Team" value={step.teamId} onChange={(teamId) => onChange({ ...step, teamId })} options={teamOptions(catalog)} /> : null}
          </Row>
          <Text label="Message (optional)" value={step.message} placeholder="Says which automation ran, if left empty" onChange={(message) => onChange({ ...step, message })} />
          <p className="text-[12px] text-ink-500">Notifications panel only, no email.</p>
        </div>
      );
  }
}
