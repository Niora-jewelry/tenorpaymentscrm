/**
 * What an automation is made of: the step types, their shape, and what makes
 * one complete. No server code, so the builder uses the same rules the server
 * enforces. Modules, tabs and fields are ids and keys in here, never names.
 */
import { z } from 'zod';

export const MAX_STEPS = 10;

export const TRIGGERS = {
  status: { label: 'Status changes', inModule: true },
  stage: { label: 'Pipeline stage changes', inModule: true },
  email_received: { label: 'Email from contact received', inModule: false },
  email_sent: { label: 'Email to contact sent', inModule: false },
  team_assigned: { label: 'Team assigned', inModule: true },
  team_removed: { label: 'Team removed', inModule: true },
  application_sent: { label: 'Application sent', inModule: false },
  application_received: { label: 'Application received', inModule: false },
  contract_sent: { label: 'Contract sent', inModule: false },
  contract_received: { label: 'Contract received', inModule: false },
  field: { label: 'Field changed', inModule: true },
  module_assigned: { label: 'Module assigned', inModule: true },
  module_removed: { label: 'Module removed', inModule: true },
} as const;
export type TriggerType = keyof typeof TRIGGERS;

export const CONDITIONS = {
  field_filled: 'Field is filled',
  all_filled: 'All fields filled',
  status_is: 'Status is',
  pipeline_is: 'Pipeline is',
  in_module: 'Only in module',
  date_is: 'Date is',
  days_from: 'Days from date',
} as const;
export type ConditionType = keyof typeof CONDITIONS;

export const ACTIONS = {
  change_stage: 'Change pipeline stage',
  change_status: 'Change status',
  send_email: 'Send email',
  assign_team: 'Assign team',
  assign_user: 'Assign specific user',
  round_robin: 'Assign by round robin',
  remove_team: 'Remove team',
  add_module: 'Add to module',
  remove_module: 'Remove from module',
  create_ticket: 'Create ticket',
  send_notification: 'Send notification',
} as const;
export type ActionType = keyof typeof ACTIONS;

export const STATUSES = {
  draft: { label: 'Draft', meaning: 'Being built. Never runs.' },
  test: { label: 'Test', meaning: 'Runs for real, but only on one record you pick.' },
  on: { label: 'On', meaning: 'Runs on every record that matches.' },
  off: { label: 'Off', meaning: 'Saved but not running.' },
} as const;
export type AutomationStatus = keyof typeof STATUSES;

// ── shape ────────────────────────────────────────────────────────────────────
// A Draft may be half built, so a blank choice parses. `problemsIn` is what
// stands between a Draft and running.
const id = z.string().min(1).max(40);
const pick = z.string().max(200).default('');
const tag = <T extends string>(t: T) => z.literal(t);

export const triggerSchema = z.discriminatedUnion('type', [
  z.object({ id, type: tag('status'), value: pick }),
  z.object({ id, type: tag('stage'), pipelineId: pick, stepId: pick }),
  z.object({ id, type: tag('email_received') }),
  z.object({ id, type: tag('email_sent') }),
  z.object({ id, type: tag('team_assigned'), teamId: pick }),
  z.object({ id, type: tag('team_removed'), teamId: pick }),
  z.object({ id, type: tag('application_sent') }),
  z.object({ id, type: tag('application_received') }),
  z.object({ id, type: tag('contract_sent') }),
  z.object({ id, type: tag('contract_received') }),
  z.object({ id, type: tag('field'), field: pick, value: z.string().max(500).default('') }),
  z.object({ id, type: tag('module_assigned'), moduleId: pick }),
  z.object({ id, type: tag('module_removed'), moduleId: pick }),
]);
export type TriggerStep = z.infer<typeof triggerSchema>;

