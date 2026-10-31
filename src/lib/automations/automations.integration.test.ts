/**
 * Automations — the database half, a test per rule of the client's spec, driven
 * by real writes as real signed-in viewers, inside one transaction that is always
 * rolled back. `automation_work` is called the way the tick calls it.
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

suite('Automations', () => {
  const team: Record<string, string> = {};
  let member: string;
  let builder: string;
  let sales: string;
  let uw1: string;
  let uw2: string;
  let leads: string;
  let deals: string;
  let tickets: string;
  let pipeline: string;
  let stageA: string;
  let stageB: string;

  const as = async <T>(user: string, fn: () => Promise<T>): Promise<T> => {
    await q(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
    const result = await fn();
    await q(`select set_config('request.jwt.claims', '', true), set_config('role', 'none', true)`);
    return result;
  };
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
    return id;
  };
  const record = async (values: Record<string, unknown> = {}, modules: string[] = [leads]) => {
    const { id } = await one<{ id: string }>(`insert into records (deal_name, creator_user_id, values) values ($1, $2, $3) returning id`, [`ZZ ${randomUUID().slice(0, 8)}`, builder, values]);
    for (const m of modules) await q(`insert into record_modules (record_id, module_id) values ($1, $2)`, [id, m]);
    return id;
  };
  /** The real writer, as a real person, on a page of the app. */
  const setValue = async (user: string, rec: string, key: string, value: unknown, page = '/leads') => {
    await q(`select set_config('tapdash.page', $1, true)`, [page]);
    const { at } = await one<{ at: string }>(`select updated_at::text as at from records where id = $1`, [rec]);
    await as(user, () => q(`select * from set_record_value($1, $2, $3::jsonb, $4::timestamptz, 'x')`, [rec, key, JSON.stringify(value), at]));
    await q(`select set_config('tapdash.page', '', true)`);
  };
  const automation = async (flow: Flow, status = 'on', testRecord: string | null = null, extra: { stopTeams?: string[]; stopUsers?: string[] } = {}) => {
    const steps = { triggers: [], conditions: { join: 'and', groups: [] }, flow: [], ...flow };
    const { id } = await one<{ id: string }>(`select automation_save(null, $1, $2, $3, $4, false, $5) as id`, [`ZZ auto ${randomUUID().slice(0, 6)}`, steps, extra.stopTeams ?? [], extra.stopUsers ?? [], builder]);
    if (status !== 'draft') await q(`select automation_set_status($1, $2, $3, $4)`, [id, status, testRecord, builder]);
    return id;
  };
  /** As the tick calls it. Each real tick is its own transaction, so what it sets local is cleared here. */
  const work = async () => {
    const rows = await q<{ run_id: string | null; step: Step | null }>(`select * from automation_work(50)`);
    await q(`select set_config('tapdash.automation', '', true), set_config('tapdash.event_actor', '', true)`);
    await q(`delete from automation_queue where done_at is not null`);
    return rows.filter((r) => r.run_id);
  };
  const runs = (a: string) => q<{ id: string; status: string; reason: string | null; position: number; record_id: string; module_id: string | null }>(`select * from automation_runs where automation_id = $1 order by started_at`, [a]);
  const lastRun = async (a: string) => (await runs(a)).at(-1)!;
  const queued = async (a: string) => (await one<{ n: number }>(`select count(*)::int n from automation_queue where automation_id = $1`, [a])).n;
  const statusOf = async (rec: string) => (await one<{ s: string | null }>(`select values ->> 'current_status' s from records where id = $1`, [rec])).s;
  const expire = (run: string) => q(`update automation_runs set resume_at = now() - interval '1 minute' where id = $1`, [run]);

  const onStatus = (value: string) => ({ id: 't', type: 'status', value });
  const setStatus = (value: string) => ({ id: randomUUID().slice(0, 8), type: 'change_status', value });
  const group = (join: string, ...conditions: Step[]) => ({ id: randomUUID().slice(0, 8), join, conditions });
  const mid = () => randomUUID().slice(0, 12);

  beforeAll(async () => {
    db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
    await db.connect();
    await q('begin');
    for (const t of await q<{ id: string; user_type: string }>(`select id, user_type from permission_templates where user_type is not null`)) team[t.user_type] = t.id;
    member = (await one<{ id: string }>(`select id from roles where not is_admin order by name limit 1`)).id;
    leads = (await one<{ id: string }>(`select id from modules where slug = 'leads'`)).id;
    deals = (await one<{ id: string }>(`select id from modules where slug = 'deals'`)).id;
    tickets = (await one<{ id: string }>(`select id from modules where shows_open_cases limit 1`)).id;
    const p = await q<{ id: string; step: string }>(`select p.id, s.id as step from pipelines p join pipeline_steps s on s.pipeline_id = p.id where p.module_id = $1 order by p.position, s.position limit 2`, [leads]);
    pipeline = p[0]!.id;
    stageA = p[0]!.step;
    stageB = p[1]!.step;
    builder = await newUser('Bea Builder', 'admin');
    sales = await newUser('Sal Sales', 'sales_agent');
    uw1 = await newUser('Ann Zimmer', 'underwriter');
    uw2 = await newUser('Bob Adams', 'underwriter');
    for (const key of ['action.modules', 'action.pipeline', 'action.team']) {
      await q(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, $2, 'yes') on conflict (owner_kind, owner_id, key) do update set value = 'yes'`, [sales, key]);
    }
    // Sales sets things off on every record here; the visibility tests say otherwise where they mean it.
    for (const m of [leads, deals]) {
      await q(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, $2, 'all') on conflict (owner_kind, owner_id, key) do update set value = 'all'`, [sales, `module:${m}`]);
    }
  }, 60_000);

  afterEach(async () => {
    await q(`select set_config('tapdash.automation', '', true), set_config('tapdash.event_actor', '', true), set_config('tapdash.page', '', true)`);
    await q(`delete from automation_triggers`);
    await q(`delete from automation_queue`);
    await q(`update automation_runs set status = 'cancelled' where status in ('running', 'waiting', 'sending')`);
  });

  afterAll(async () => {
    await q('rollback');
    await db.end();
  });

  // ── triggers ───────────────────────────────────────────────────────────────
  describe('triggers', () => {
    it('Status changes: to the chosen value, and no other', async () => {
      const a = await automation({ triggers: [onStatus('high')], flow: [setStatus('low')] });
      const rec = await record();
      await setValue(sales, rec, 'current_status', 'mid');
      expect(await queued(a)).toBe(0);
      await setValue(sales, rec, 'current_status', 'high');
      expect(await queued(a)).toBe(1);
    });

    it('Pipeline stage changes: a move to that stage, in that module, and not a save of the same stage', async () => {
      const a = await automation({ triggers: [{ id: 't', type: 'stage', pipelineId: pipeline, stepId: stageB }], flow: [setStatus('low')] });
      const rec = await record();
      await as(sales, () => q(`select set_pipeline_step($1, $2, $3, $4)`, [rec, leads, pipeline, stageA]));
      expect(await queued(a)).toBe(0);
      await as(sales, () => q(`select set_pipeline_step($1, $2, $3, $4)`, [rec, leads, pipeline, stageB]));
      expect(await queued(a)).toBe(1);
      expect((await one<{ m: string }>(`select module_id m from automation_queue where automation_id = $1`, [a])).m).toBe(leads);
      await work();
      const b = await automation({ triggers: [{ id: 't', type: 'stage', pipelineId: pipeline, stepId: stageB }], flow: [setStatus('low')] });
      await as(sales, () => q(`select set_pipeline_step($1, $2, $3, $4)`, [rec, leads, pipeline, stageB]));
      expect(await queued(b)).toBe(0);
    });

    it('Field changed: the chosen field, with or without a specific new value, and a member of a group', async () => {
      const any = await automation({ triggers: [{ id: 't', type: 'field', field: 'mid' }], flow: [setStatus('low')] });
      const wanted = mid();
      const exact = await automation({ triggers: [{ id: 't', type: 'field', field: 'mid', value: wanted }], flow: [setStatus('low')] });
      const memberField = await automation({ triggers: [{ id: 't', type: 'field', field: 'contact.email' }], flow: [setStatus('low')] });
      const rec = await record({ contact: [{ name: 'A', email: 'a@x.test' }] });
      await setValue(sales, rec, 'mid', mid());
      expect([await queued(any), await queued(exact), await queued(memberField)]).toEqual([1, 0, 0]);
      await work();
      await setValue(sales, rec, 'contact', [{ name: 'A', email: 'b@x.test' }]);
      expect(await queued(memberField)).toBe(1);
      await work();
      await q(`update automation_runs set status = 'cancelled' where status in ('running', 'waiting', 'sending')`);
      await setValue(sales, rec, 'mid', wanted);
      expect(await queued(exact)).toBe(1);
    });

    it('A save that changes nothing is not a change', async () => {
      const a = await automation({ triggers: [{ id: 't', type: 'field', field: 'mid' }], flow: [setStatus('low')] });
      const same = mid();
      const rec = await record({ mid: same });
      await setValue(sales, rec, 'mid', same);
      expect(await queued(a)).toBe(0);
    });

    it('Team assigned and Team removed; Assign to me is not assigned; a creator\'s own team is not assigned', async () => {
      const on = await automation({ triggers: [{ id: 't', type: 'team_assigned', teamId: team.underwriter }], flow: [setStatus('low')] });
      const off = await automation({ triggers: [{ id: 't', type: 'team_removed', teamId: team.underwriter }], flow: [setStatus('low')] });
      const rec = await record();
      await as(builder, () => q(`select assign_team($1, $2)`, [rec, team.underwriter]));
      expect(await queued(on)).toBe(1);
      await q(`delete from automation_queue`);

      await q(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, 'action.team_take', 'yes') on conflict (owner_kind, owner_id, key) do update set value = 'yes'`, [uw1]);
      await q(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, 'team.underwriter.see_open', 'yes') on conflict (owner_kind, owner_id, key) do update set value = 'yes'`, [uw1]);
      await as(uw1, () => q(`select take_team_assignment($1, $2)`, [rec, team.underwriter]));
      expect(await queued(on)).toBe(0);

      await as(builder, () => q(`select unassign_team($1, $2)`, [rec, team.underwriter]));
      expect(await queued(off)).toBe(1);

      await one(`insert into records (deal_name, creator_user_id, values) values ('ZZ made by uw', $1, $2) returning id`, [uw1, { team_members_assigned: [uw1] }]);
      expect(await queued(on)).toBe(0);
    });

    it('Module assigned and Module removed', async () => {
      const on = await automation({ triggers: [{ id: 't', type: 'module_assigned', moduleId: deals }], flow: [setStatus('low')] });
      const off = await automation({ triggers: [{ id: 't', type: 'module_removed', moduleId: leads }], flow: [setStatus('low')] });
      const rec = await record();
      await as(builder, () => q(`select set_record_memberships($1, $2)`, [rec, [leads, deals]]));
      expect([await queued(on), await queued(off)]).toEqual([1, 0]);
      await as(builder, () => q(`select set_record_memberships($1, $2)`, [rec, [deals]]));
      expect(await queued(off)).toBe(1);
      const row = await one<{ m: string }>(`select module_id m from automation_queue where automation_id = $1`, [off]);
      expect(row.m).toBe(leads);
    });

    it('Contract sent and Contract received, once each', async () => {
      const sent = await automation({ triggers: [{ id: 't', type: 'contract_sent' }], flow: [setStatus('low')] });
      const got = await automation({ triggers: [{ id: 't', type: 'contract_received' }], flow: [setStatus('low')] });
      const rec = await record();
      const { id } = await one<{ id: string }>(
        `insert into agreements (record_id, kind, status, sent_by, signer_count, snapshot_sealed, snapshot_iv, expires_at, subject, message, requester_name)
         values ($1, 'maverick_merchant', 'sending', $2, 1, decode('00', 'hex'), decode('00', 'hex'), now() + interval '1 day', 's', 'm', 'r') returning id`,
        [rec, builder],
      );
      await q(`update agreements set status = 'sent' where id = $1`, [id]);
      expect([await queued(sent), await queued(got)]).toEqual([1, 0]);
      await q(`update agreements set status = 'viewed' where id = $1`, [id]);
      await q(`update agreements set status = 'completed' where id = $1`, [id]);
      expect(await queued(got)).toBe(1);
    });

    it('Application sent, and Application received once; a partly filled application is not received', async () => {
      const sent = await automation({ triggers: [{ id: 't', type: 'application_sent' }], flow: [setStatus('low')] });
      const got = await automation({ triggers: [{ id: 't', type: 'application_received' }], flow: [setStatus('low')] });
      const rec = await record();
      const { id } = await one<{ id: string }>(
        `insert into applications (record_id, sent_by, recipient, subject, token_hash, token_sealed, token_iv, expires_at)
         values ($1, $2, 'a@x.test', 's', $3, decode('00', 'hex'), decode('00', 'hex'), now() + interval '1 day') returning id`,
        [rec, builder, randomUUID()],
      );
      await q(`select automation_application_sent($1)`, [id]);
      expect(await queued(sent)).toBe(1);

      await q(`update applications set draft_sealed = decode('00', 'hex'), draft_iv = decode('00', 'hex') where id = $1`, [id]);
      expect(await queued(got)).toBe(0);

      await q(`select * from application_record_return($1, '[]', '{}', '[]', 'online', null, null)`, [id]);
      expect(await queued(got)).toBe(1);
      await q(`update applications set status = 'sent' where id = $1`, [id]);
      await q(`select * from application_record_return($1, '[]', '{}', '[]', 'online', null, null)`, [id]);
      expect(await queued(got)).toBe(1);
    });

    it('A merchant filling a field through an application counts as a person', async () => {
      const a = await automation({ triggers: [{ id: 't', type: 'field', field: 'mid' }], flow: [setStatus('low')] });
      const rec = await record();
      const { id } = await one<{ id: string }>(
        `insert into applications (record_id, sent_by, recipient, subject, token_hash, token_sealed, token_iv, expires_at)
         values ($1, $2, 'a@x.test', 's', $3, decode('00', 'hex'), decode('00', 'hex'), now() + interval '1 day') returning id`,
        [rec, builder, randomUUID()],
      );
      await q(`select * from application_record_return($1, '[]', $2, '[]', 'online', null, null)`, [id, { mid: mid() }]);
      expect(await queued(a)).toBe(1);
    });

    it('Two triggers of one automation hit by one change start it once', async () => {
      const a = await automation({ triggers: [onStatus('high'), { id: 't2', type: 'field', field: 'current_status' }], flow: [setStatus('low')] });
      const rec = await record();
      await setValue(sales, rec, 'current_status', 'high');
      expect(await queued(a)).toBe(1);
    });
  });

  // ── emails ─────────────────────────────────────────────────────────────────
  describe('emails and records', () => {
    let mailbox: string;
    let identity: string;
    const message = async (over: Record<string, unknown>) => {
      const id = randomUUID();
      await q(
        `insert into mail_messages (mailbox_id, graph_id, internet_message_id, conversation_id, from_address, to_recipients, cc_recipients, bcc_recipients, received_at, is_draft, direction)
         values ($1, $2, $3, $4, $5, $6, '[]', '[]', $7, $8, $9)`,
        [mailbox, id, over.imid ?? `<${id}@x>`, over.conversation ?? id, over.from ?? 'someone@x.test', JSON.stringify(over.to ?? []), over.at ?? new Date().toISOString(), over.draft ?? false, over.direction ?? 'inbound'],
      );
      return id;
    };

    beforeAll(async () => {
      identity = (await one<{ id: string }>(
        `insert into mail_identities (user_id, microsoft_user_id, primary_email) values ($1, $2, 'zz@x.test') returning id`,
        [builder, randomUUID()],
      )).id;
      mailbox = (await one<{ id: string }>(
        `insert into mail_mailboxes (kind, address, seeded_at, sync_identity_id) values ('shared', $1, now() - interval '1 hour', $2) returning id`,
        [`zz-${randomUUID().slice(0, 6)}@x.test`, identity],
      )).id;
      await q(`insert into mail_connections (user_id, mailbox_id, identity_id, status) values ($1, $2, $3, 'ok')`, [builder, mailbox, identity]);
    });

    it('keeps the main contact and every owner email, and no other', async () => {
      const rec = await record({ contact: [{ email: 'Main@X.test' }, { email: 'second@x.test' }], owner_ownership: [{ email: 'owner1@x.test' }, { email: 'owner2@x.test' }], business_email: 'biz@x.test' });
      const rows = await q<{ email: string; source: string }>(`select email::text, source from record_contact_emails where record_id = $1 order by email`, [rec]);
      expect(rows).toEqual([{ email: 'main@x.test', source: 'contact' }, { email: 'owner1@x.test', source: 'owner' }, { email: 'owner2@x.test', source: 'owner' }]);
    });

    it('Email from contact received: from the main contact or an owner, on that record', async () => {
      const a = await automation({ triggers: [{ id: 't', type: 'email_received' }], flow: [setStatus('low')] });
      const rec = await record({ contact: [{ email: 'c1@x.test' }], owner_ownership: [{ email: 'o1@x.test' }] });
      await message({ from: 'c1@x.test' });
      await message({ from: 'o1@x.test' });
      await message({ from: 'stranger@x.test' });
      const rows = await q<{ record_id: string }>(`select record_id from automation_queue where automation_id = $1`, [a]);
      expect(rows.map((r) => r.record_id)).toEqual([rec, rec]);
    });

    it('One email in two connected mailboxes is one event', async () => {
      const a = await automation({ triggers: [{ id: 't', type: 'email_received' }], flow: [setStatus('low')] });
      await record({ contact: [{ email: 'twin@x.test' }] });
      await message({ from: 'twin@x.test', imid: '<same@x>' });
      await message({ from: 'twin@x.test', imid: '<same@x>' });
      expect(await queued(a)).toBe(1);
    });

    it('Old mail, drafts and a mailbox still seeding are not events', async () => {
      const a = await automation({ triggers: [{ id: 't', type: 'email_received' }, { id: 't2', type: 'email_sent' }], flow: [setStatus('low')] });
      await record({ contact: [{ email: 'old@x.test' }] });
      await message({ from: 'old@x.test', at: new Date(Date.now() - 3 * 864e5).toISOString() });
      await message({ direction: 'outbound', to: [{ address: 'old@x.test' }], draft: true });
      await q(`update mail_mailboxes set seeded_at = null where id = $1`, [mailbox]);
      await message({ from: 'old@x.test' });
      await q(`update mail_mailboxes set seeded_at = now() - interval '1 hour' where id = $1`, [mailbox]);
      expect(await queued(a)).toBe(0);
    });

    it('Email to contact sent: a person\'s send, and the moment a draft becomes sent', async () => {
      const a = await automation({ triggers: [{ id: 't', type: 'email_sent' }], flow: [setStatus('low')] });
      await record({ contact: [{ email: 'to@x.test' }] });
      const graph = await message({ direction: 'outbound', to: [{ address: 'to@x.test' }], draft: true });
      expect(await queued(a)).toBe(0);
      await q(`update mail_messages set is_draft = false where graph_id = $1`, [graph]);
      expect(await queued(a)).toBe(1);
    });

    it('An address on several records: the writer\'s choice is the main record, and replies follow it', async () => {
      const a = await automation({ triggers: [{ id: 't', type: 'email_sent' }, { id: 't2', type: 'email_received' }], flow: [setStatus('low')] });
      const r1 = await record({ contact: [{ email: 'shared@x.test' }] });
      const r2 = await record({ contact: [{ email: 'shared@x.test' }] });

      const choices = await as(builder, () => q<{ record_id: string }>(`select * from mail_record_choices($1)`, [['shared@x.test']]));
      expect(choices.map((c) => c.record_id).sort()).toEqual([r1, r2].sort());

      await q(
        `insert into mail_outbox (idempotency_key, mailbox_id, user_id, kind, body_html, status, release_at, internet_message_id, record_id)
         values ($1, $2, $3, 'new', 'x', 'sent', now(), '<chosen@x>', $4)`,
        [randomUUID(), mailbox, builder, r2],
      );
      await message({ direction: 'outbound', to: [{ address: 'shared@x.test' }], imid: '<chosen@x>', conversation: 'conv-1' });
      await message({ from: 'shared@x.test', conversation: 'conv-1' });
      const rows = await q<{ record_id: string }>(`select record_id from automation_queue where automation_id = $1`, [a]);
      expect(rows.map((r) => r.record_id)).toEqual([r2, r2]);

      const again = await as(builder, () => q(`select * from mail_record_choices($1, $2, 'conv-1')`, [['shared@x.test'], mailbox]));
      expect(again).toEqual([]);
    });

    it('An email on a shared address with no choice runs on nothing, and the history says why', async () => {
      const a = await automation({ triggers: [{ id: 't', type: 'email_received' }], flow: [setStatus('low')] });
      await record({ contact: [{ email: 'nochoice@x.test' }] });
      await record({ contact: [{ email: 'nochoice@x.test' }] });
      await message({ from: 'nochoice@x.test' });
      await work();
      const run = await lastRun(a);
      expect(run.status).toBe('not_matched');
      expect(run.record_id).toBeNull();
      expect(run.reason).toMatch(/nobody has chosen/);
    });

    it('Send email: parks, sends once, carries on, and its own email is not a person\'s', async () => {
      const stepId = 'mail1';
      const a = await automation({
        triggers: [onStatus('high')],
        flow: [{ id: stepId, type: 'send_email', mailboxId: mailbox, to: 'main_contact' }, setStatus('low')],
      });
      const listener = await automation({ triggers: [{ id: 't', type: 'email_sent' }], flow: [setStatus('mid')] });
      const rec = await record({ contact: [{ email: 'robot@x.test' }] });
      await setValue(sales, rec, 'current_status', 'high');

      const jobs = await work();
      expect(jobs).toHaveLength(1);
      const run = await lastRun(a);
      expect(run.status).toBe('sending');
      expect(await work()).toHaveLength(0);

      const enqueue = () => one<{ id: string }>(`select automation_mail_enqueue($1, $2, 'Hi', '<p>x</p>', '[{"name":"R","address":"robot@x.test"}]', '[]') as id`, [run.id, mailbox]);
      const first = await enqueue();
      expect((await enqueue()).id).toBe(first.id);
      expect((await one<{ n: number }>(`select count(*)::int n from mail_outbox where automation_run_id = $1`, [run.id])).n).toBe(1);

      await q(`update mail_outbox set status = 'sent', internet_message_id = '<robot@x>' where id = $1`, [first.id]);
      await q(`select automation_mail_result($1, true, null)`, [first.id]);
      await work();
      expect((await lastRun(a)).status).toBe('completed');
      expect(await statusOf(rec)).toBe('low');

      await message({ direction: 'outbound', to: [{ address: 'robot@x.test' }], imid: '<robot@x>' });
      expect(await queued(listener)).toBe(0);
    });

    it('Send email: a send that fails stops the run and alerts the builder', async () => {
      const a = await automation({ triggers: [onStatus('high')], flow: [{ id: 'm', type: 'send_email', mailboxId: mailbox }, setStatus('low')] });
      const rec = await record({ contact: [{ email: 'fail@x.test' }] });
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      const run = await lastRun(a);
      const { id } = await one<{ id: string }>(`select automation_mail_enqueue($1, $2, 'Hi', 'x', '[{"name":"R","address":"fail@x.test"}]', '[]') as id`, [run.id, mailbox]);
      await q(`update mail_outbox set status = 'failed', last_error = 'Rejected.' where id = $1`, [id]);
      await work();
      const done = await lastRun(a);
      expect(done.status).toBe('failed');
      expect(done.reason).toMatch(/didn't send\. Rejected/);
      expect(await statusOf(rec)).toBe('high');
      expect((await one<{ n: number }>(`select count(*)::int n from notifications where recipient_id = $1 and automation_run_id = $2 and source_kind = 'automation_alert'`, [builder, run.id])).n).toBe(1);
    });

    it('An inbox with no working connection is a refusal, not a silent loss', async () => {
      const a = await automation({ triggers: [onStatus('high')], flow: [{ id: 'm', type: 'send_email', mailboxId: randomUUID() }] });
      const rec = await record();
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      const run = await lastRun(a);
      await expect(q(`savepoint s`).then(() => one(`select automation_mail_enqueue($1, $2, 'H', 'x', '[]', '[]')`, [run.id, randomUUID()]))).rejects.toThrow(/no working connection/);
      await q(`rollback to savepoint s`);
    });
  });

  // ── conditions ─────────────────────────────────────────────────────────────
  describe('conditions', () => {
    const met = async (conditions: unknown, rec: string, module: string | null = leads) =>
      (await one<{ ok: boolean }>(`select automation_conditions_met($1, $2, $3) as ok`, [conditions, rec, module])).ok;
    const single = (c: Step) => ({ join: 'and', groups: [group('and', { id: 'c', ...c })] });

    it('Field is filled: a value, not blanks; a member of a group; zero and No are values', async () => {
      const rec = await record({ mid: '   ', dba_name: 'X', a_number: 0, a_flag: false, contact: [{ email: '' }, { email: 'a@x.test' }] });
      const f = (field: string) => met(single({ type: 'field_filled', field }), rec);
      expect(await f('mid')).toBe(false);
      expect(await f('dba_name')).toBe(true);
      expect(await f('a_number')).toBe(true);
      expect(await f('a_flag')).toBe(true);
      expect(await f('nothing_here')).toBe(false);
      expect(await f('contact.email')).toBe(true);
      expect(await f('contact.phone')).toBe(false);
      expect(await f('deal_name')).toBe(true);
    });

    it('Field is filled: a preset Files row with a file on it, and never a row someone added', async () => {
      const rec = await record();
      const row = async (name: string, locked: boolean, withFile: boolean, deleted = false) => {
        const { id } = await one<{ id: string }>(`insert into file_rows (record_id, kind, name, locked) values ($1, 'application', $2, $3) returning id`, [rec, name, locked]);
        if (withFile) await q(`insert into files (file_row_id, storage_path, name, size_bytes, uploaded_by, deleted_at) values ($1, $2, 'a.pdf', 1, $3, $4)`, [id, randomUUID(), builder, deleted ? new Date().toISOString() : null]);
      };
      await row('Owner ID', true, true);
      await row('Voided check', true, false);
      await row('Corp docs', true, true, true);
      await row('Extra', false, true);
      const f = (fileRow: string) => met(single({ type: 'field_filled', fileRow }), rec);
      expect(await f('Owner ID')).toBe(true);
      expect(await f('Voided check')).toBe(false);
      expect(await f('Corp docs')).toBe(false);
      expect(await f('Extra')).toBe(false);
      expect(await f('Bank statements')).toBe(false);
    });

    it('All fields filled: every field on the sub-tab, and an empty group is not filled', async () => {
      const sub = await one<{ id: string; tab_id: string; keys: string[] }>(
        `select s.id, s.tab_id, array_agg(f.key::text) keys from subtabs s join fields f on f.subtab_id = s.id and f.archived_at is null
          where not exists (select 1 from pipelines p where p.status_field_id = f.id)
          group by s.id, s.tab_id having count(*) >= 2 and bool_and(f.type::text <> 'file' and f.key::text <> 'mid') limit 1`,
      );
      const values = Object.fromEntries(sub.keys.map((k) => [k, 'x']));
      const full = await record(values);
      const part = await record({ ...values, [sub.keys[0]!]: '' });
      const c = single({ type: 'all_filled', tabId: sub.tab_id, subtabId: sub.id });
      expect(await met(c, full)).toBe(true);
      expect(await met(c, part)).toBe(false);
    });

    it('Status is, Pipeline is (at any stage), Only in module', async () => {
      const rec = await record({ current_status: 'high' });
      await q(`insert into record_pipelines (record_id, module_id, pipeline_id, step_id) values ($1, $2, $3, $4)`, [rec, leads, pipeline, stageB]);
      expect(await met(single({ type: 'status_is', value: 'high' }), rec)).toBe(true);
      expect(await met(single({ type: 'status_is', value: 'low' }), rec)).toBe(false);
      expect(await met(single({ type: 'pipeline_is', pipelineId: pipeline }), rec)).toBe(true);
      expect(await met(single({ type: 'pipeline_is', pipelineId: randomUUID() }), rec)).toBe(false);
      expect(await met(single({ type: 'in_module', moduleId: leads }), rec, leads)).toBe(true);
      expect(await met(single({ type: 'in_module', moduleId: deals }), rec, leads)).toBe(false);
      expect(await met(single({ type: 'in_module', moduleId: leads }), rec, null)).toBe(false);
    });

    it('Date is: before, after, on; a blank date meets nothing', async () => {
      const rec = await record({ a_date: '2026-06-15', with_time: '2026-06-15T10:00:00Z', bad: '2026-13-45' });
      const d = (op: string, date: string, field = 'a_date') => met(single({ type: 'date_is', field, op, date }), rec);
      expect(await d('before', '2026-06-16')).toBe(true);
      expect(await d('before', '2026-06-15')).toBe(false);
      expect(await d('after', '2026-06-14')).toBe(true);
      expect(await d('on', '2026-06-15')).toBe(true);
      expect(await d('on', '2026-06-15', 'with_time')).toBe(true);
      expect(await d('on', '2026-06-15', 'nothing')).toBe(false);
      expect(await d('on', '2026-06-15', 'bad')).toBe(false);
    });

    it('Days from date: today is that many days before or after', async () => {
      const { today } = await one<{ today: string }>(`select automation_today()::text as today`);
      const shift = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
      const rec = await record({ passed: shift(-3), coming: shift(5) });
      const d = (field: string, days: number, direction: string) => met(single({ type: 'days_from', field, days, direction }), rec);
      expect(await d('passed', 3, 'after')).toBe(true);
      expect(await d('passed', 2, 'after')).toBe(false);
      expect(await d('passed', 3, 'before')).toBe(false);
      expect(await d('coming', 5, 'before')).toBe(true);
    });

    it('The spec\'s brackets: (ID uploaded and Pricing filled) or Status is Approved', async () => {
      const a = { id: 'a', type: 'field_filled', field: 'a' };
      const b = { id: 'b', type: 'field_filled', field: 'b' };
      const c = { id: 'c', type: 'status_is', value: 'approved' };
      const brackets = { join: 'or', groups: [group('and', a, b), group('and', c)] };
      expect(await met(brackets, await record({ a: 'x', b: 'y' }))).toBe(true);
      expect(await met(brackets, await record({ a: 'x' }))).toBe(false);
      expect(await met(brackets, await record({ current_status: 'approved' }))).toBe(true);
      const insideOr = { join: 'and', groups: [group('or', a, b), group('and', c)] };
      expect(await met(insideOr, await record({ a: 'x', current_status: 'approved' }))).toBe(true);
      expect(await met(insideOr, await record({ a: 'x' }))).toBe(false);
    });

    it('No conditions at all is a yes', async () => {
      expect(await met({ join: 'and', groups: [] }, await record())).toBe(true);
    });

    it('A run that doesn\'t meet its conditions does nothing, and says so', async () => {
      const a = await automation({ triggers: [onStatus('high')], conditions: single({ type: 'field_filled', field: 'mid' }), flow: [setStatus('low')] });
      const rec = await record();
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      expect((await lastRun(a)).status).toBe('not_matched');
      expect(await statusOf(rec)).toBe('high');
    });

    it('Only in module is checked against where it happened', async () => {
      const a = await automation({ triggers: [onStatus('high')], conditions: single({ type: 'in_module', moduleId: deals }), flow: [setStatus('low')] });
      const rec = await record({}, [leads, deals]);
      await setValue(sales, rec, 'current_status', 'high', '/leads');
      await work();
      expect((await lastRun(a)).status).toBe('not_matched');
      await setValue(sales, rec, 'current_status', 'mid', '/deals');
      await setValue(sales, rec, 'current_status', 'high', '/deals');
      await q(`delete from automation_queue where done_at is null and module_id is distinct from $1`, [deals]);
      await work();
      expect((await lastRun(a)).status).toBe('completed');
    });
  });

  // ── actions ────────────────────────────────────────────────────────────────
  describe('actions', () => {
    const runOn = async (flow: Step[], values: Record<string, unknown> = {}, modules = [leads]) => {
      await q(`delete from automation_triggers`);
      const a = await automation({ triggers: [onStatus('high')], flow });
      const rec = await record(values, modules);
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      return { a, rec };
    };

    it('Change status writes history and bumps the token an open drawer holds', async () => {
      const a = await automation({ triggers: [onStatus('high')], flow: [setStatus('low')] });
      const rec = await record();
      await setValue(sales, rec, 'current_status', 'high');
      await q(`update records set updated_at = updated_at - interval '1 hour' where id = $1`, [rec]);
      const before = (await one<{ at: string }>(`select updated_at::text at from records where id = $1`, [rec])).at;
      await work();
      expect((await lastRun(a)).status).toBe('completed');
      const hist = await one<{ actor_id: string | null; source: string; from_value: string; to_value: string }>(`select * from record_activity where record_id = $1 and field_key = 'current_status' and source is not null`, [rec]);
      expect(hist).toMatchObject({ actor_id: null, from_value: 'high', to_value: 'low' });
      expect(hist.source).toMatch(/^Automation: ZZ auto/);
      expect((await one<{ same: boolean }>(`select updated_at::text = $2 as same from records where id = $1`, [rec, before])).same).toBe(false);
    });

    it('Change pipeline stage: in that module, on that pipeline', async () => {
      const { rec, a } = await (async () => {
        const auto = await automation({ triggers: [onStatus('high')], flow: [{ id: 's', type: 'change_stage', pipelineId: pipeline, stepId: stageB }] });
        const r = await record();
        await q(`insert into record_pipelines (record_id, module_id, pipeline_id, step_id) values ($1, $2, $3, $4)`, [r, leads, pipeline, stageA]);
        await setValue(sales, r, 'current_status', 'high');
        await work();
        return { rec: r, a: auto };
      })();
      expect((await lastRun(a)).status).toBe('completed');
      expect((await one<{ s: string }>(`select step_id s from record_pipelines where record_id = $1`, [rec])).s).toBe(stageB);
    });

    it('Change pipeline stage: skipped when the record is not on a pipeline in that module, and nothing after it runs', async () => {
      const { a, rec } = await runOn([{ id: 's', type: 'change_stage', pipelineId: pipeline, stepId: stageB }, setStatus('low')]);
      const run = await lastRun(a);
      expect(run.status).toBe('skipped');
      expect(run.reason).toMatch(/isn't on/);
      expect(await statusOf(rec)).toBe('high');
    });

    it('Assign team shows Open', async () => {
      const { rec } = await runOn([{ id: 'x', type: 'assign_team', teamId: team.underwriter }]);
      const row = await one<{ taken_by: string | null }>(`select taken_by from record_team_assignments where record_id = $1 and team_id = $2`, [rec, team.underwriter]);
      expect(row.taken_by).toBeNull();
    });

    it('Assign team on a team already there carries on', async () => {
      const a = await automation({ triggers: [onStatus('high')], flow: [{ id: 'x', type: 'assign_team', teamId: team.underwriter }, setStatus('low')] });
      const rec = await record();
      await as(builder, () => q(`select assign_team($1, $2)`, [rec, team.underwriter]));
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      expect((await lastRun(a)).status).toBe('completed');
      expect(await statusOf(rec)).toBe('low');
    });

    it('Assign specific user takes the team and sits on the field', async () => {
      const { rec } = await runOn([{ id: 'x', type: 'assign_user', userId: uw1 }]);
      const row = await one<{ taken_by: string }>(`select taken_by from record_team_assignments where record_id = $1 and team_id = $2`, [rec, team.underwriter]);
      expect(row.taken_by).toBe(uw1);
      const v = await one<{ v: string[] }>(`select values -> 'team_members_assigned' v from records where id = $1`, [rec]);
      expect(v.v).toContain(uw1);
    });

    it('Assign specific user follows the one-person rule: taken by someone else is a skip', async () => {
      const a = await automation({ triggers: [onStatus('high')], flow: [{ id: 'x', type: 'assign_user', userId: uw2 }] });
      const rec = await record();
      await as(builder, () => q(`select assign_team_member($1, $2, $3)`, [rec, team.underwriter, uw1]));
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      expect((await lastRun(a)).status).toBe('skipped');
    });

    it('Remove team takes off whoever took it too', async () => {
      const a = await automation({ triggers: [onStatus('high')], flow: [{ id: 'x', type: 'remove_team', teamId: team.underwriter }] });
      const rec = await record();
      await as(builder, () => q(`select assign_team_member($1, $2, $3)`, [rec, team.underwriter, uw1]));
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      expect((await lastRun(a)).status).toBe('completed');
      expect((await q(`select 1 from record_team_assignments where record_id = $1 and team_id = $2`, [rec, team.underwriter])).length).toBe(0);
      const v = await one<{ v: string[] }>(`select values -> 'team_members_assigned' v from records where id = $1`, [rec]);
      expect(v.v ?? []).not.toContain(uw1);
    });

    it('Add to module and Remove from module, and the last one archives', async () => {
      const { rec } = await runOn([{ id: 'x', type: 'add_module', moduleId: deals }, { id: 'y', type: 'remove_module', moduleId: leads }]);
      const mods = (await q<{ m: string }>(`select module_id m from record_modules where record_id = $1`, [rec])).map((r) => r.m);
      expect(mods).toEqual([deals]);

      const { rec: last } = await runOn([{ id: 'y', type: 'remove_module', moduleId: leads }]);
      expect((await q(`select 1 from record_modules where record_id = $1`, [last])).length).toBe(0);
      expect((await one<{ body: string }>(`select body from updates where record_id = $1 order by created_at desc limit 1`, [last])).body).toMatch(/Archived/);
    });

    it('A module looked after by a rule can\'t be moved by hand or by an automation', async () => {
      const { a } = await runOn([{ id: 'x', type: 'add_module', moduleId: tickets }]);
      expect((await lastRun(a)).status).toBe('failed');
    });

    it('Create ticket: opened by the automation, in Tickets by the existing rule, with someone to run it', async () => {
      const { rec } = await runOn([{ id: 'x', type: 'create_ticket', title: 'T', issue: 'The issue' }], { team_members_assigned: [] });
      const c = await one<{ id: string; title: string; issue: string; issue_author: string | null; automation_name: string }>(`select * from cases where record_id = $1`, [rec]);
      expect(c).toMatchObject({ title: 'T', issue: 'The issue', issue_author: null });
      expect(c.automation_name).toMatch(/^ZZ auto/);
      expect((await q(`select 1 from record_modules where record_id = $1 and module_id = $2`, [rec, tickets])).length).toBe(1);
      expect((await one<{ n: number }>(`select count(*)::int n from case_managers where case_id = $1`, [c.id])).n).toBeGreaterThan(0);
    });

    it('Create ticket: a blank Title comes from the Issue, and no Issue is a failure', async () => {
      const { rec } = await runOn([{ id: 'x', type: 'create_ticket', title: '', issue: 'Only an issue' }]);
      expect((await one<{ title: string }>(`select title from cases where record_id = $1`, [rec])).title).toBe('Only an issue');
      const { a } = await runOn([{ id: 'x', type: 'create_ticket', title: 'T', issue: '  ' }]);
      expect((await lastRun(a)).status).toBe('failed');
    });

    it('Send notification: assigned members, an assigned team, or the relationship manager; panel only; a mute holds', async () => {
      const members = await runOn([{ id: 'x', type: 'send_notification', who: 'team_members' }], { team_members_assigned: [uw1, uw2] });
      const rm = await runOn([{ id: 'x', type: 'send_notification', who: 'relationship_manager', message: 'Check this' }], { relationship_manager: [uw1] });
      const count = async (rec: string, user: string) => (await one<{ n: number }>(`select count(*)::int n from notifications where record_id = $1 and recipient_id = $2 and source_kind = 'automation'`, [rec, user])).n;
      expect([await count(members.rec, uw1), await count(members.rec, uw2)]).toEqual([1, 1]);
      expect(await count(rm.rec, uw1)).toBe(1);
      expect((await one<{ body: string; email_sent_at: string | null }>(`select body, email_sent_at from notifications where record_id = $1`, [rm.rec]))).toEqual({ body: 'Check this', email_sent_at: null });

      await q(`delete from automation_triggers`);
      const a = await automation({ triggers: [onStatus('high')], flow: [{ id: 'x', type: 'send_notification', who: 'team', teamId: team.underwriter }] });
      const rec = await record();
      await as(builder, () => q(`select assign_team($1, $2)`, [rec, team.underwriter]));
      await q(`insert into notification_mutes (user_id, record_id) values ($1, $2)`, [uw2, rec]);
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      expect((await lastRun(a)).status).toBe('completed');
      expect([await count(rec, uw1), await count(rec, uw2)]).toEqual([1, 0]);
    });

    it('Send notification: nobody to tell is a skip', async () => {
      const { a } = await runOn([{ id: 'x', type: 'send_notification', who: 'relationship_manager' }]);
      expect((await lastRun(a)).status).toBe('skipped');
    });
  });

  // ── round robin ────────────────────────────────────────────────────────────
  describe('round robin', () => {
    const next = async () => {
      const rec = await record();
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      const v = await one<{ v: string[] }>(`select values -> 'team_members_assigned' v from records where id = $1`, [rec]);
      return v.v[0];
    };
    const pool = async (ids: string[]) => {
      const a = await automation({ triggers: [onStatus('high')], flow: [{ id: 'rr', type: 'round_robin', teamIds: [], userIds: ids }] });
      return a;
    };

    it('Goes alphabetically by last name, then wraps', async () => {
      await pool([uw1, uw2]); // Zimmer, Adams
      expect(await next()).toBe(uw2);
      expect(await next()).toBe(uw1);
      expect(await next()).toBe(uw2);
    });

    it('A user with no last name sorts by first name', async () => {
      const cher = await newUser('Cher', 'sales_agent');
      await pool([uw1, uw2, cher]); // Adams, Cher, Zimmer
      expect(await next()).toBe(uw2);
      expect(await next()).toBe(cher);
      expect(await next()).toBe(uw1);
    });

    it('Each automation keeps its own place', async () => {
      const a = await pool([uw1, uw2]);
      expect(await next()).toBe(uw2);
      await q(`delete from automation_triggers`);
      await pool([uw1, uw2]);
      expect(await next()).toBe(uw2);
      await q(`delete from automation_triggers`);
      await q(`select automation_refresh_triggers($1)`, [a]);
      expect(await next()).toBe(uw1);
    });

    it('Skips inactive and archived users', async () => {
      const gone = await newUser('Amy Aaron', 'sales_agent');
      const left = await newUser('Abe Abbott', 'sales_agent');
      await q(`update profiles set status = 'suspended' where id = $1`, [gone]);
      await q(`update profiles set deleted_at = now() where id = $1`, [left]);
      await pool([gone, left, uw2]);
      expect(await next()).toBe(uw2);
      expect(await next()).toBe(uw2);
    });

    it('A team in the rotation follows its membership, each in their alphabetical place', async () => {
      const a = await automation({ triggers: [onStatus('high')], flow: [{ id: 'rr', type: 'round_robin', teamIds: [team.underwriter], userIds: [] }] });
      const members = await q<{ id: string; k: string }>(`select user_id as id, sort_key as k from automation_rotation_pool($1, '{}') order by sort_key collate "C"`, [[team.underwriter]]);
      expect(members.map((m) => m.id)).toContain(uw1);

      const mid = await newUser('Mia Middle', 'underwriter');
      const after = await q<{ id: string }>(`select user_id as id from automation_rotation_pool($1, '{}') order by sort_key collate "C"`, [[team.underwriter]]);
      expect(after.findIndex((m) => m.id === mid)).toBeGreaterThan(after.findIndex((m) => m.id === uw2));
      expect(after.findIndex((m) => m.id === mid)).toBeLessThan(after.findIndex((m) => m.id === uw1));
      expect(a).toBeTruthy();
    });

    it('A skip does not lose anyone their turn', async () => {
      const a = await pool([uw1, uw2]);
      const rec = await record();
      await as(builder, () => q(`select assign_team_member($1, $2, $3)`, [rec, team.underwriter, uw1]));
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      expect((await lastRun(a)).status).toBe('skipped');
      expect(await next()).toBe(uw2);
    });

    it('Nobody active in the rotation is a skip', async () => {
      const gone = await newUser('Zed Gone', 'sales_agent');
      await q(`update profiles set status = 'suspended' where id = $1`, [gone]);
      const a = await pool([gone]);
      const rec = await record();
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      expect((await lastRun(a)).status).toBe('skipped');
    });
  });

  // ── run rules ──────────────────────────────────────────────────────────────
  describe('run rules', () => {
    it('Future events only: nothing that happened before it was switched on', async () => {
      const a = await automation({ triggers: [onStatus('high')], flow: [setStatus('low')] });
      await q(`update automation_triggers set active_from = now() + interval '1 hour' where automation_id = $1`, [a]);
      const rec = await record();
      await setValue(sales, rec, 'current_status', 'high');
      expect(await queued(a)).toBe(0);
    });

    it('No chaining: a change made by an automation never starts another', async () => {
      const first = await automation({ triggers: [onStatus('high')], flow: [setStatus('mid')] });
      const second = await automation({ triggers: [onStatus('mid'), { id: 'f', type: 'field', field: 'current_status' }], flow: [setStatus('low')] });
      const rec = await record();
      await setValue(sales, rec, 'current_status', 'high');
      await q(`delete from automation_queue where automation_id = $1`, [second]);
      await work();
      expect((await lastRun(first)).status).toBe('completed');
      expect(await runs(second)).toHaveLength(0);
      expect(await statusOf(rec)).toBe('mid');
    });

    it('No chaining: its module moves and tickets start nothing either', async () => {
      const first = await automation({ triggers: [onStatus('high')], flow: [{ id: 'm', type: 'add_module', moduleId: deals }, { id: 'c', type: 'create_ticket', issue: 'x' }] });
      const watcher = await automation({ triggers: [{ id: 'a', type: 'module_assigned', moduleId: deals }, { id: 'b', type: 'module_assigned', moduleId: tickets }], flow: [setStatus('low')] });
      const rec = await record();
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      expect((await lastRun(first)).status).toBe('completed');
      expect(await runs(watcher)).toHaveLength(0);
    });

    it('People only: a write with no person behind it starts nothing', async () => {
      const a = await automation({ triggers: [{ id: 't', type: 'field', field: 'mid' }], flow: [setStatus('low')] });
      const rec = await record();
      await q(`update records set values = values || $2 where id = $1`, [rec, { mid: mid() }]);
      expect(await queued(a)).toBe(0);
    });

    it('Full access: it can assign a team the person who set it off may not', async () => {
      const a = await automation({ triggers: [onStatus('high')], flow: [{ id: 'x', type: 'assign_team', teamId: team.accounting }] });
      const rec = await record();
      await q(`savepoint s`);
      let refused = false;
      await q(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [JSON.stringify({ sub: sales, role: 'authenticated' })]);
      try {
        await q(`select assign_team($1, $2)`, [rec, team.accounting]);
      } catch {
        refused = true;
      }
      await q(`rollback to savepoint s`);
      await q(`select set_config('request.jwt.claims', '', true), set_config('role', 'none', true)`);
      expect(refused).toBe(true);

      await setValue(sales, rec, 'current_status', 'high');
      await work();
      expect((await lastRun(a)).status).toBe('completed');
    });

    it('Stop on failure: earlier steps stand, later ones never run, the builder is alerted', async () => {
      const a = await automation({ triggers: [onStatus('high')], flow: [setStatus('mid'), { id: 'bad', type: 'assign_team', teamId: randomUUID() }, setStatus('low')] });
      const rec = await record();
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      const run = await lastRun(a);
      expect(run.status).toBe('failed');
      expect(await statusOf(rec)).toBe('mid');
      const n = await one<{ recipient_id: string; body: string }>(`select * from notifications where automation_run_id = $1 and source_kind = 'automation_alert'`, [run.id]);
      expect(n.recipient_id).toBe(builder);
      expect(n.body).toMatch(/stopped on/);
      const steps = await q<{ outcome: string }>(`select outcome from automation_run_steps where run_id = $1 order by at`, [run.id]);
      expect(steps.map((s) => s.outcome)).toEqual(['done', 'failed']);
    });

    it('The alert goes to every admin when the builder has left', async () => {
      const a = await automation({ triggers: [onStatus('high')], flow: [{ id: 'bad', type: 'assign_team', teamId: randomUUID() }] });
      await q(`update automations set created_by = $2 where id = $1`, [a, sales]);
      await q(`update profiles set status = 'suspended' where id = $1`, [sales]);
      const rec = await record();
      await q(`update profiles set status = 'active' where id = $1`, [sales]);
      await setValue(sales, rec, 'current_status', 'high');
      await q(`update profiles set status = 'suspended' where id = $1`, [sales]);
      await work();
      await q(`update profiles set status = 'active' where id = $1`, [sales]);
      const run = await lastRun(a);
      const alerts = await q<{ recipient_id: string }>(`select recipient_id from notifications where automation_run_id = $1`, [run.id]);
      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts.map((x) => x.recipient_id)).not.toContain(sales);
    });

    it('No re-check after a wait: the conditions stop being true and the steps still run', async () => {
      const a = await automation({
        triggers: [onStatus('high')],
        conditions: { join: 'and', groups: [group('and', { id: 'c', type: 'field_filled', field: 'mid' })] },
        flow: [{ id: 'w', type: 'wait', amount: 2, unit: 'hours' }, setStatus('low')],
      });
      const rec = await record({ mid: mid() });
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      const run = await lastRun(a);
      expect(run.status).toBe('waiting');
      await setValue(sales, rec, 'mid', '');
      await work();
      expect((await lastRun(a)).status).toBe('waiting');
      await expire(run.id);
      await work();
      expect((await lastRun(a)).status).toBe('completed');
      expect(await statusOf(rec)).toBe('low');
    });

    it('A wait goes between two actions, in hours or days', async () => {
      const a = await automation({ triggers: [onStatus('high')], flow: [setStatus('mid'), { id: 'w', type: 'wait', amount: 3, unit: 'days' }, setStatus('low')] });
      const rec = await record();
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      expect(await statusOf(rec)).toBe('mid');
      const { days } = await one<{ days: number }>(`select round(extract(epoch from resume_at - now()) / 86400)::int days from automation_runs where automation_id = $1`, [a]);
      expect(days).toBe(3);
    });

    it('A record already partway through does not start a second time', async () => {
      const a = await automation({ triggers: [{ id: 't', type: 'field', field: 'mid' }], flow: [{ id: 'w', type: 'wait', amount: 1, unit: 'hours' }, setStatus('low')] });
      const rec = await record();
      await setValue(sales, rec, 'mid', mid());
      await work();
      await setValue(sales, rec, 'mid', mid());
      await work();
      const all = await runs(a);
      expect(all.map((r) => r.status)).toEqual(['waiting', 'not_matched']);
      expect(all[1]!.reason).toMatch(/Already running/);
    });

    it('A deleted record ends the run', async () => {
      const a = await automation({ triggers: [onStatus('high')], flow: [{ id: 'w', type: 'wait', amount: 1, unit: 'hours' }, setStatus('low')] });
      const rec = await record();
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      const run = await lastRun(a);
      await q(`update records set deleted_at = now() where id = $1`, [rec]);
      await expire(run.id);
      await work();
      expect((await lastRun(a)).status).toBe('cancelled');
    });
  });

  // ── status ─────────────────────────────────────────────────────────────────
  describe('status', () => {
    it('Draft and Off never run', async () => {
      const draft = await automation({ triggers: [onStatus('high')], flow: [setStatus('low')] }, 'draft');
      const off = await automation({ triggers: [onStatus('high')], flow: [setStatus('low')] }, 'off');
      const rec = await record();
      await setValue(sales, rec, 'current_status', 'high');
      expect([await queued(draft), await queued(off)]).toEqual([0, 0]);
    });

    it('Test runs for real, but only on the one record', async () => {
      const target = await record();
      const other = await record();
      const a = await automation({ triggers: [onStatus('high')], flow: [setStatus('low')] }, 'test', target);
      await setValue(sales, other, 'current_status', 'high');
      expect(await queued(a)).toBe(0);
      await setValue(sales, target, 'current_status', 'high');
      await work();
      expect(await statusOf(target)).toBe('low');
      expect(await statusOf(other)).toBe('high');
    });

    it('Off ends what was waiting', async () => {
      const a = await automation({ triggers: [onStatus('high')], flow: [{ id: 'w', type: 'wait', amount: 1, unit: 'hours' }, setStatus('low')] });
      const rec = await record();
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      const { ended } = await one<{ ended: number }>(`select automation_set_status($1, 'off', null, $2) as ended`, [a, builder]);
      expect(ended).toBe(1);
      expect((await lastRun(a)).status).toBe('cancelled');
      expect(await statusOf(rec)).toBe('high');
    });

    it('An event queued just before it was switched off does not run', async () => {
      const a = await automation({ triggers: [onStatus('high')], flow: [setStatus('low')] });
      const rec = await record();
      await setValue(sales, rec, 'current_status', 'high');
      await q(`select automation_set_status($1, 'off', null, $2)`, [a, builder]);
      await work();
      expect(await runs(a)).toHaveLength(0);
    });

    it('Delete stops it, and the history stays', async () => {
      const a = await automation({ triggers: [onStatus('high')], flow: [{ id: 'w', type: 'wait', amount: 1, unit: 'hours' }, setStatus('low')] });
      const rec = await record();
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      await q(`select automation_delete($1, $2)`, [a, builder]);
      expect((await one<{ n: number }>(`select count(*)::int n from automation_triggers where automation_id = $1`, [a])).n).toBe(0);
      expect(await runs(a)).toHaveLength(1);
    });
  });

  // ── what people see ────────────────────────────────────────────────────────
  describe('what people see', () => {
    it('Updates shows every action as done by the automation, also to someone on Only mine', async () => {
      const a = await automation({ triggers: [onStatus('high')], flow: [setStatus('low')] });
      const rec = await record({ team_members_assigned: [sales] });
      await q(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, 'items.updates', 'mine') on conflict (owner_kind, owner_id, key) do update set value = 'mine'`, [sales]);
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      expect((await lastRun(a)).status).toBe('completed');
      const seen = await as(sales, () => q<{ body: string; author_id: string | null; automation_name: string }>(`select body, author_id, automation_name from updates where record_id = $1`, [rec]));
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ author_id: null });
      expect(seen[0]!.automation_name).toMatch(/^ZZ auto/);
    });

    it('The team rules still hide an automation\'s assignment entry', async () => {
      const rec = await record({ team_members_assigned: [sales] });
      await q(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, 'team.underwriter.see_team', 'no') on conflict (owner_kind, owner_id, key) do update set value = 'no'`, [sales]);
      const a = await automation({ triggers: [onStatus('high')], flow: [{ id: 'x', type: 'assign_team', teamId: team.underwriter }] });
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      expect((await lastRun(a)).status).toBe('completed');
      expect((await q(`select 1 from updates where record_id = $1`, [rec])).length).toBe(1);
      const seen = await as(sales, () => q(`select body from updates where record_id = $1`, [rec]));
      expect(seen).toHaveLength(0);
    });

    it('A person can\'t post as an automation by leaving the author off', async () => {
      await expect(q(`savepoint s`).then(() => q(`insert into updates (record_id, body) values ($1, 'x')`, [randomUUID()]))).rejects.toThrow();
      await q(`rollback to savepoint s`);
    });

    it('The icon: everyone who can see the record; switching off by team, narrowed by user', async () => {
      const a = await automation(
        { triggers: [onStatus('high')], flow: [{ id: 'w', type: 'wait', amount: 1, unit: 'hours' }, setStatus('low')] },
        'on',
        null,
        { stopTeams: [team.underwriter], stopUsers: [uw1] },
      );
      const rec = await record({ team_members_assigned: [sales, uw1, uw2] });
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      const run = await lastRun(a);

      const view = (u: string) => as(u, () => q<{ can_switch_off: boolean }>(`select * from automation_waiting_on($1)`, [rec]));
      expect((await view(sales))[0]!.can_switch_off).toBe(false);
      expect((await view(uw2))[0]!.can_switch_off).toBe(false);
      expect((await view(uw1))[0]!.can_switch_off).toBe(true);

      await q(`savepoint s`);
      await q(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [JSON.stringify({ sub: sales, role: 'authenticated' })]);
      await expect(q(`select automation_switch_off($1)`, [run.id])).rejects.toThrow(/cannot switch/);
      await q(`rollback to savepoint s`);
      await q(`select set_config('request.jwt.claims', '', true), set_config('role', 'none', true)`);

      await as(uw1, () => q(`select automation_switch_off($1)`, [run.id]));
      expect((await lastRun(a)).status).toBe('switched_off');
      await expire(run.id);
      await work();
      expect(await statusOf(rec)).toBe('high');
      const up = await one<{ body: string; author_id: string }>(`select body, author_id from updates where record_id = $1 and body like 'Switched off%'`, [rec]);
      expect(up.author_id).toBe(uw1);
    });

    it('The icon is absent for someone who can\'t see the record', async () => {
      const a = await automation({ triggers: [onStatus('high')], flow: [{ id: 'w', type: 'wait', amount: 1, unit: 'hours' }, setStatus('low')] });
      const rec = await record();
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      expect((await lastRun(a)).status).toBe('waiting');
      const hidden = await newUser('Nora None', 'customer_service');
      await q(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, $2, 'mine')`, [hidden, `module:${leads}`]);
      expect(await as(hidden, () => q(`select * from automation_waiting_on($1)`, [rec]))).toEqual([]);
    });

    it('Notifications: an automation\'s needs the record; the alert reaches the builder', async () => {
      const rec = await record({ relationship_manager: [uw1] });
      const a = await automation({ triggers: [onStatus('high')], flow: [{ id: 'x', type: 'send_notification', who: 'relationship_manager' }] });
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      expect((await lastRun(a)).status).toBe('completed');
      const visible = async (u: string) => (await as(u, () => one<{ n: number }>(`select count(*)::int n from notifications n where n.record_id = $1 and notification_visible(n)`, [rec]))).n;
      expect(await visible(uw1)).toBe(1);
      await q(`update records set deleted_at = now() where id = $1`, [rec]);
      expect(await visible(uw1)).toBe(0);
    });
  });

  // ── versions ───────────────────────────────────────────────────────────────
  describe('editing one that is running', () => {
    const save = (a: string, steps: unknown, move: boolean) => q(`select automation_save($1, 'ZZ auto edited', $2, '{}', '{}', $3, $4)`, [a, steps, move, builder]);
    const start = async () => {
      const flow = [{ id: 'w', type: 'wait', amount: 1, unit: 'hours' }, { id: 'after', type: 'change_status', value: 'low' }];
      const a = await automation({ triggers: [onStatus('high')], flow });
      const rec = await record();
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      return { a, rec, run: await lastRun(a), flow };
    };
    const edited = (flow: Step[]) => ({ triggers: [onStatus('high')], conditions: { join: 'and', groups: [] }, flow });

    it('Finish on the old version', async () => {
      const { a, rec, run, flow } = await start();
      await save(a, edited([flow[0]!, { id: 'after', type: 'change_status', value: 'mid' }]), false);
      await expire(run.id);
      await work();
      expect(await statusOf(rec)).toBe('low');
    });

    it('Finish on the new version', async () => {
      const { a, rec, run, flow } = await start();
      await save(a, edited([flow[0]!, { id: 'after', type: 'change_status', value: 'mid' }]), true);
      await expire(run.id);
      await work();
      expect(await statusOf(rec)).toBe('mid');
    });

    it('A saved edit is what the next event uses, and an unchanged save makes no version', async () => {
      const a = await automation({ triggers: [onStatus('high')], flow: [setStatus('low')] });
      const steps = (await one<{ steps: unknown }>(`select v.steps from automations a join automation_versions v on v.id = a.current_version_id where a.id = $1`, [a])).steps;
      await save(a, steps, false);
      expect((await one<{ n: number }>(`select count(*)::int n from automation_versions where automation_id = $1`, [a])).n).toBe(1);

      await save(a, edited([setStatus('mid')]), false);
      expect((await one<{ n: number }>(`select count(*)::int n from automation_versions where automation_id = $1`, [a])).n).toBe(2);
      const rec = await record();
      await setValue(sales, rec, 'current_status', 'high');
      await work();
      expect(await statusOf(rec)).toBe('mid');
    });
  });

  describe('the permission', () => {
    it('Automations alone has a View only level', async () => {
      const ok = async (k: string, v: string) => (await one<{ ok: boolean }>(`select permission_setting_valid($1, $2) ok`, [k, v])).ok;
      expect(await ok('admin.automations', 'view')).toBe(true);
      expect(await ok('admin.automations', 'full')).toBe(true);
      expect(await ok('admin.automations', 'hidden')).toBe(true);
      expect(await ok('admin.users', 'view')).toBe(false);
      expect(await ok('admin.users', 'full')).toBe(true);
    });

    it('The admin tables are closed to a signed-in viewer', async () => {
      await automation({ triggers: [onStatus('high')], flow: [setStatus('low')] });
      for (const t of ['automations', 'automation_versions', 'automation_runs', 'automation_queue', 'automation_files', 'record_contact_emails', 'mail_record_links']) {
        await q(`savepoint s`);
        await q(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [JSON.stringify({ sub: builder, role: 'authenticated' })]);
        const rows = await q(`select 1 from ${t} limit 1`).catch(() => []);
        await q(`rollback to savepoint s`);
        await q(`select set_config('request.jwt.claims', '', true), set_config('role', 'none', true)`);
        expect(rows).toEqual([]);
      }
    });
  });
});
