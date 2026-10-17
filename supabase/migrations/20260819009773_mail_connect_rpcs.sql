-- =============================================================================
-- The Email module — what connecting a mailbox needs from the database.
--
-- All SERVICE ROLE ONLY. They are called by the OAuth callback and the sync
-- engine after those have done their own checks; a signed-in session can
-- reach none of them.
--
--   mail_apply_folder_tree    one Graph folder enumeration → mail_folders, in
--                             one transaction (upsert, parent links, removals)
--   mail_enqueue              coalesced work item for the sync engine
--   mail_enqueue_bootstrap    the first round of work for a new mailbox
--   mail_mark_identity_broken a dead refresh token: identity + its connections
--                             broken, and every mailbox it was pulling handed
--                             to another live connector (or marked broken)
-- =============================================================================

-- ── folder tree ─────────────────────────────────────────────────────────────
-- p_folders: [{graph_id, parent_graph_id, display_name, well_known, depth,
--              total_count, unread_count, child_count, tier}]
-- p_complete: the list is the WHOLE tree, so folders missing from it are gone.
create or replace function public.mail_apply_folder_tree(
  p_mailbox_id uuid,
  p_folders    jsonb,
  p_complete   boolean
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  if jsonb_typeof(p_folders) <> 'array' then
    raise exception 'p_folders must be an array.' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_folders);
  -- An empty "complete" tree is a bad response, never a real mailbox (Inbox
  -- cannot be deleted). Refuse rather than soft-delete every folder.
  if p_complete and v_count = 0 then
    raise exception 'Refusing to apply an empty folder tree.' using errcode = '22023';
  end if;

  -- A well-known name that now points at a different folder (rare: Archive
  -- recreated) is released first, so the partial unique index never trips.
  update public.mail_folders f
     set well_known = null, updated_at = now()
   where f.mailbox_id = p_mailbox_id
     and f.well_known is not null
     and exists (select 1 from jsonb_to_recordset(p_folders) as t(graph_id text, well_known text)
                  where t.well_known = f.well_known and t.graph_id <> f.graph_id);

  insert into public.mail_folders as f
    (mailbox_id, graph_id, parent_graph_id, display_name, well_known, depth,
     total_count, unread_count, child_count, tier)
  select p_mailbox_id, t.graph_id, t.parent_graph_id, t.display_name, t.well_known, t.depth,
         t.total_count, t.unread_count, t.child_count, t.tier
    from (select x.graph_id, x.parent_graph_id, left(coalesce(x.display_name, ''), 255) as display_name, x.well_known,
               greatest(coalesce(x.depth, 0), 0)::smallint as depth, greatest(coalesce(x.total_count, 0), 0) as total_count,
               greatest(coalesce(x.unread_count, 0), 0) as unread_count, greatest(coalesce(x.child_count, 0), 0) as child_count,
               coalesce(x.tier, 'cold') as tier
          from jsonb_to_recordset(p_folders) as x(
            graph_id text, parent_graph_id text, display_name text, well_known text,
            depth int, total_count int, unread_count int, child_count int, tier text)
         where x.graph_id is not null and x.graph_id <> '') t
  on conflict (mailbox_id, graph_id) do update
     set parent_graph_id = excluded.parent_graph_id,
         display_name    = excluded.display_name,
         -- A failed well-known lookup arrives as null: keep what we knew.
         well_known      = coalesce(excluded.well_known, f.well_known),
         tier            = case when excluded.well_known is not null then excluded.tier else f.tier end,
         depth           = excluded.depth,
         total_count     = excluded.total_count,
         unread_count    = excluded.unread_count,
         child_count     = excluded.child_count,
         deleted_at      = null,
         updated_at      = now();

  update public.mail_folders c
     set parent_folder_id = p.id
    from public.mail_folders p
   where c.mailbox_id = p_mailbox_id and p.mailbox_id = p_mailbox_id
     and p.graph_id = c.parent_graph_id and p.deleted_at is null
     and c.parent_folder_id is distinct from p.id;

  update public.mail_folders c
     set parent_folder_id = null
   where c.mailbox_id = p_mailbox_id and c.parent_folder_id is not null
     and not exists (select 1 from public.mail_folders p
                      where p.id = c.parent_folder_id and p.graph_id = c.parent_graph_id and p.deleted_at is null);

  if p_complete then
    update public.mail_folders f
       set deleted_at = now(), well_known = null, updated_at = now()
     where f.mailbox_id = p_mailbox_id and f.deleted_at is null
       and not exists (select 1 from jsonb_to_recordset(p_folders) as t(graph_id text) where t.graph_id = f.graph_id);
  end if;

  update public.mail_mailboxes
     set folders_synced_at = now(), last_graph_ok_at = now(), updated_at = now()
   where id = p_mailbox_id;

  return v_count;