export const conditionSchema = z.discriminatedUnion('type', [
  z.object({ id, type: tag('field_filled'), field: pick, fileRow: pick }),
  z.object({ id, type: tag('all_filled'), tabId: pick, subtabId: pick }),
  z.object({ id, type: tag('status_is'), value: pick }),
  z.object({ id, type: tag('pipeline_is'), pipelineId: pick }),
  z.object({ id, type: tag('in_module'), moduleId: pick }),
  z.object({ id, type: tag('date_is'), field: pick, op: z.enum(['before', 'after', 'on']).default('on'), date: pick }),
  z.object({ id, type: tag('days_from'), field: pick, days: z.number().int().min(0).max(3650).default(0), direction: z.enum(['before', 'after']).default('after') }),
]);
export type ConditionStep = z.infer<typeof conditionSchema>;

const join = z.enum(['and', 'or']).default('and');
export const conditionsSchema = z.object({
  join,
  groups: z.array(z.object({ id, join, conditions: z.array(conditionSchema).max(MAX_STEPS) })).max(MAX_STEPS),
});
export type Conditions = z.infer<typeof conditionsSchema>;

const emailStep = z.object({
  id,
  type: tag('send_email'),
  mailboxId: pick,
  to: z.enum(['main_contact', 'owners', 'custom']).default('main_contact'),
  customTo: z.string().max(500).default(''),
  subject: z.string().max(255).default(''),
  body: z.string().max(20000).default(''),
  fileIds: z.array(z.string().max(40)).max(10).default([]),
  fileRows: z.array(z.string().max(120)).max(5).default([]),
});
export type EmailStep = z.infer<typeof emailStep>;

export const flowStepSchema = z.discriminatedUnion('type', [
  z.object({ id, type: tag('wait'), amount: z.number().int().min(1).max(3650).default(1), unit: z.enum(['hours', 'days']).default('hours') }),
  z.object({ id, type: tag('change_stage'), moduleId: pick, pipelineId: pick, stepId: pick }),
  z.object({ id, type: tag('change_status'), value: pick }),
  emailStep,
  z.object({ id, type: tag('assign_team'), teamId: pick }),
  z.object({ id, type: tag('assign_user'), userId: pick }),
  z.object({ id, type: tag('round_robin'), teamIds: z.array(z.string().max(40)).max(50).default([]), userIds: z.array(z.string().max(40)).max(200).default([]) }),
  z.object({ id, type: tag('remove_team'), teamId: pick }),
  z.object({ id, type: tag('add_module'), moduleId: pick }),
  z.object({ id, type: tag('remove_module'), moduleId: pick }),
  z.object({ id, type: tag('create_ticket'), title: z.string().max(200).default(''), issue: z.string().max(5000).default('') }),
  z.object({ id, type: tag('send_notification'), who: z.enum(['team_members', 'team', 'relationship_manager']).default('team_members'), teamId: pick, message: z.string().max(500).default('') }),
]);
export type FlowStep = z.infer<typeof flowStepSchema>;

export const stepsSchema = z.object({
  triggers: z.array(triggerSchema).max(MAX_STEPS),
  conditions: conditionsSchema,
  flow: z.array(flowStepSchema).max(MAX_STEPS),
});
export type AutomationSteps = z.infer<typeof stepsSchema>;

export const EMPTY_STEPS: AutomationSteps = { triggers: [], conditions: { join: 'and', groups: [] }, flow: [] };

// ── rules ────────────────────────────────────────────────────────────────────
export const conditionsIn = (s: AutomationSteps): ConditionStep[] => s.conditions.groups.flatMap((g) => g.conditions);

/** Spec: every trigger, condition, wait and action counts. */
export const stepCount = (s: AutomationSteps): number => s.triggers.length + conditionsIn(s).length + s.flow.length;

/** Spec: "Only in module" can't be added when the trigger doesn't happen in a module. With several triggers, any one of them rules it out. */
export const everyTriggerInModule = (s: AutomationSteps): boolean => s.triggers.every((t) => TRIGGERS[t.type].inModule);

/** Spec: for email, application and contract triggers, the admin picks the module of a stage change. */
export const stageNeedsModule = (s: AutomationSteps): boolean => s.triggers.some((t) => !TRIGGERS[t.type].inModule);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const customAddresses = (s: string): string[] => s.split(/[,;\s]+/).map((a) => a.trim()).filter(Boolean);

