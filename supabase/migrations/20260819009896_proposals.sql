-- =============================================================================
-- Proposals (client: "Proposal template Instructions" + "Proposal items",
-- 3 Nov 2026). An online proposal only, for now: mobile friendly, previewed
-- before it goes, approved by the merchant with one click, and the approval
-- registered on the record.
--
-- Fields it reads, all new:
--   Applications › Prior Processor
--     Savings description                       page 2's words
--     Prior monthly volume, Prior effective rate, Tenor effective rate,
--     Prior monthly total transactions, Prior auth fees, Tenor auth fees,
--     Prior monthly fees, Tenor monthly fees    the Savings Analysis table
--     Include POS Architecture page, POS description,
--     Merchant requirements, Tenor additional features (rows, each with a tick
--     that shows as a check or an X)            page 3
--   Merchant setup › Merchant Direct Relationships
--     Include Detailed POS page                 page 4, from the rows ticked
--                                               "In proposal"
--
-- Where the Send proposal panel lives is a tab flag, `tabs.shows_proposals`,
-- set on Files beside the Send agreement panel.
--
-- A proposal is frozen at send: `content` is exactly what the merchant sees,
-- so a later edit to the record never changes a proposal already out. Only a
-- hash of its link is kept.
-- =============================================================================

alter type activity_kind add value if not exists 'proposal';

-- ── the panel's place ────────────────────────────────────────────────────────
alter table tabs add column if not exists shows_proposals boolean not null default false;
update tabs set shows_proposals = true where kind = 'files';

create or replace function proposals_tab_key()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select key::text from tabs where shows_proposals order by position limit 1;
$$;

-- ── fields ───────────────────────────────────────────────────────────────────
do $$
declare
  t_app   uuid := (select id from tabs where key = 'application');
  s_prior uuid := (select s.id from subtabs s join tabs t on t.id = s.tab_id where t.key = 'application' and s.key = 'prior');
  t_setup uuid := (select id from tabs where key = 'pricing');
  s_mdr   uuid := (select s.id from subtabs s join tabs t on t.id = s.tab_id where t.key = 'pricing' and s.key = 'other_vendor');
  tip     text := ' Used on the proposal''s Savings Analysis page.';
begin
  if t_app is null or s_prior is null or s_mdr is null then raise exception 'Proposals: the tabs it expects are not all here.'; end if;

  insert into fields (key, label, type, tab_id, subtab_id, position, section, hint, wide) values
    ('savings_description',        'Savings description',              'long_text',  t_app, s_prior, 900, 'Proposal: Savings Analysis',
       'The words above the Savings Analysis table on the proposal. Leave empty for the standard paragraph.', true),
    ('prior_monthly_volume',       'Prior monthly volume',             'currency',   t_app, s_prior, 910, 'Proposal: Savings Analysis',
       'Monthly card volume on the current processor.' || tip, false),
    ('prior_effective_rate',       'Prior effective rate',             'percentage', t_app, s_prior, 920, 'Proposal: Savings Analysis',
       'The current processor''s effective rate on that volume.' || tip, false),
    ('tenor_effective_rate',       'Tenor effective rate',             'percentage', t_app, s_prior, 930, 'Proposal: Savings Analysis',
       'Tenor''s effective rate on the same volume.' || tip, false),
    ('prior_monthly_transactions', 'Prior monthly total transactions', 'number',     t_app, s_prior, 940, 'Proposal: Savings Analysis',
       'Number of transactions a month.' || tip, false),
    ('prior_auth_fees',            'Prior auth fees',                  'currency',   t_app, s_prior, 950, 'Proposal: Savings Analysis',
       'The current processor''s fee per transaction.' || tip, false),
    ('tenor_auth_fees',            'Tenor auth fees',                  'currency',   t_app, s_prior, 960, 'Proposal: Savings Analysis',
       'Tenor''s fee per transaction.' || tip, false),
    ('prior_monthly_fees',         'Prior monthly fees',               'currency',   t_app, s_prior, 970, 'Proposal: Savings Analysis',
       'Monthly fees on the current processor.' || tip, false),
    ('tenor_monthly_fees',         'Tenor monthly fees',               'currency',   t_app, s_prior, 980, 'Proposal: Savings Analysis',
       'Tenor''s monthly fees.' || tip, false),
    ('pos_in_proposal',            'Include POS Architecture page',    'checkbox',   t_app, s_prior, 1000, 'Proposal: POS Architecture',
       'Ticked, the proposal has a POS Architecture page with the description and lists below.', false),
    ('pos_description',            'POS description',                  'long_text',  t_app, s_prior, 1010, 'Proposal: POS Architecture',
       'The recommended solution, as the POS Architecture page describes it.', true)
  on conflict (key) do nothing;

  insert into fields (key, label, type, tab_id, subtab_id, position, section, hint, wide, grid_columns) values
    ('merchant_requirements', 'Merchant requirements', 'grid', t_app, s_prior, 1020, 'Proposal: POS Architecture',
       'One row per requirement. Ticked shows a check on the proposal; unticked shows an X.', true,
       '[{"label":"Requirement","type":"text"},{"label":"Check","type":"checkbox"}]'::jsonb),
    ('tenor_features',        'Tenor additional features', 'grid', t_app, s_prior, 1030, 'Proposal: POS Architecture',
       'One row per feature. Ticked shows a check on the proposal; unticked shows an X.', true,
       '[{"label":"Feature","type":"text"},{"label":"Check","type":"checkbox"}]'::jsonb)
  on conflict (key) do nothing;

  insert into fields (key, label, type, tab_id, subtab_id, position, hint, wide) values
    ('pos_detail_in_proposal', 'Include Detailed POS page', 'checkbox', t_setup, s_mdr, 0,
       'Ticked, the proposal lists the rows below that are ticked "In proposal".', false)
  on conflict (key) do nothing;
  update fields set position = 10 where key = 'merchant_direct_relationships';
