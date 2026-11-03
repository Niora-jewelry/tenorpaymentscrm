/**
 * Ticket automations (Ticket Automation Flow Builder spec, 1 Nov 2026) — the
 * database half, one test per rule, driven by real writes as real signed-in
 * viewers inside one transaction that is always rolled back. `automation_work`
 * is called the way the tick calls it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;
let db: pg.Client;

type Row = Record<string, unknown>;
const q = async <T = Row>(sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as T[];
const one = async <T = Row>(sql: string, p: unknown[] = []) => (await q<T>(sql, p))[0]!;

type Step = Record<string, unknown>;
type Flow = { triggers?: Step[]; conditions?: { join: string; groups: { id: string; join: string; conditions: Step[] }[] }; flow?: Step[] };
type Run = { id: string; status: string; reason: string | null; case_id: string | null; case_label: string | null; record_id: string | null };

const sid = () => randomUUID().slice(0, 8);
const cond = (...types: string[]) => ({ join: 'and', groups: [{ id: sid(), join: 'and', conditions: types.map((type) => ({ id: sid(), type })) }] });

suite('Ticket automations', () => {
  const team: Record<string, string> = {};
  let member: string;
  let leads: string;
  let tickets: string;
  let builder: string;
  let agent: string;
  let manager: string;
  let other: string;
  let mailbox: string;
  let otherInbox: string;
  let identity: string;
  const main = `main-${sid()}@client.test`;
  const owner = `owner-${sid()}@client.test`;

  const as = async <T>(user: string, fn: () => Promise<T>): Promise<T> => {
    await q(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
    const result = await fn();
    await q(`select set_config('request.jwt.claims', '', true), set_config('role', 'none', true)`);
    return result;
  };
  /** A refusal, inside a savepoint: the error, and the transaction (and who we were) as before it. */
  const refused = async (fn: () => Promise<unknown>): Promise<string> => {
    await q('savepoint refused');
    try {
      await fn();
    } catch (e) {
      await q('rollback to savepoint refused');
      return e instanceof Error ? e.message : String(e);
    }
    await q('release savepoint refused');
    return 'not refused';
  };
  const setting = (user: string, key: string, value: string) =>
    q(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, $2, $3)
       on conflict (owner_kind, owner_id, key) do update set value = excluded.value`, [user, key, value]);
  const newUser = async (name: string, type: string) => {
    const id = randomUUID();
    const email = `zz-${id.slice(0, 8)}@tapdash.test`;
    await q(`insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')`, [id, email]);
    await q(
      `insert into profiles (id, email, full_name, role_id, status) values ($1, $2, $3, $4, 'active')
       on conflict (id) do update set full_name = excluded.full_name, role_id = excluded.role_id, status = 'active'`,
      [id, email, name, member],
    );
    await q(`insert into user_templates (user_id, template_id) values ($1, $2) on conflict (user_id) do update set template_id = excluded.template_id`, [id, team[type]]);
    await setting(id, `module:${leads}`, 'all');
    await setting(id, 'items.cases', 'all');
    return id;
  };
  const record = async (contactEmail = main, ownerEmail = owner) => {
    // One record per address, as a real client has: an address on two records matches neither.
    await q(`update records set values = values - 'contact' - 'owner_ownership'
              where id in (select record_id from record_contact_emails where email = any ($1::citext[]))`, [[contactEmail, ownerEmail]]);
    const values = { contact: [{ name: 'Mia Main', email: contactEmail }], owner_ownership: [{ first: 'Oz', last: 'Owner', email: ownerEmail }], team_members_assigned: [agent] };
    const { id } = await one<{ id: string }>(`insert into records (deal_name, creator_user_id, values) values ($1, $2, $3) returning id`, [`ZZ ${sid()}`, builder, values]);
    await q(`insert into record_modules (record_id, module_id) values ($1, $2)`, [id, leads]);
    return id;
  };
  const ticket = async (rec: string, title = 'Statement question', managers: string[] = [manager]) => {
    const c = await one<{ id: string; number: number }>(
      `insert into cases (record_id, title, issue, issue_author) values ($1, $2, 'The client asked about fees.', $3) returning id, number`,
      [rec, title, builder],
    );
    for (const m of managers) await q(`insert into case_managers (case_id, user_id) values ($1, $2)`, [c.id, m]);
    return c;
  };
  const flow = async (f: Flow, status = 'on', testCase: string | null = null) => {
    const steps = { triggers: [], conditions: { join: 'and', groups: [] }, flow: [], ...f };
    const { id } = await one<{ id: string }>(`select automation_save(null, $1, $2, '{}', '{}', false, $3) as id`, [`ZZ ticket flow ${sid()}`, steps, builder]);
    await q(`update automations set kind = 'ticket' where id = $1`, [id]);
    if (status !== 'draft') await q(`select automation_set_status($1, $2, null, $3, $4)`, [id, status, builder, testCase]);
    return id;
  };
  const click = (user: string, caseId: string, on = true) => as(user, () => one<{ changed: boolean }>(`select set_awaiting_client($1, $2) as changed`, [caseId, on]));
  const email = async (from: string, over: { box?: string; subject?: string; body?: string; imid?: string } = {}) => {
    const id = randomUUID();
    await q(
      `insert into mail_messages (mailbox_id, graph_id, internet_message_id, conversation_id, from_address, from_name, subject, body_text, to_recipients, cc_recipients, bcc_recipients, received_at, is_draft, direction)
       values ($1, $2, $3, $2, $4, 'Mia Main', $5, $6, '[]', '[]', '[]', now(), false, 'inbound') returning id`,
      [over.box ?? mailbox, id, over.imid ?? `<${id}@client.test>`, from, over.subject ?? 'Fees on my statement', over.body ?? 'Why was I charged twice?'],
    );
    return (await one<{ id: string }>(`select id from mail_messages where graph_id = $1`, [id])).id;
  };
  const work = async () => {
    const rows = await q<{ run_id: string | null; step: Step | null }>(`select * from automation_work(50)`);
    await q(`select set_config('tapdash.automation', '', true), set_config('tapdash.event_actor', '', true)`);
    return rows.filter((r) => r.run_id);
  };
  const runs = (a: string) => q<Run>(`select id, status, reason, case_id, case_label, record_id from automation_runs where automation_id = $1 order by started_at`, [a]);
  const lastRun = async (a: string) => (await runs(a)).at(-1)!;
  const caseRow = (id: string) => one<{ state: string; solution: string | null; awaiting_client_at: string | null }>(`select state, solution, awaiting_client_at from cases where id = $1`, [id]);
  const log = (caseId: string) => q<{ body: string; actor_id: string | null; automation_name: string | null }>(`select body, actor_id, automation_name from case_log where case_id = $1 order by created_at`, [caseId]);

  beforeAll(async () => {
    db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
    await db.connect();
    await q('begin');
    for (const t of await q<{ id: string; user_type: string }>(`select id, user_type from permission_templates where user_type is not null`)) team[t.user_type] = t.id;
    member = (await one<{ id: string }>(`select id from roles where not is_admin order by name limit 1`)).id;
    leads = (await one<{ id: string }>(`select id from modules where slug = 'leads'`)).id;
    tickets = (await one<{ id: string }>(`select id from modules where shows_open_cases limit 1`)).id;
    builder = await newUser('Bea Builder', 'admin');
    agent = await newUser('Sal Sales', 'sales_agent');
    manager = await newUser('Una Underwriter', 'underwriter');
    other = await newUser('Cal Customer', 'customer_service');
    identity = (await one<{ id: string }>(`insert into mail_identities (user_id, microsoft_user_id, primary_email) values ($1, $2, 'zz@x.test') returning id`, [builder, randomUUID()])).id;
    const box = async () => {
      const id = (await one<{ id: string }>(
        `insert into mail_mailboxes (kind, address, seeded_at, sync_identity_id) values ('shared', $1, now() - interval '1 hour', $2) returning id`,
        [`zz-support-${sid()}@x.test`, identity],
      )).id;
      await q(`insert into mail_connections (user_id, mailbox_id, identity_id, status) values ($1, $2, $3, 'ok')`, [builder, id, identity]);
      return id;
    };
    mailbox = await box();
    otherInbox = await box();
  }, 60_000);

  afterEach(async () => {
    await q(`select set_config('tapdash.automation', '', true)`);
    await q(`update automations set status = 'off' where kind = 'ticket' and status in ('on', 'test')`);
    await q(`delete from automation_triggers`);
    await q(`delete from automation_queue`);
    await q(`update automation_runs set status = 'cancelled' where status in ('running', 'waiting', 'sending', 'choosing')`);
  });

  afterAll(async () => {
    await q('rollback');
    await db.end();
  });

  // ── the button ─────────────────────────────────────────────────────────────
  describe('Awaiting client', () => {
    it('sets the tag on the ticket, logs it with the person’s name, and starts the flow on that ticket only', async () => {
      const a = await flow({ triggers: [{ id: 't', type: 'awaiting_client' }], flow: [{ id: 'x', type: 'clear_awaiting' }] });
      const rec = await record();
      const t1 = await ticket(rec, 'One');
      const t2 = await ticket(rec, 'Two');
      await click(agent, t2.id);
      expect((await click(agent, t1.id)).changed).toBe(true);
      expect((await caseRow(t1.id)).awaiting_client_at).not.toBeNull();
      expect((await log(t1.id))[0]).toMatchObject({ body: 'Marked Awaiting client.', actor_id: agent, automation_name: null });
      const upd = await one<{ author_id: string; body: string }>(`select author_id, body from updates where record_id = $1 and body like 'Marked ticket #%' order by created_at desc limit 1`, [rec]);
      expect(upd).toMatchObject({ author_id: agent, body: `Marked ticket #${t1.number} Awaiting client.` });

      await work();
      const r = (await runs(a)).find((x) => x.case_id === t1.id)!;
      expect(r.status).toBe('completed');
      expect((await caseRow(t1.id)).awaiting_client_at).toBeNull();
      expect((await caseRow(t2.id)).awaiting_client_at).toBeNull();
      // The flow on t2 cleared t2: each click is its own ticket's run.
      expect((await runs(a)).map((x) => x.case_id).sort()).toEqual([t1.id, t2.id].sort());
      expect((await log(t1.id)).map((l) => l.automation_name)).toContain((await one<{ name: string }>(`select name from automations where id = $1`, [a])).name);
    });

    it('does nothing on a ticket already tagged, and starts no flow', async () => {
      const a = await flow({ triggers: [{ id: 't', type: 'awaiting_client' }], flow: [{ id: 'x', type: 'clear_awaiting' }] });
      const rec = await record();
      const t = await ticket(rec);
      await click(agent, t.id);
      await q(`delete from automation_queue`);
      expect((await click(manager, t.id)).changed).toBe(false);
      expect((await one<{ n: number }>(`select count(*)::int n from automation_queue where automation_id = $1`, [a])).n).toBe(0);
    });

    it('needs Use Awaiting client, which is Yes for every user type by default; the tag is seen without it', async () => {
      const types = await q<{ value: string }>(`select value from permission_settings ps join permission_templates pt on pt.id = ps.owner_id
                                                   where ps.owner_kind = 'template' and ps.key = 'action.awaiting_client' and pt.user_type is not null`);
      expect(types.length).toBe(Object.keys(team).length);
      expect(new Set(types.map((t) => t.value))).toEqual(new Set(['yes']));

      const rec = await record();
      const t = await ticket(rec);
      await setting(other, 'action.awaiting_client', 'no');
      expect(await refused(() => click(other, t.id))).toMatch(/permission to use Awaiting client/);
      await click(agent, t.id);
      const seen = await as(other, () => one<{ at: string | null }>(`select awaiting_client_at::text as at from cases where id = $1`, [t.id]));
      expect(seen.at).not.toBeNull();
      expect(await refused(() => click(other, t.id, false))).toMatch(/permission/);
      expect((await click(agent, t.id, false)).changed).toBe(true);
      expect((await log(t.id)).at(-1)).toMatchObject({ body: 'Cleared Awaiting client.', actor_id: agent });
    });

    it('is refused on a closed ticket and on one the person can’t open', async () => {
      const rec = await record();
      const t = await ticket(rec);
      await q(`update cases set solution = 'Done', state = 'closed' where id = $1`, [t.id]);
      expect(await refused(() => click(agent, t.id))).toMatch(/Only an open ticket/);
      const hidden = await ticket(await record());
      await setting(other, 'items.cases', 'hidden');
      expect(await refused(() => click(other, hidden.id))).toMatch(/not found/);
      await setting(other, 'items.cases', 'all');
    });

    it('reacts only to clicks after it is switched on', async () => {
      const rec = await record();
      const t = await ticket(rec);
      const a = await flow({ triggers: [{ id: 't', type: 'awaiting_client' }], flow: [{ id: 'x', type: 'clear_awaiting' }] }, 'draft');
      await click(agent, t.id);
      await q(`select automation_set_status($1, 'on', null, $2)`, [a, builder]);
      await work();
      expect(await runs(a)).toEqual([]);
    });

    it('Test runs on the one ticket chosen', async () => {
      const rec = await record();
      const chosen = await ticket(rec, 'Chosen');
      const notChosen = await ticket(rec, 'Not chosen');
      const a = await flow({ triggers: [{ id: 't', type: 'awaiting_client' }], flow: [{ id: 'x', type: 'clear_awaiting' }] }, 'test', chosen.id);
      expect(await one(`select test_case_id, test_record_id from automations where id = $1`, [a])).toEqual({ test_case_id: chosen.id, test_record_id: rec });
      await click(agent, notChosen.id);
      await click(agent, chosen.id);
      await work();
      expect((await runs(a)).map((r) => r.case_id)).toEqual([chosen.id]);
    });
  });

  // ── actions ────────────────────────────────────────────────────────────────
  describe('actions', () => {
    it('Close ticket closes with “Closed by Automation”; on a closed ticket it is skipped, the flow stops and the builder is alerted', async () => {
      const a = await flow({ triggers: [{ id: 't', type: 'awaiting_client' }], flow: [{ id: 'c1', type: 'close_ticket' }, { id: 'c2', type: 'close_ticket' }] });
      const rec = await record();
      const t = await ticket(rec);
      await click(agent, t.id);
      await work();
      expect(await caseRow(t.id)).toMatchObject({ state: 'closed', solution: 'Closed by Automation' });
      const r = await lastRun(a);
      expect(r.status).toBe('skipped');
      expect(r.reason).toMatch(/already closed/);
      expect((await one<{ n: number }>(`select count(*)::int n from notifications where automation_run_id = $1 and source_kind = 'automation_alert' and recipient_id = $2`, [r.id, builder])).n).toBe(1);
      expect((await log(t.id)).map((l) => l.body)).toContain(`Closed ticket #${t.number}: Closed by Automation.`);
    });

    it('Close ticket keeps a Solution a person already wrote', async () => {
      await flow({ triggers: [{ id: 't', type: 'awaiting_client' }], flow: [{ id: 'c1', type: 'close_ticket' }] });
      const rec = await record();
      const t = await ticket(rec);
      await q(`update cases set solution = 'Refunded the double charge.' where id = $1`, [t.id]);
      await click(agent, t.id);
      await work();
      expect(await caseRow(t.id)).toMatchObject({ state: 'closed', solution: 'Refunded the double charge.' });
    });

    it('Clear Awaiting client is skipped when the tag isn’t set', async () => {
      const a = await flow({ triggers: [{ id: 't', type: 'awaiting_client' }], flow: [{ id: 'x', type: 'clear_awaiting' }, { id: 'y', type: 'clear_awaiting' }] });
      const rec = await record();
      const t = await ticket(rec);
      await click(agent, t.id);
      await work();
      expect(await lastRun(a)).toMatchObject({ status: 'skipped' });
      expect((await lastRun(a)).reason).toMatch(/isn't marked Awaiting client/);
    });

    it('Notify user reaches one chosen user, with the ticket on the notification', async () => {
      const a = await flow({ triggers: [{ id: 't', type: 'awaiting_client' }], flow: [{ id: 'n', type: 'send_notification', who: 'user', userId: other, message: '' }] });
      const rec = await record();
      const t = await ticket(rec);
      await click(agent, t.id);
      await work();
      const n = await one<{ recipient_id: string; case_id: string; body: string }>(`select recipient_id, case_id, body from notifications where automation_run_id = $1`, [(await lastRun(a)).id]);
      expect(n).toMatchObject({ recipient_id: other, case_id: t.id });
      expect(n.body).toContain(`#${t.number}`);
    });

    it('Create a team assignment assigns the team, Open until taken, and logs it on the ticket', async () => {
      await flow({ triggers: [{ id: 't', type: 'awaiting_client' }], flow: [{ id: 'a', type: 'assign_team', teamId: team.customer_service }] });
      const rec = await record();
      const t = await ticket(rec);
      await click(agent, t.id);
      await work();
      expect(await one(`select taken_by from record_team_assignments where record_id = $1 and team_id = $2`, [rec, team.customer_service])).toEqual({ taken_by: null });
      expect((await log(t.id)).some((l) => /team/i.test(l.body) && l.automation_name)).toBe(true);
    });
  });

  // ── email ──────────────────────────────────────────────────────────────────
  describe('Email received', () => {
    const emailFlow = (conditions: string[], steps: Step[], box?: string) => flow({
      triggers: [{ id: 'e', type: 'ticket_email', mailboxId: box ?? mailbox }],
      conditions: cond(...conditions),
      flow: steps,
    });

    it('new issue by email: no open ticket → Open ticket, team assignment, Notify user; later steps act on the new ticket', async () => {
      const a = await emailFlow(['ticket_not_open', 'email_connects'], [
        { id: 'o', type: 'open_ticket', title: '{Email subject}', issue: 'From {Contact name} at {Merchant name}: {Email body}' },
        { id: 'a', type: 'assign_team', teamId: team.customer_service },
        { id: 'n', type: 'send_notification', who: 'team_members', teamId: '', userId: '', message: '' },
      ]);
      const rec = await record();
      await email(main, { subject: 'Card reader broken', body: 'It shows error 42.' });
      await work();
      const r = await lastRun(a);
      expect(r.status).toBe('completed');
      const c = await one<{ id: string; title: string; issue: string; issue_author: string | null; automation_name: string; state: string }>(
        `select id, title, issue, issue_author, automation_name, state from cases where record_id = $1`, [rec]);
      expect(c).toMatchObject({ title: 'Card reader broken', issue_author: null, state: 'open' });
      expect(c.issue).toContain('From Mia Main');
      expect(c.issue).toContain('It shows error 42.');
      expect(r.case_id).toBe(c.id);
      expect((await log(c.id)).length).toBe(3);
      expect(await one<{ n: number }>(`select count(*)::int n from record_modules where record_id = $1 and module_id = $2`, [rec, tickets])).toEqual({ n: 1 });
    });

    it('And ticket is not open is false while a ticket is open; Open ticket never makes a second one', async () => {
      const a = await emailFlow(['ticket_not_open'], [{ id: 'o', type: 'open_ticket', title: '', issue: 'x' }]);
      const rec = await record();
      await ticket(rec);
      await email(owner);
      await work();
      expect(await lastRun(a)).toMatchObject({ status: 'not_matched', reason: 'Conditions not met.' });
      expect((await one<{ n: number }>(`select count(*)::int n from cases where record_id = $1`, [rec])).n).toBe(1);
    });

    it('an email that matches no record runs nothing and opens no ticket', async () => {
      const a = await emailFlow(['ticket_not_open'], [{ id: 'o', type: 'open_ticket', title: '', issue: 'x' }]);
      await email(`stranger-${sid()}@nowhere.test`);
      await work();
      const r = await lastRun(a);
      expect(r.status).toBe('not_matched');
      expect(r.reason).toMatch(/matches no record/);
    });

    it('only the chosen inbox starts it', async () => {
      const a = await emailFlow(['ticket_not_open'], [{ id: 'o', type: 'open_ticket', title: '', issue: 'x' }]);
      await record();
      await email(main, { box: otherInbox });
      await work();
      expect(await runs(a)).toEqual([]);
    });

    it('an email the CRM sent itself never starts a flow', async () => {
      const a = await emailFlow(['ticket_not_open'], [{ id: 'o', type: 'open_ticket', title: '', issue: 'x' }]);
      await record();
      const imid = `<robot-${sid()}@x.test>`;
      await q(`insert into mail_outbox (idempotency_key, mailbox_id, user_id, identity_id, kind, subject, body_html, to_recipients, status, release_at, internet_message_id)
               values ($1, $2, $3, $4, 'new', 'x', '<p>x</p>', '[]', 'sent', now(), $5)`, [randomUUID(), mailbox, builder, identity, imid]);
      await email(main, { imid });
      await work();
      expect(await runs(a)).toEqual([]);
    });

    it('every email from a contact or owner in a ticket inbox reaches the record’s Communication tab, whether or not a flow runs', async () => {
      await emailFlow(['ticket_not_open'], [{ id: 'o', type: 'open_ticket', title: '', issue: 'x' }], mailbox).then((id) => q(`select automation_set_status($1, 'draft', null, $2)`, [id, builder]));
      const rec = await record();
      await email(main, { subject: 'Hello there' });
      await email(main, { subject: 'Not a ticket inbox', box: otherInbox });
      const rows = await q<{ subject: string; direction: string; from_identity: string }>(`select subject, direction, from_identity::text from messages where record_id = $1 and channel = 'email'`, [rec]);
      expect(rows).toEqual([{ subject: 'Hello there', direction: 'in', from_identity: main }]);
      // A message on the record, under the Communication tab's own rule: Org sees it, Own only sees mail of their own inboxes.
      await setting(agent, 'communication.scope', 'own');
      expect(await as(agent, () => q(`select id from messages where record_id = $1`, [rec]))).toEqual([]);
      await setting(agent, 'communication.scope', 'org');
      expect(await as(agent, () => q(`select id from messages where record_id = $1`, [rec]))).toHaveLength(1);
    });

    it('one open ticket: runs on it without asking', async () => {
      const a = await emailFlow(['ticket_open'], [{ id: 'c', type: 'close_ticket' }]);
      const rec = await record();
      const t = await ticket(rec);
      await email(main);
      await work();
      expect(await lastRun(a)).toMatchObject({ status: 'completed', case_id: t.id });
      expect((await caseRow(t.id)).state).toBe('closed');
    });

    it('more than one open ticket and a step that uses one: the assigned users choose, then it runs on the ticket chosen', async () => {
      const a = await emailFlow(['ticket_open'], [{ id: 'c', type: 'close_ticket' }]);
      const rec = await record();
      const t1 = await ticket(rec, 'Fees', [manager]);
      const t2 = await ticket(rec, 'Terminal', [manager]);
      await email(owner, { subject: 'About the fees' });
      await work();
      const r = await lastRun(a);
      expect(r).toMatchObject({ status: 'choosing', case_id: null });

      const note = await as(manager, () => q<{ choice_id: string; subject: string; tickets: { id: string }[] }>(`select * from ticket_choices_for($1)`, [rec]));
      expect(note.length).toBe(1);
      expect(note[0]!.subject).toBe('About the fees');
      expect(note[0]!.tickets.map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort());
      expect(await as(manager, () => q(`select * from ticket_choice_records() x where x = $1`, [rec]))).toHaveLength(1);
      // Not assigned to either ticket: not asked.
      expect(await as(agent, () => q(`select * from ticket_choices_for($1)`, [rec]))).toEqual([]);
      expect(await refused(() => as(agent, () => q(`select ticket_choose($1, $2)`, [note[0]!.choice_id, t1.id])))).toMatch(/not found/);

      await as(manager, () => q(`select ticket_choose($1, $2)`, [note[0]!.choice_id, t1.id]));
      expect(await as(manager, () => q(`select * from ticket_choices_for($1)`, [rec]))).toEqual([]);
      await work();
      expect(await lastRun(a)).toMatchObject({ status: 'completed', case_id: t1.id });
      expect((await caseRow(t1.id)).state).toBe('closed');
      expect((await caseRow(t2.id)).state).toBe('open');
      expect(await refused(() => as(manager, () => q(`select ticket_choose($1, $2)`, [note[0]!.choice_id, t2.id])))).toMatch(/already chose/);
    });

    it('nobody assigned: everyone who can open the record in Tickets is asked', async () => {
      await emailFlow(['ticket_open'], [{ id: 'c', type: 'close_ticket' }]);
      const rec = await record();
      await ticket(rec, 'A', []);
      await ticket(rec, 'B', []);
      await email(main);
      await work();
      expect((await as(agent, () => q(`select * from ticket_choices_for($1)`, [rec]))).length).toBe(1);
      await setting(other, 'items.cases', 'hidden');
      expect(await as(other, () => q(`select * from ticket_choices_for($1)`, [rec]))).toEqual([]);
      await setting(other, 'items.cases', 'all');
    });

    it('expires after 24 hours: the note goes and the flow doesn’t run for that email', async () => {
      const a = await emailFlow(['ticket_open'], [{ id: 'c', type: 'close_ticket' }]);
      const rec = await record();
      const t1 = await ticket(rec);
      await ticket(rec);
      await email(main);
      await work();
      await q(`update ticket_choices set expires_at = now() - interval '1 minute' where record_id = $1`, [rec]);
      await work();
      expect(await lastRun(a)).toMatchObject({ status: 'expired', reason: 'Expired: no ticket chosen.' });
      expect((await caseRow(t1.id)).state).toBe('open');
      expect(await as(manager, () => q(`select * from ticket_choices_for($1)`, [rec]))).toEqual([]);
    });

    it('a flow that doesn’t act on one ticket runs without asking', async () => {
      const a = await emailFlow(['ticket_open'], [{ id: 'n', type: 'send_notification', who: 'user', userId: other, teamId: '', message: '' }]);
      const rec = await record();
      await ticket(rec);
      await ticket(rec);
      await email(main);
      await work();
      expect(await lastRun(a)).toMatchObject({ status: 'completed', case_id: null });
    });

    it('switching it off ends a choice that was waiting', async () => {
      const a = await emailFlow(['ticket_open'], [{ id: 'c', type: 'close_ticket' }]);
      const rec = await record();
      await ticket(rec);
      await ticket(rec);
      await email(main);
      await work();
      await q(`select automation_set_status($1, 'off', null, $2)`, [a, builder]);
      expect(await lastRun(a)).toMatchObject({ status: 'cancelled' });
      expect(await as(manager, () => q(`select * from ticket_choices_for($1)`, [rec]))).toEqual([]);
    });
  });

  // ── waits ──────────────────────────────────────────────────────────────────
  describe('waits', () => {
    it('client goes quiet: wait, email, wait, close — and a client reply in any inbox cancels the rest', async () => {
      const a = await flow({
        triggers: [{ id: 't', type: 'awaiting_client' }],
        conditions: cond('ticket_open'),
        flow: [{ id: 'w', type: 'wait', amount: 3, unit: 'days' }, { id: 'c', type: 'close_ticket' }],
      });
      const rec = await record();
      const t = await ticket(rec);
      await click(agent, t.id);
      await work();
      expect((await lastRun(a)).status).toBe('waiting');
      await email(owner, { box: otherInbox, subject: 'Re: checking in' });
      expect(await lastRun(a)).toMatchObject({ status: 'cancelled', reason: 'Cancelled: client replied.' });
      await q(`update automation_runs set resume_at = now() - interval '1 minute' where automation_id = $1`, [a]);
      await work();
      expect((await caseRow(t.id)).state).toBe('open');
    });

    it('an email from someone else doesn’t end the wait', async () => {
      const a = await flow({ triggers: [{ id: 't', type: 'awaiting_client' }], flow: [{ id: 'w', type: 'wait', amount: 1, unit: 'hours' }, { id: 'c', type: 'close_ticket' }] });
      const rec = await record();
      const t = await ticket(rec);
      await click(agent, t.id);
      await work();
      await email(`stranger-${sid()}@nowhere.test`);
      expect((await lastRun(a)).status).toBe('waiting');
      await q(`update automation_runs set resume_at = now() - interval '1 minute' where automation_id = $1`, [a]);
      await work();
      expect((await caseRow(t.id)).state).toBe('closed');
    });
  });

  // ── the email a flow sends ─────────────────────────────────────────────────
  it('Send merchant an email: recorded on the Communication tab and in the ticket’s log', async () => {
    const a = await flow({
      triggers: [{ id: 't', type: 'awaiting_client' }],
      flow: [{ id: 'm', type: 'send_email', mailboxId: mailbox, to: 'main_contact', customTo: '', subject: 'Just checking in', body: 'Hi', fileIds: [], fileRows: [] }],
    });
    const rec = await record();
    const t = await ticket(rec);
    await click(agent, t.id);
    const jobs = await work();
    const job = jobs.find((j) => (j.step as Step | null)?.type === 'send_email')!;
    const { id: outbox } = await one<{ id: string }>(`select automation_mail_enqueue($1, $2, 'Just checking in', '<p>Hi Mia,</p><p>Any news?</p>', $3, '[]') as id`,
      [job.run_id, mailbox, JSON.stringify([{ name: 'Mia Main', address: main }])]);
    await q(`update mail_outbox set status = 'sent', sent_at = now() where id = $1`, [outbox]);
    await q(`select automation_mail_result($1, true, null)`, [outbox]);
    await q(`select set_config('tapdash.automation', '', true)`);
    const m = await one<{ direction: string; subject: string; body: string; to_identity: string }>(`select direction, subject, body, to_identity::text from messages where record_id = $1`, [rec]);
    expect(m).toMatchObject({ direction: 'out', subject: 'Just checking in', to_identity: main });
    expect(m.body).toContain('Any news?');
    expect(m.body).not.toContain('<p>');
    expect((await log(t.id)).at(-1)!.body).toBe(`Sent the email “Just checking in” to ${main}.`);
    await work();
    expect((await lastRun(a)).status).toBe('completed');
  });

  it('the ticket log is seen only by whoever sees the ticket', async () => {
    const rec = await record();
    const t = await ticket(rec);
    await click(agent, t.id);
    expect(await as(agent, () => q(`select id from case_log where case_id = $1`, [t.id]))).toHaveLength(1);
    await setting(other, 'items.cases', 'hidden');
    expect(await as(other, () => q(`select id from case_log where case_id = $1`, [t.id]))).toEqual([]);
    await setting(other, 'items.cases', 'all');
  });
});
