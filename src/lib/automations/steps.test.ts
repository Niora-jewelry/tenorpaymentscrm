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
  it('marks exactly the email, application, contract, File uploaded and ticket triggers as outside a module', () => {
    const outside = Object.entries(TRIGGERS).filter(([, t]) => !t.inModule).map(([k]) => k).sort();
    expect(outside).toEqual(['application_received', 'application_sent', 'awaiting_client', 'contract_received', 'contract_sent', 'email_received', 'email_sent', 'file_uploaded', 'ticket_email'].sort());
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

describe('ticket automations (Ticket Automation Flow Builder spec)', () => {
  const cond = (...types: string[]) => ({ join: 'and' as const, groups: [{ id: 'g', join: 'and' as const, conditions: types.map((type, i) => ({ id: `c${i}`, type })) }] });
  const ticketSteps = (over: Record<string, unknown>) => stepsSchema.parse({ triggers: [], conditions: { join: 'and', groups: [] }, flow: [], ...over });
  const button = [{ id: 'b', type: 'awaiting_client' }];
  const inbox = [{ id: 'e', type: 'ticket_email', mailboxId: u }];

  it('the spec’s first example is complete: button, wait, condition, email, wait, close', () => {
    const s = ticketSteps({
      triggers: button,
      conditions: cond('ticket_open'),
      flow: [{ id: 'w1', type: 'wait', amount: 3, unit: 'days' }, { ...email, subject: 'Just checking in' }, { id: 'w2', type: 'wait', amount: 4, unit: 'days' }, { id: 'c', type: 'close_ticket' }],
    });
    expect(problemsIn(s, 'ticket')).toEqual([]);
    expect(stepCount(s)).toBe(6);
  });

  it('the spec’s second example is complete: email, not open, open ticket, team, notify', () => {
    const s = ticketSteps({
      triggers: inbox,
      conditions: cond('ticket_not_open'),
      flow: [{ id: 'o', type: 'open_ticket', issue: '{Email body}' }, { id: 'a', type: 'assign_team', teamId: u }, { id: 'n', type: 'send_notification', who: 'relationship_manager' }],
    });
    expect(problemsIn(s, 'ticket')).toEqual([]);
  });

  it('an Email received flow needs exactly one of the two ticket conditions', () => {
    const flow = [{ id: 'n', type: 'send_notification', who: 'relationship_manager' }];
    expect(problemsIn(ticketSteps({ triggers: inbox, flow }), 'ticket').join()).toMatch(/exactly one/);
    expect(problemsIn(ticketSteps({ triggers: inbox, flow, conditions: cond('ticket_open', 'ticket_not_open') }), 'ticket').join()).toMatch(/exactly one/);
    expect(problemsIn(ticketSteps({ triggers: inbox, flow, conditions: cond('ticket_open') }), 'ticket')).toEqual([]);
  });

  it('needs the inbox, and one inbox per flow', () => {
    const flow = [{ id: 'n', type: 'send_notification', who: 'relationship_manager' }];
    expect(problemsIn(ticketSteps({ triggers: [{ id: 'e', type: 'ticket_email' }], flow, conditions: cond('ticket_open') }), 'ticket').join()).toMatch(/choose the inbox/);
    expect(problemsIn(ticketSteps({ triggers: [...inbox, { id: 'f', type: 'ticket_email', mailboxId: u }], flow, conditions: cond('ticket_open') }), 'ticket').join()).toMatch(/only one inbox/);
  });

  it('Open ticket only with And ticket is not open', () => {
    const flow = [{ id: 'o', type: 'open_ticket', issue: 'x' }];
    expect(problemsIn(ticketSteps({ triggers: inbox, flow, conditions: cond('ticket_open') }), 'ticket').join()).toMatch(/Open ticket is only available/);
  });

  it('Email connects to a record, and the email variables, need Email received', () => {
    expect(problemsIn(ticketSteps({ triggers: button, conditions: cond('email_connects'), flow: [{ id: 'c', type: 'close_ticket' }] }), 'ticket').join()).toMatch(/only with Email received/);
    expect(problemsIn(ticketSteps({ triggers: button, flow: [{ ...email, body: 'You wrote: {Email body}' }] }), 'ticket').join()).toMatch(/\{Email subject\} and \{Email body\}/);
  });

  it('Notify user needs the user when it names one', () => {
    expect(problemsIn(ticketSteps({ triggers: button, flow: [{ id: 'n', type: 'send_notification', who: 'user' }] }), 'ticket').join()).toMatch(/Notify user: choose the user/);
  });

  it('each builder refuses the other’s steps, and uses its own words', () => {
    expect(problemsIn(ticketSteps({ triggers: button, flow: [{ id: 's', type: 'change_status', value: 'x' }] }), 'ticket').join()).toMatch(/isn’t available in Ticket automations/);
    expect(problemsIn(steps({ flow: stepsSchema.shape.flow.parse([{ id: 'c', type: 'close_ticket' }]) })).join()).toMatch(/isn’t available in Record automations/);
    expect(problemsIn(ticketSteps({ triggers: button, flow: [{ ...email, subject: '' }] }), 'ticket').join()).toMatch(/Send merchant an email: write a subject/);
  });
});