end $$;

-- ── proposals ────────────────────────────────────────────────────────────────
create sequence if not exists proposal_number_seq start 1;

create table if not exists proposals (
  id             uuid primary key default gen_random_uuid(),
  number         bigint not null unique default nextval('proposal_number_seq'),
  record_id      uuid not null references records(id) on delete cascade,
  token_hash     bytea not null unique,
  status         text not null default 'sent' check (status in ('sent', 'viewed', 'approved', 'voided')),
  content        jsonb not null,
  recipient      citext not null,
  cc             citext[] not null default '{}',
  subject        text,
  sent_by        uuid references profiles(id) on delete set null,
  sent_at        timestamptz not null default now(),
  expires_at     timestamptz not null,
  viewed_at      timestamptz,
  approved_at    timestamptz,
  approved_ip    text,
  approved_agent text,
  voided_at      timestamptz,
  voided_by      uuid references profiles(id) on delete set null
);
create index if not exists proposals_record on proposals (record_id, sent_at desc);

alter table proposals enable row level security;
alter table proposals force row level security;
-- No policy and no grant: read and written by the service after the gate, and
-- by the merchant's link through the functions below.
revoke all on proposals from anon, authenticated;

create or replace function proposal_label(p_number bigint)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select 'PRO-' || lpad(p_number::text, 6, '0');
$$;

