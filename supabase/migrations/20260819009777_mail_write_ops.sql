-- =============================================================================
-- The Email module — changing mail: read/unread, move (archive, delete to
-- Deleted Items, junk, not junk, move to folder), permanent delete.
--
-- mail_op_submit (authenticated, SECURITY DEFINER) does three things in ONE
-- transaction, so the screen and the outbound queue can never disagree:
--   1. checks the caller may act on the mailbox (it is visible to them —
--      their own connection, or an admin on a member's personal mailbox) and
--      that every message named is really in it;
--   2. records one mail_ops row per message for the engine to carry to
--      Microsoft (idempotent per request, so a retried click is harmless),
--      superseding any still-queued op that changes the same field;
--   3. applies the change locally — the message moves / reads at once, the
--      folder counts follow, change_seq advances.
-- While an op is pending, ingest keeps our value for that field; once Graph
-- has answered, Graph's value is the truth again ("Outlook wins").
--
-- The Edit grant is the application's check (requireEmailAccess('edit'));
-- this function is the boundary on WHICH mailbox and WHICH messages.
--
-- mail_claim_mailboxes is redefined so a mailbox with pending ops is claimed
-- even when its sync queue is empty.
-- =============================================================================

create or replace function public.mail_op_submit(
  p_mailbox_id uuid,
  p_kind       text,
  p_graph_ids  text[],
  p_dest_folder_id uuid,
  p_request_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_identity uuid;
  v_dest     public.mail_folders%rowtype;
  v_ids      text[];
  v_seq      bigint;
begin
  if auth.uid() is null or not (p_mailbox_id = any (public.mail_visible_mailbox_ids())) then
    raise exception 'not found' using errcode = '42501';
  end if;
  if p_kind not in ('mark_read', 'mark_unread', 'move', 'hard_delete') then
    raise exception 'Invalid action.' using errcode = '22023';
  end if;
  if coalesce(array_length(p_graph_ids, 1), 0) = 0 or array_length(p_graph_ids, 1) > 500 then
    raise exception 'Between 1 and 500 messages.' using errcode = '22023';
  end if;

  -- Whose sign-in carries it: the caller's own connection, else the mailbox's driver.
  select c.identity_id into v_identity
    from public.mail_connections c
   where c.mailbox_id = p_mailbox_id and c.user_id = auth.uid() and c.disconnected_at is null
     and c.status in ('ok', 'degraded')
   limit 1;
  if v_identity is null then
    select sync_identity_id into v_identity from public.mail_mailboxes where id = p_mailbox_id;
  end if;
  if v_identity is null then
    raise exception 'No working connection to this mailbox.' using errcode = 'P0001';
  end if;

  if p_kind = 'move' then
    select * into v_dest from public.mail_folders
     where id = p_dest_folder_id and mailbox_id = p_mailbox_id and deleted_at is null;
    if not found then raise exception 'Destination folder not found.' using errcode = '22023'; end if;
  end if;

  -- Only messages really in this mailbox; a permanent delete only from Deleted Items or Junk.
  select array_agg(m.graph_id) into v_ids
    from public.mail_messages m
    left join public.mail_folders f on f.id = m.folder_id
   where m.mailbox_id = p_mailbox_id and m.deleted_at is null and m.graph_id = any (p_graph_ids)
     and (p_kind <> 'hard_delete' or f.well_known in ('deleteditems', 'junkemail'))
     and (p_kind <> 'move' or m.folder_id is distinct from v_dest.id);
  -- A replayed request (double click, network retry) must change NOTHING:
  -- not supersede its own op, not insert, not re-apply. Drop every target this
  -- request id has already submitted, before anything else runs.
  select array_agg(g) into v_ids
    from unnest(v_ids) g
   where not exists (select 1 from public.mail_ops o
                      where o.idempotency_key = md5(p_request_id::text || ':' || g)::uuid);

  if v_ids is null then
    select change_seq into v_seq from public.mail_mailboxes where id = p_mailbox_id;
    return v_seq;
  end if;

  -- A newer intent replaces an older one still waiting for the same field.
  update public.mail_ops o
     set status = 'done', done_at = now(), last_error_code = 'superseded'
   where o.mailbox_id = p_mailbox_id and o.status = 'queued' and o.target_graph_id = any (v_ids)
     and ((p_kind in ('mark_read', 'mark_unread') and o.kind in ('mark_read', 'mark_unread'))
       or (p_kind in ('move', 'hard_delete') and o.kind in ('move', 'hard_delete')));

  insert into public.mail_ops (idempotency_key, mailbox_id, user_id, identity_id, kind, target_graph_id, payload)
  select md5(p_request_id::text || ':' || g)::uuid, p_mailbox_id, auth.uid(), v_identity, p_kind, g,
         case when p_kind = 'move'
              then jsonb_build_object('dest_folder_id', v_dest.id, 'dest_graph_id', v_dest.graph_id)
              else '{}'::jsonb end
    from unnest(v_ids) g
  on conflict (idempotency_key) do nothing;

  -- Local apply, with folder counts kept honest.
  if p_kind in ('mark_read', 'mark_unread') then
    with changed as (
      update public.mail_messages m
         set is_read = (p_kind = 'mark_read'), updated_at = now()
       where m.mailbox_id = p_mailbox_id and m.graph_id = any (v_ids) and m.deleted_at is null
         and m.is_read <> (p_kind = 'mark_read')
      returning m.folder_id
    )
    update public.mail_folders f
       set unread_count = greatest(0, f.unread_count + case when p_kind = 'mark_read' then -c.n else c.n end)
      from (select folder_id, count(*)::int n from changed group by folder_id) c
     where f.id = c.folder_id;
  elsif p_kind = 'move' then
    with moved as (
      select m.id, m.folder_id as src, m.is_read
        from public.mail_messages m
       where m.mailbox_id = p_mailbox_id and m.graph_id = any (v_ids) and m.deleted_at is null
    ), upd as (
      update public.mail_messages m set folder_id = v_dest.id, updated_at = now()
        from moved where m.id = moved.id
      returning moved.src, moved.is_read
    ), delta as (
      select src as folder_id, -count(*)::int dt, -(count(*) filter (where not is_read))::int du from upd group by src
      union all
      select v_dest.id, count(*)::int, (count(*) filter (where not is_read))::int from upd
    )
    update public.mail_folders f
       set total_count = greatest(0, f.total_count + d.dt), unread_count = greatest(0, f.unread_count + d.du)
      from (select folder_id, sum(dt)::int dt, sum(du)::int du from delta group by folder_id) d
     where f.id = d.folder_id;
  else -- hard_delete
    with gone as (
      update public.mail_messages m set deleted_at = now(), updated_at = now()
       where m.mailbox_id = p_mailbox_id and m.graph_id = any (v_ids) and m.deleted_at is null
      returning m.folder_id, m.is_read
    )
    update public.mail_folders f
       set total_count = greatest(0, f.total_count - g.n), unread_count = greatest(0, f.unread_count - g.u)
      from (select folder_id, count(*)::int n, (count(*) filter (where not is_read))::int u from gone group by folder_id) g
     where f.id = g.folder_id;
  end if;

  update public.mail_mailboxes set change_seq = change_seq + 1 where id = p_mailbox_id returning change_seq into v_seq;
  return v_seq;
end;
$$;

create or replace function public.mail_claim_mailboxes(
  p_owner         text,
  p_limit         int,
  p_lease_seconds int,
  p_only          uuid default null
)
returns table (id uuid, address citext, graph_user_id text, sync_identity_id uuid, kind text, sync_status text)
language sql
security definer
set search_path = public, pg_temp
as $$
  with due as (
    select m.id
      from public.mail_mailboxes m
     where m.deleted_at is null and m.deactivated_at is null and m.sync_identity_id is not null
       and m.sync_status not in ('paused', 'broken', 'stalled')
       and (m.throttled_until is null or m.throttled_until <= now())
       and (m.lease_until is null or m.lease_until <= now())
       and (p_only is null or m.id = p_only)
       and (exists (select 1 from public.mail_sync_queue q
                     where q.mailbox_id = m.id and q.processed_at is null and q.not_before <= now())
         or exists (select 1 from public.mail_ops o
                     where o.mailbox_id = m.id and o.status = 'queued' and o.next_attempt_at <= now()))
     order by
       -- Someone is waiting on a pending action: that comes first.
       (exists (select 1 from public.mail_ops o where o.mailbox_id = m.id and o.status = 'queued')) desc,
       (select min(q.priority) from public.mail_sync_queue q
         where q.mailbox_id = m.id and q.processed_at is null and q.not_before <= now()),
       m.last_sync_at nulls first
     limit greatest(p_limit, 0)
     for update of m skip locked
  )
  update public.mail_mailboxes m
     set lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 10)), lease_owner = p_owner
    from due
   where m.id = due.id
  returning m.id, m.address, m.graph_user_id, m.sync_identity_id, m.kind, m.sync_status;
$$;

revoke all on function public.mail_op_submit(uuid, text, text[], uuid, uuid) from public, anon;
grant execute on function public.mail_op_submit(uuid, text, text[], uuid, uuid) to authenticated, service_role;