end;
$$;

-- ── queue ───────────────────────────────────────────────────────────────────
-- One unprocessed row per (mailbox, kind, target): asking twice raises the
-- priority and brings the time forward, never duplicates the work.
create or replace function public.mail_enqueue(
  p_mailbox_id    uuid,
  p_kind          text,
  p_target        text default '',
  p_priority      smallint default 5,
  p_payload       jsonb default '{}'::jsonb,
  p_delay_seconds int default 0
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.mail_sync_queue (mailbox_id, kind, target, priority, payload, not_before)
  values (p_mailbox_id, p_kind, coalesce(p_target, ''), p_priority, coalesce(p_payload, '{}'::jsonb),
          now() + make_interval(secs => greatest(coalesce(p_delay_seconds, 0), 0)))
  on conflict (mailbox_id, kind, target) where processed_at is null
  do update set priority     = least(mail_sync_queue.priority, excluded.priority),
                not_before   = least(mail_sync_queue.not_before, excluded.not_before),
                payload      = mail_sync_queue.payload || excluded.payload,
                requested_at = now();
$$;

-- First work for a mailbox: seed the hot folders first (priority 2), then every
-- other folder that has mail (5), plus the subscription, rules and contacts.
-- Idempotent: a reconnect calls it again and only unseeded folders queue.
create or replace function public.mail_enqueue_bootstrap(p_mailbox_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  insert into public.mail_sync_queue (mailbox_id, kind, target, priority)
  select p_mailbox_id, 'seed_folder', f.id::text, case when f.tier = 'hot' then 2 else 5 end
    from public.mail_folders f
   where f.mailbox_id = p_mailbox_id and f.deleted_at is null and f.seeded_at is null
     and coalesce(f.well_known, '') <> 'outbox'
     and (f.tier = 'hot' or f.total_count > 0)
  on conflict (mailbox_id, kind, target) where processed_at is null
  do update set priority = least(mail_sync_queue.priority, excluded.priority), requested_at = now();
  get diagnostics v_n = row_count;

  perform public.mail_enqueue(p_mailbox_id, 'subscription_ensure', '', 3::smallint);
  perform public.mail_enqueue(p_mailbox_id, 'rules_refresh', '', 6::smallint);
  perform public.mail_enqueue(p_mailbox_id, 'contacts_delta', '', 6::smallint);
  return v_n;
end;
$$;

-- ── a dead sign-in ──────────────────────────────────────────────────────────
-- Called when Microsoft refuses an identity's refresh token for good. The
-- connections go 'broken' (which is what raises the Reconnect bar — it is
-- derived from mail_connections.status_changed_at, not stored as a notice),
-- and each mailbox this identity was PULLING is handed to another connector
-- whose sign-in still works, so a shared mailbox keeps syncing for everyone
-- else. With nobody left, the mailbox itself is broken.
create or replace function public.mail_mark_identity_broken(
  p_identity_id uuid,
  p_code        text,
  p_detail      text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mb record;
  v_next uuid;
begin
  update public.mail_identities
     set status = 'broken',
         status_changed_at = case when status = 'broken' then status_changed_at else now() end,
         last_error_code = left(p_code, 64), last_error = left(p_detail, 500), last_error_at = now(),
         consecutive_auth_failures = consecutive_auth_failures + 1, updated_at = now()
   where id = p_identity_id and deleted_at is null;

  update public.mail_connections
     set status = 'broken', status_changed_at = now(),
         last_error_code = left(p_code, 64), last_error = left(p_detail, 500), last_error_at = now(),
         updated_at = now()
   where identity_id = p_identity_id and disconnected_at is null and status <> 'broken';

  delete from public.mail_identity_secrets where identity_id = p_identity_id;

  for v_mb in
    select id from public.mail_mailboxes
     where sync_identity_id = p_identity_id and deleted_at is null
     for update
  loop
    select c.identity_id into v_next
      from public.mail_connections c
      join public.mail_identities i on i.id = c.identity_id
     where c.mailbox_id = v_mb.id and c.disconnected_at is null and c.status in ('ok', 'degraded')
       and i.status in ('ok', 'degraded') and i.deleted_at is null and i.id <> p_identity_id
       and exists (select 1 from public.mail_identity_secrets s where s.identity_id = i.id)
     order by c.connected_at
     limit 1;

    if v_next is not null then
      update public.mail_mailboxes
         set sync_identity_id = v_next, consecutive_failures = 0, updated_at = now()
       where id = v_mb.id;
      perform public.mail_enqueue(v_mb.id, 'subscription_ensure', '', 1::smallint);
    else
      update public.mail_mailboxes
         set sync_status = 'broken', last_error_code = left(p_code, 64), last_error = left(p_detail, 500),
             last_error_at = now(), subscription_healthy = false, updated_at = now()
       where id = v_mb.id;
    end if;
  end loop;
end;
$$;

revoke all on function public.mail_apply_folder_tree(uuid, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.mail_enqueue(uuid, text, text, smallint, jsonb, int) from public, anon, authenticated;
revoke all on function public.mail_enqueue_bootstrap(uuid) from public, anon, authenticated;
revoke all on function public.mail_mark_identity_broken(uuid, text, text) from public, anon, authenticated;
grant execute on function public.mail_apply_folder_tree(uuid, jsonb, boolean) to service_role;
grant execute on function public.mail_enqueue(uuid, text, text, smallint, jsonb, int) to service_role;
grant execute on function public.mail_enqueue_bootstrap(uuid) to service_role;
grant execute on function public.mail_mark_identity_broken(uuid, text, text) to service_role;

-- ── mail_connect_mailbox, redefined: a reconnect heals sibling connections ──
-- Same signature, grants unchanged (create or replace keeps them). The only
-- addition is the block after the identity upsert.
create or replace function public.mail_connect_mailbox(
  p_user_id            uuid,
  p_microsoft_user_id  text,
  p_tenant_id          text,
  p_primary_email      citext,
  p_identity_display   text,
  p_scopes             text[],
  p_missing_scopes     text[],
  p_refresh_enc        bytea,
  p_refresh_iv         bytea,
  p_kind               text,
  p_address            citext,
  p_mailbox_display    text,
  p_graph_user_id      text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_identity   uuid;
  v_mailbox    public.mail_mailboxes%rowtype;
  v_created    boolean := false;
  v_conn       uuid;
  v_reconnect  boolean := false;
  v_status     text := case when coalesce(array_length(p_missing_scopes, 1), 0) > 0 then 'degraded' else 'ok' end;
begin
  if p_kind not in ('personal', 'shared') then
    raise exception 'Invalid mailbox kind.' using errcode = '22023';
  end if;

  -- identity
  select id into v_identity from public.mail_identities
   where user_id = p_user_id and microsoft_user_id = p_microsoft_user_id and deleted_at is null
   for update;
  if found then
    update public.mail_identities
       set tenant_id = p_tenant_id, primary_email = p_primary_email, display_name = coalesce(p_identity_display, ''),
           scopes = p_scopes, missing_scopes = coalesce(p_missing_scopes, '{}'),
           status = v_status, status_changed_at = now(), consecutive_auth_failures = 0,
           last_error_code = null, last_error = null, last_error_at = null, last_token_ok_at = now()
     where id = v_identity;
  else
    insert into public.mail_identities
      (user_id, microsoft_user_id, tenant_id, primary_email, display_name, scopes, missing_scopes, status, last_token_ok_at)
    values
      (p_user_id, p_microsoft_user_id, p_tenant_id, p_primary_email, coalesce(p_identity_display, ''),
       p_scopes, coalesce(p_missing_scopes, '{}'), v_status, now())
    returning id into v_identity;
  end if;

  -- A reconnect heals what the dead sign-in broke: this identity's OTHER
  -- connections that failed for auth reasons (not ones whose Outlook access
  -- was removed — a new token does not restore delegation), and mailboxes
  -- left with nobody able to pull them.
  update public.mail_connections
     set status = v_status, status_changed_at = now(),
         last_error_code = null, last_error = null, last_error_at = null, updated_at = now()
   where identity_id = v_identity and disconnected_at is null and status = 'broken'
     and coalesce(last_error_code, '') in ('reconnect_required', 'consent_required', 'token_expired');
  update public.mail_mailboxes m
     set sync_identity_id = v_identity, sync_status = 'pending', consecutive_failures = 0,
         last_error_code = null, last_error = null, updated_at = now()
   where m.deleted_at is null and m.sync_status in ('broken', 'stalled')
     and coalesce(m.last_error_code, '') in ('reconnect_required', 'consent_required', 'token_expired')
     and exists (select 1 from public.mail_connections c
                  where c.mailbox_id = m.id and c.identity_id = v_identity and c.disconnected_at is null);

  insert into public.mail_identity_secrets (identity_id, refresh_token_enc, refresh_token_iv, updated_at)
  values (v_identity, p_refresh_enc, p_refresh_iv, now())
  on conflict (identity_id) do update
     set refresh_token_enc = excluded.refresh_token_enc, refresh_token_iv = excluded.refresh_token_iv,
         access_token_enc = null, access_token_iv = null, access_token_expires_at = null, updated_at = now();

  -- mailbox: one row per address
  select * into v_mailbox from public.mail_mailboxes
   where address = p_address and deleted_at is null
   for update;
  if found then
    update public.mail_mailboxes
       set deactivated_at = null,
           display_name = case when display_name = '' then coalesce(p_mailbox_display, '') else display_name end,
           graph_user_id = coalesce(graph_user_id, p_graph_user_id),
           tenant_id = coalesce(tenant_id, p_tenant_id),
           sync_identity_id = case
             when sync_identity_id is null
               or sync_status in ('broken', 'stalled', 'paused')
               or exists (select 1 from public.mail_identities i where i.id = sync_identity_id and i.status <> 'ok')
             then v_identity else sync_identity_id end,
           sync_status = case when sync_status in ('broken', 'stalled', 'paused') then 'pending' else sync_status end,
           consecutive_failures = case when sync_status in ('broken', 'stalled', 'paused') then 0 else consecutive_failures end
     where id = v_mailbox.id;
  else
    insert into public.mail_mailboxes (kind, address, graph_user_id, tenant_id, display_name, sync_identity_id)
    values (p_kind, p_address, p_graph_user_id, p_tenant_id, coalesce(p_mailbox_display, ''), v_identity)
    returning * into v_mailbox;
    v_created := true;
  end if;

  -- connection (cap trigger fires on insert)
  select id into v_conn from public.mail_connections
   where user_id = p_user_id and mailbox_id = v_mailbox.id and disconnected_at is null
   for update;
  if found then
    update public.mail_connections
       set identity_id = v_identity, status = v_status, status_changed_at = now(),
           last_error_code = null, last_error = null, last_error_at = null
     where id = v_conn;
    v_reconnect := true;
  else
    insert into public.mail_connections (user_id, mailbox_id, identity_id, status)
    values (p_user_id, v_mailbox.id, v_identity, v_status)
    returning id into v_conn;
  end if;

  return jsonb_build_object(
    'identity_id', v_identity, 'mailbox_id', v_mailbox.id, 'connection_id', v_conn,
    'mailbox_created', v_created, 'reconnected', v_reconnect, 'status', v_status
  );
end;
$$;