/* The record's history: Updates and the activity log, in one go. */
create or replace function proposal_log(p_proposal uuid, p_actor uuid, p_summary text, p_actor_label text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p proposals;
begin
  select * into p from proposals where id = p_proposal;
  if not found then return; end if;
  perform record_log(p.record_id, p_actor, 'proposal', p_summary, '[]'::jsonb, null, null, p_actor_label);
end;
$$;

/* The merchant opened their link: first time only. */
create or replace function proposal_viewed(p_proposal uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update proposals set status = 'viewed', viewed_at = now()
   where id = p_proposal and status = 'sent' and viewed_at is null;
  if found then
    perform proposal_log(p_proposal, null, 'Proposal ' || (select proposal_label(number) from proposals where id = p_proposal) || ' opened by the merchant.', 'Merchant');
  end if;
end;
$$;

/* "Click here to approve proposal – When this is done the CRM registers an
   approval": the status, the history, and a notification to whoever sent it
   and the record's relationship manager. Once only. */
create or replace function proposal_approve(p_proposal uuid, p_ip text, p_agent text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p      proposals;
  v_body text;
  u      uuid;
begin
  select * into p from proposals where id = p_proposal for update;
  if not found or p.status not in ('sent', 'viewed') or p.expires_at <= now() then return false; end if;
  update proposals set status = 'approved', approved_at = now(), approved_ip = left(p_ip, 100), approved_agent = left(p_agent, 300),
         viewed_at = coalesce(viewed_at, now())
   where id = p.id;
  v_body := 'Proposal ' || proposal_label(p.number) || ' approved by the merchant.';
  perform proposal_log(p.id, null, v_body, 'Merchant');
  for u in
    select distinct x.id from (
      select p.sent_by as id
      union all
      select x::uuid from records r
       cross join lateral jsonb_array_elements_text(
         case when jsonb_typeof(r.values -> 'relationship_manager') = 'array' then r.values -> 'relationship_manager' else '[]'::jsonb end) x
       where r.id = p.record_id
    ) x
    join profiles pr on pr.id = x.id and pr.status = 'active' and pr.deleted_at is null
  loop
    continue when exists (select 1 from notification_mutes m where m.user_id = u and m.record_id = p.record_id);
    insert into notifications (recipient_id, actor_id, body, record_id, source_kind, preview)
    values (u, null, v_body, p.record_id, 'proposal', proposal_label(p.number));
  end loop;
  return true;
end;
$$;

alter table notifications drop constraint if exists notifications_source_kind_check;
alter table notifications add constraint notifications_source_kind_check check (
  source_kind in ('update', 'mention', 'case', 'call', 'voicemail', 'recording', 'sms',
                  'mention_update', 'mention_case_reply', 'mention_field', 'agreement',
                  'automation', 'automation_alert', 'proposal'));

-- An approval counts with the mentions in the sidebar badge, as agreement news does.
create or replace function public.my_unread_counts()
returns table (mentions int, phone int)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    count(*) filter (where n.source_kind like 'mention\_%' or n.source_kind in ('agreement', 'automation', 'automation_alert', 'proposal'))::int,
    count(*) filter (where n.source_kind in ('call', 'voicemail', 'recording', 'sms'))::int
    from notifications n
   where n.recipient_id = auth.uid()
     and n.read_at is null
     and n.created_at >= now() - interval '90 days'
     and notification_visible(n);
$$;

-- A proposal's news is seen by whoever may open the record's proposals tab,
-- and opens on it (9850's and 9839's bodies, plus the 'proposal' branch).
create or replace function public.notification_visible(n public.notifications)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select n.revoked_at is null
     and (
       (n.source_kind not like 'mention\_%' and n.source_kind not in ('agreement', 'automation', 'proposal'))
       or (n.source_kind = 'automation' and record_visible(n.record_id))
       or (n.source_kind = 'agreement' and record_visible(n.record_id) and tab_visible(n.record_id, agreements_tab_key()))
       or (n.source_kind = 'proposal' and record_visible(n.record_id) and tab_visible(n.record_id, proposals_tab_key()))
       or (
         n.source_kind like 'mention\_%'
         and record_visible(n.record_id)
         and case n.source_kind
               when 'mention_update' then
                 tab_visible(n.record_id, 'updates')
                 and exists (select 1 from updates u
                              where u.id = n.update_id and u.deleted_at is null
                                and (u.parent_id is null or exists (select 1 from updates p where p.id = u.parent_id and p.deleted_at is null)))
               when 'mention_case_reply' then
                 tab_visible(n.record_id, 'cases')
                 and exists (select 1 from case_replies r join cases c on c.id = r.case_id
                              where r.id = n.case_reply_id and r.deleted_at is null and c.deleted_at is null)
               when 'mention_field' then
                 record_field_grant(n.record_id, n.field_key::text) <> 'hidden'
                 and exists (select 1 from fields f where f.key = n.field_key and f.archived_at is null)
               else false
             end
       )
     );
$$;

create or replace function public.notification_rows(p_ids uuid[])
returns setof public.notification_row
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select n.id, n.source_kind, n.record_id, r.deal_name, n.actor_id, a.full_name,
         n.update_id, u.parent_id, n.case_id, c.number, n.case_reply_id,
         n.field_key::text, f.label,
         case n.source_kind
           when 'mention_update' then 'updates'
           when 'mention_case_reply' then 'cases'
           when 'mention_field' then t.key::text
           when 'agreement' then agreements_tab_key()
           when 'proposal' then proposals_tab_key()
           else null end,
         case when n.source_kind = 'mention_field' then s.key::text else null end,
         n.body, n.preview, n.note, n.current_value, n.previous_value,
         n.created_at, n.read_at, n.opened_at
    from notifications n
    left join records r on r.id = n.record_id
    left join profiles a on a.id = n.actor_id
    left join updates u on u.id = n.update_id
    left join cases c on c.id = n.case_id
    left join fields f on f.key = n.field_key
    left join tabs t on t.id = f.tab_id
    left join subtabs s on s.id = f.subtab_id
   where n.id = any (p_ids)
     and n.recipient_id = auth.uid()
     and notification_visible(n);
$$;

revoke all on function proposals_tab_key() from public, anon;
grant execute on function proposals_tab_key() to authenticated;
revoke all on function proposal_label(bigint) from public, anon;
grant execute on function proposal_label(bigint) to authenticated;
revoke all on function proposal_log(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function proposal_viewed(uuid) from public, anon, authenticated;
grant execute on function proposal_viewed(uuid) to service_role;
revoke all on function proposal_approve(uuid, text, text) from public, anon, authenticated;
grant execute on function proposal_approve(uuid, text, text) to service_role;

notify pgrst, 'reload schema';
