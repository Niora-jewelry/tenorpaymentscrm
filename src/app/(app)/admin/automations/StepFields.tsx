'use client';

/** The controls inside each step. Every list comes from the catalog. */
import { RestrictionFields } from './RestrictionFields';
import { useRef, useState, useTransition, type Dispatch, type SetStateAction } from 'react';
import type { Catalog, CatalogField, Option } from '@/lib/automations/catalog';
import type { AutomationFile } from '@/lib/automations/service';
import type { AutomationKind, ConditionStep, EmailStep, FlowStep, TriggerStep } from '@/lib/automations/steps';
import { FILE_FREQUENCIES } from '@/lib/automations/steps';
import { CONTACT_NAME, EMAIL_BODY, EMAIL_SUBJECT, MERCHANT_NAME, TICKET_NUMBER, TICKET_TITLE } from '@/lib/automations/template';
import { Icon } from '@/proto/ui/icons';
import { IconButton } from '@/proto/ui/kit';
import { uploadFileAction } from './actions';

export const inputClass =
  'mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-[13px] text-ink-900 outline-none transition-colors hover:border-ink-300 focus-field disabled:bg-canvas disabled:text-ink-500';
export const labelClass = 'block text-[11px] font-semibold uppercase tracking-[.05em] text-ink-500';

