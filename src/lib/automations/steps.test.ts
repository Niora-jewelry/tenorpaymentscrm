import { describe, expect, it } from 'vitest';
import { everyTriggerInModule, MAX_STEPS, problemsIn, stageNeedsModule, stepCount, stepsSchema, TRIGGERS, type AutomationSteps } from './steps';

const u = '11111111-1111-4111-8111-111111111111';

const steps = (over: Partial<AutomationSteps> = {}): AutomationSteps =>
  stepsSchema.parse({
    triggers: [{ id: 't', type: 'application_received' }],
    conditions: { join: 'and', groups: [] },
    flow: [{ id: 'a', type: 'assign_team', teamId: u }],
    ...over,
  });

const email = { id: 'e', type: 'send_email', mailboxId: u, subject: 'Hi', body: 'Hello' };

describe('the spec\'s own example', () => {
  it('counts five steps and is complete', () => {
    const s = steps({
      conditions: { join: 'and', groups: [{ id: 'g', join: 'and', conditions: [{ id: 'c', type: 'all_filled', tabId: u, subtabId: '' }] }] },
      flow: stepsSchema.shape.flow.parse([{ id: 'w', type: 'wait', amount: 2, unit: 'hours' }, { id: 'a', type: 'assign_team', teamId: u }, email]),
    });
    expect(stepCount(s)).toBe(5);
    expect(problemsIn(s)).toEqual([]);
  });
});

describe('triggers and modules', () => {
  it('marks exactly the email, application and contract triggers as outside a module', () => {
    const outside = Object.entries(TRIGGERS).filter(([, t]) => !t.inModule).map(([k]) => k).sort();
    expect(outside).toEqual(['application_received', 'application_sent', 'contract_received', 'contract_sent', 'email_received', 'email_sent']);
  });

  it('refuses Only in module with a trigger outside a module', () => {
    const s = steps({ conditions: { join: 'and', groups: [{ id: 'g', join: 'and', conditions: [{ id: 'c', type: 'in_module', moduleId: u }] }] } });
    expect(problemsIn(s).join()).toMatch(/Only in module/);
  });

  it('allows Only in module when every trigger happens in a module', () => {
    const s = steps({
      triggers: [{ id: 't', type: 'module_assigned', moduleId: u }],
      conditions: { join: 'and', groups: [{ id: 'g', join: 'and', conditions: [{ id: 'c', type: 'in_module', moduleId: u }] }] },
    });
    expect(everyTriggerInModule(s)).toBe(true);
    expect(problemsIn(s)).toEqual([]);
  });

  it('rules it out if any one of several triggers is outside a module', () => {
    const s = steps({ triggers: [{ id: 'a', type: 'module_assigned', moduleId: u }, { id: 'b', type: 'email_received' }] });
    expect(everyTriggerInModule(s)).toBe(false);
  });

  it('asks for the module of a stage change only when a trigger has none', () => {
    const flow = stepsSchema.shape.flow.parse([{ id: 's', type: 'change_stage', stepId: u, pipelineId: u }]);
    expect(stageNeedsModule(steps({ flow }))).toBe(true);
    expect(problemsIn(steps({ flow })).join()).toMatch(/choose the module/);
    expect(problemsIn(steps({ flow, triggers: [{ id: 't', type: 'module_assigned', moduleId: u }] }))).toEqual([]);
  });
});

describe('what stands between a Draft and running', () => {
  it('needs a trigger and an action; a wait is not an action', () => {
    expect(problemsIn(steps({ triggers: [] }))).toContain('Add a trigger.');
    const flow = stepsSchema.shape.flow.parse([{ id: 'w', type: 'wait' }]);
    expect(problemsIn(steps({ flow }))).toContain('Add an action.');
  });

  it('parses a half-built step, and reports it', () => {
    const s = steps({ triggers: stepsSchema.shape.triggers.parse([{ id: 't', type: 'status' }]) });
    expect(problemsIn(s)).toEqual(['Status changes: choose the status.']);
  });

  it('counts every step against the limit', () => {
    const flow = stepsSchema.shape.flow.parse(Array.from({ length: MAX_STEPS }, (_, i) => ({ id: `a${i}`, type: 'assign_team', teamId: u })));
    expect(stepCount(steps({ flow }))).toBe(MAX_STEPS + 1);
    expect(problemsIn(steps({ flow }))[0]).toMatch(/up to 10/);
  });

  it('requires the Issue of a ticket but not its Title', () => {
    const flow = (issue: string) => stepsSchema.shape.flow.parse([{ id: 'a', type: 'create_ticket', issue }]);
    expect(problemsIn(steps({ flow: flow('') })).join()).toMatch(/write the Issue/);
    expect(problemsIn(steps({ flow: flow('Please check') }))).toEqual([]);
  });

  it('checks a custom email address', () => {
    const flow = (customTo: string) => stepsSchema.shape.flow.parse([{ ...email, to: 'custom', customTo }]);
    expect(problemsIn(steps({ flow: flow('nope') })).join()).toMatch(/valid email/);
    expect(problemsIn(steps({ flow: flow('a@b.co, c@d.co') }))).toEqual([]);
  });

  it('needs someone in a rotation', () => {
    const flow = stepsSchema.shape.flow.parse([{ id: 'r', type: 'round_robin' }]);
    expect(problemsIn(steps({ flow })).join()).toMatch(/who is in the rotation/);
  });
});