function triggerProblem(t: TriggerStep): string | null {
  switch (t.type) {
    case 'status':
      return t.value ? null : 'Status changes: choose the status.';
    case 'stage':
      return t.stepId ? null : 'Pipeline stage changes: choose the pipeline and stage.';
    case 'team_assigned':
    case 'team_removed':
      return t.teamId ? null : `${TRIGGERS[t.type].label}: choose the team.`;
    case 'field':
      return t.field ? null : 'Field changed: choose the field.';
    case 'module_assigned':
    case 'module_removed':
      return t.moduleId ? null : `${TRIGGERS[t.type].label}: choose the module.`;
    default:
      return null;
  }
}

function conditionProblem(c: ConditionStep): string | null {
  switch (c.type) {
    case 'field_filled':
      return c.field || c.fileRow ? null : 'Field is filled: choose the field.';
    case 'all_filled':
      return c.tabId ? null : 'All fields filled: choose the tab or sub-tab.';
    case 'status_is':
      return c.value ? null : 'Status is: choose the status.';
    case 'pipeline_is':
      return c.pipelineId ? null : 'Pipeline is: choose the pipeline.';
    case 'in_module':
      return c.moduleId ? null : 'Only in module: choose the module.';
    case 'date_is':
      return c.field && c.date ? null : 'Date is: choose the date field and the date.';
    case 'days_from':
      return c.field ? null : 'Days from date: choose the date field.';
  }
}

function flowProblem(s: FlowStep, needsModule: boolean): string | null {
  switch (s.type) {
    case 'change_stage':
      if (needsModule && !s.moduleId) return 'Change pipeline stage: choose the module.';
      return s.stepId ? null : 'Change pipeline stage: choose the stage.';
    case 'change_status':
      return s.value ? null : 'Change status: choose the status.';
    case 'send_email': {
      if (!s.mailboxId) return 'Send email: choose the inbox it sends from.';
      if (s.to === 'custom') {
        const list = customAddresses(s.customTo);
        if (!list.length || !list.every((a) => EMAIL.test(a))) return 'Send email: enter a valid email address.';
      }
      if (!s.subject.trim()) return 'Send email: write a subject.';
      return s.body.trim() ? null : 'Send email: write the body.';
    }
    case 'assign_team':
    case 'remove_team':
      return s.teamId ? null : `${ACTIONS[s.type]}: choose the team.`;
    case 'assign_user':
      return s.userId ? null : 'Assign specific user: choose the user.';
    case 'round_robin':
      return s.teamIds.length || s.userIds.length ? null : 'Assign by round robin: choose who is in the rotation.';
    case 'add_module':
    case 'remove_module':
      return s.moduleId ? null : `${ACTIONS[s.type]}: choose the module.`;
    case 'create_ticket':
      return s.issue.trim() ? null : 'Create ticket: write the Issue.';
    case 'send_notification':
      return s.who !== 'team' || s.teamId ? null : 'Send notification: choose the team.';
    default:
      return null;
  }
}

/** Why this can't run yet. Empty means it can go to Test or On. */
export function problemsIn(s: AutomationSteps): string[] {
  const out: string[] = [];
  if (stepCount(s) > MAX_STEPS) out.push(`An automation can have up to ${MAX_STEPS} steps.`);
  if (s.triggers.length === 0) out.push('Add a trigger.');
  if (!s.flow.some((f) => f.type !== 'wait')) out.push('Add an action.');
  if (conditionsIn(s).some((c) => c.type === 'in_module') && !everyTriggerInModule(s)) {
    out.push('“Only in module” can’t be used with an email, application or contract trigger.');
  }
  const needsModule = stageNeedsModule(s);
  for (const t of s.triggers) { const p = triggerProblem(t); if (p) out.push(p); }
  for (const c of conditionsIn(s)) { const p = conditionProblem(c); if (p) out.push(p); }
  for (const f of s.flow) { const p = flowProblem(f, needsModule); if (p) out.push(p); }
  return [...new Set(out)];
}