function Pick({ label, value, onChange, options, none = 'Choose…' }: { label: string; value: string; onChange: (v: string) => void; options: Option[]; none?: string }) {
  return (
    <label className="block min-w-0">
      <span className={labelClass}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
        <option value="">{none}</option>
        {options.filter((o) => !o.group).map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
        {[...new Set(options.filter((o) => o.group).map((o) => o.group!))].map((group) => (
          <optgroup key={group} label={group}>
            {options.filter((o) => o.group === group).map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </optgroup>
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

/** A line of explanation under a step that has nothing to set. */
const Note = ({ children }: { children: React.ReactNode }) => <p className="text-[12.5px] leading-relaxed text-ink-500">{children}</p>;

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
      return (
        <div>
          <Pick label="Changes to" value={step.value} onChange={(value) => onChange({ ...step, value })} options={catalog.statuses} />
          <p className="mt-1.5 text-[12px] text-ink-400">This is Current Status, whose options are set per module. For a pipeline’s status use Pipeline stage changes. For any other field, such as Risk Level, use Field changed.</p>
        </div>
      );
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
    case 'file_uploaded':
      return (
        <div className="space-y-3">
          <div>
            <span className={labelClass}>Rows</span>
            <div className="grid max-w-[420px] gap-0.5 sm:grid-cols-2">
              {catalog.fileRows.map((r) => (
                <CheckRow key={r} label={r} checked={step.rows.includes(r)} onChange={(on) => onChange({ ...step, rows: on ? [...step.rows, r] : step.rows.filter((x) => x !== r) })} />
              ))}
            </div>
            <p className="mt-1 text-[12px] text-ink-400">Preset rows only. Uploads by people count, the merchant’s included. Files sent together count once.</p>
          </div>
          <label className="block max-w-[320px]">
            <span className={labelClass}>Can fire</span>
            <select value={step.frequency} onChange={(e) => onChange({ ...step, frequency: e.target.value as typeof step.frequency })} className={inputClass}>
              {Object.entries(FILE_FREQUENCIES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        </div>
      );
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
    case 'processor_status':
      return (
        <div className="space-y-2">
          <div className="max-w-[420px]">
            <Text label="Changes to (optional)" value={step.value} placeholder="Any status" onChange={(value) => onChange({ ...step, value })} />
          </div>
          <Note>
            Runs when the daily Maverick sync finds a new status on a record&rsquo;s application. Leave it blank for any change, or type the
            status exactly as Maverick shows it.
          </Note>
        </div>
      );
    case 'ticket_email':
      return (
        <div className="space-y-2">
          <div className="max-w-[420px]">
            <Pick
              label="Inbox"
              value={step.mailboxId}
              none={catalog.inboxes.length ? 'Choose an inbox…' : 'No inbox is connected'}
              onChange={(mailboxId) => onChange({ ...step, mailboxId })}
              options={catalog.inboxes}
            />
          </div>
          <Note>
            An email from a record&rsquo;s main contact or an owner starts it. Every such email in this inbox is added to the record&rsquo;s
            Communication tab, whether or not the flow runs. An email that matches no record stays in the inbox. Emails the CRM sends never start it.
          </Note>
        </div>
      );
    case 'awaiting_client':
      return (
        <Note>
          Starts when someone clicks <span className="font-semibold text-ink-700">Awaiting client</span> on an open ticket. The flow acts on that ticket
          only. Clicking a ticket that is already tagged does nothing.
        </Note>
      );
    default:
      return null;
  }
}

export function ConditionFields({ step, catalog, onChange }: { step: ConditionStep; catalog: Catalog; onChange: (s: ConditionStep) => void }) {
  // A date inside a repeat group has one value per person, so it can't be "the date".
  const dates = catalog.fields.filter((f) => (f.type === 'date' || f.type === 'datetime') && !f.key.includes('.'));
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
          <label className="block min-w-0">
            <span className={labelClass}>Is</span>
            <select value={step.op} onChange={(e) => onChange({ ...step, op: e.target.value as typeof step.op })} className={inputClass}>
              <option value="before">before</option>
              <option value="after">after</option>
              <option value="on">on</option>
            </select>
          </label>
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
    case 'files_required_empty':
      return <p className="text-[12.5px] text-ink-500">True when no row on the record is outstanding.</p>;
    case 'files_required_filled':
      return (
        <div className="max-w-[320px]">
          <Text label="Row name (optional)" value={step.fileRow} placeholder="Any row" onChange={(fileRow) => onChange({ ...step, fileRow })} />
          <p className="mt-1.5 text-[12px] text-ink-400">Leave blank for any outstanding row.</p>
        </div>
      );
    case 'ticket_open':
      return (
        <Note>
          For an email: the record has at least one open ticket. If it has more than one and a step acts on a ticket, the assigned users are asked
          which one. For the button: the ticket clicked is still open.
        </Note>
      );
    case 'ticket_not_open':
      return (
        <Note>
          For an email: the record has no open ticket. Use it with Open ticket for emails that need a new one. For the button: the ticket clicked has
          been closed.
        </Note>
      );
    case 'email_connects':
      return <Note>The sender is a record&rsquo;s main contact or an owner. An email that matches no record never runs the flow.</Note>;
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

function SendEmail({ step, catalog, onChange, files, setFiles, automationId, kind, hasEmailTrigger }: {
  step: EmailStep; catalog: Catalog; onChange: (s: FlowStep) => void; files: AutomationFile[]; setFiles: Dispatch<SetStateAction<AutomationFile[]>>;
  automationId: string | null; kind: AutomationKind; hasEmailTrigger: boolean;
}) {
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
      setFiles((list) => [...list, r.data]);
      onChange({ ...step, fileIds: [...step.fileIds, r.data.id] });
    });
  };
  // Only the step lets go. The file stays: the saved version, or a record still
  // finishing on an old one, may need it.
  const detach = (id: string) => onChange({ ...step, fileIds: step.fileIds.filter((x) => x !== id) });

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
          {kind === 'ticket' ? (
            <optgroup label="Ticket">
              <option value={TICKET_TITLE}>{TICKET_TITLE}</option>
              <option value={TICKET_NUMBER}>{TICKET_NUMBER}</option>
            </optgroup>
          ) : null}
          {kind === 'ticket' && hasEmailTrigger ? (
            <optgroup label="The email received">
              <option value={EMAIL_SUBJECT}>{EMAIL_SUBJECT}</option>
              <option value={EMAIL_BODY}>{EMAIL_BODY}</option>
            </optgroup>
          ) : null}
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
      <p className="text-[12px] text-ink-500">
        Sent as a new message, not a reply. If a chosen Files row is empty, the email doesn&rsquo;t go and you get an alert.
        {kind === 'ticket' ? ' The sent email appears on the record’s Communication tab, and a line is added to the ticket’s log.' : null}
      </p>
    </div>
  );
}

function RequiredRows({ step, catalog, onChange }: {
  step: Extract<FlowStep, { type: 'mark_file_required' }>; catalog: Catalog; onChange: (s: FlowStep) => void;
}) {
  const set = (name: string, needed: number | null) =>
    onChange({ ...step, rows: needed === null ? step.rows.filter((r) => r.name !== name) : [...step.rows.filter((r) => r.name !== name), { name, needed }] });
  return (
    <div>
      <span className={labelClass}>Rows and files needed</span>
      <ul className="max-w-[420px] space-y-1">
        {catalog.fileRows.map((name) => {
          const row = step.rows.find((r) => r.name === name);
          return (
            <li key={name} className="flex items-center justify-between gap-3">
              <CheckRow label={name} checked={Boolean(row)} onChange={(on) => set(name, on ? 1 : null)} />
              {row ? (
                <input
                  type="number"
                  min={1}
                  max={5}
                  aria-label={`Files needed on ${name}`}
                  value={row.needed}
                  onChange={(e) => set(name, Math.min(5, Math.max(1, Number(e.target.value) || 1)))}
                  className="w-16 rounded-lg border border-line px-2 py-1 text-[13px] outline-none focus:border-brand-400"
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="mt-1.5 text-[12px] text-ink-400">Preset rows only: rows people add may not exist yet.</p>
    </div>
  );
}

/** Title and Issue of a ticket a flow opens: the variables Open ticket can fill. */
function OpenTicket({ step, onChange, hasEmailTrigger }: { step: Extract<FlowStep, { type: 'open_ticket' }>; onChange: (s: FlowStep) => void; hasEmailTrigger: boolean }) {
  const issue = useRef<HTMLTextAreaElement>(null);
  const [lastBox, setLastBox] = useState<'title' | 'issue'>('issue');
  const names = [MERCHANT_NAME, CONTACT_NAME, ...(hasEmailTrigger ? [EMAIL_SUBJECT, EMAIL_BODY] : [])];
  const insert = (name: string) => {
    if (!name) return;
    const token = `{${name}}`;
    if (lastBox === 'title') return onChange({ ...step, title: `${step.title}${token}` });
    const at = issue.current?.selectionStart ?? step.issue.length;
    onChange({ ...step, issue: `${step.issue.slice(0, at)}${token}${step.issue.slice(at)}` });
  };
  return (
    <div className="space-y-3">
      <label className="block">
        <span className={labelClass}>Title</span>
        <input value={step.title} maxLength={200} placeholder="Taken from the Issue if left empty" onFocus={() => setLastBox('title')} onChange={(e) => onChange({ ...step, title: e.target.value })} className={inputClass} />
      </label>
      <label className="block">
        <span className={labelClass}>Issue</span>
        <textarea ref={issue} rows={3} value={step.issue} onFocus={() => setLastBox('issue')} onChange={(e) => onChange({ ...step, issue: e.target.value })} className={inputClass} />
      </label>
      <label className="block max-w-[320px]">
        <span className={labelClass}>Insert a variable</span>
        <select value="" onChange={(e) => insert(e.target.value)} className={inputClass}>
          <option value="">Choose…</option>
          {names.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <p className="text-[12px] text-ink-500">
        Creates a new ticket on the record. The Issue is required and can&rsquo;t be edited once saved, the same as a ticket opened by hand. Later
        steps act on the new ticket. If the record already has an open ticket, the step is skipped and the flow stops.
      </p>
    </div>
  );
}

export function FlowFields({ step, catalog, onChange, stageModule, files, setFiles, automationId, kind = 'record', hasEmailTrigger = false }: {
  step: FlowStep; catalog: Catalog; onChange: (s: FlowStep) => void; stageModule: boolean; files: AutomationFile[]; setFiles: Dispatch<SetStateAction<AutomationFile[]>>; automationId: string | null;
  kind?: AutomationKind; hasEmailTrigger?: boolean;
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
      return <SendEmail step={step} catalog={catalog} onChange={onChange} files={files} setFiles={setFiles} automationId={automationId} kind={kind} hasEmailTrigger={hasEmailTrigger} />;
    case 'assign_team':
      return (
        <>
          <Pick label="Team" value={step.teamId} onChange={(teamId) => onChange({ ...step, teamId })} options={teamOptions(catalog)} />
          <p className="mt-2 text-[12px] text-ink-500">
            {kind === 'ticket'
              ? 'Assigns a team to the ticket’s record in the Tickets module. It shows as Open until someone on that team takes it. No specific user, no round robin.'
              : 'It shows as Open until someone takes it.'}
          </p>
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
    case 'mark_file_required':
      return <RequiredRows step={step} catalog={catalog} onChange={onChange} />;
    case 'close_ticket':
      return <Note>Closes the ticket with the reason &ldquo;Closed by Automation&rdquo;. The merchant isn&rsquo;t emailed. If the ticket is already closed, the step is skipped and the flow stops.</Note>;
    case 'open_ticket':
      return <OpenTicket step={step} onChange={onChange} hasEmailTrigger={hasEmailTrigger} />;
    case 'clear_awaiting':
      return <Note>Removes the Awaiting client tag from the ticket the flow is running on. If the tag isn&rsquo;t set, the step is skipped and the flow stops.</Note>;
    case 'lock':
    case 'hide':
    case 'unlock':
    case 'unhide':
      return <RestrictionFields step={step} catalog={catalog} onChange={onChange} />;
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
                {kind === 'ticket' || step.who === 'user' ? <option value="user">A specific user</option> : null}
              </select>
            </label>
            {step.who === 'team' ? <Pick label="Team" value={step.teamId} onChange={(teamId) => onChange({ ...step, teamId })} options={teamOptions(catalog)} /> : null}
            {step.who === 'user' ? <Pick label="User" value={step.userId} onChange={(userId) => onChange({ ...step, userId })} options={catalog.users} /> : null}
          </Row>
          <Text label="Message (optional)" value={step.message} placeholder="Says which automation ran, if left empty" onChange={(message) => onChange({ ...step, message })} />
          <p className="text-[12px] text-ink-500">Notifications panel only, no email.</p>
        </div>
      );
  }
}
