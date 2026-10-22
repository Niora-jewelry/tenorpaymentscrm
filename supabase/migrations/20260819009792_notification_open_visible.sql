-- =============================================================================
-- Notifications: reading or opening one you can no longer see does nothing
-- =============================================================================
-- `notification_rows` (the one row shape every read RPC returns) and
-- `notification_open` (the deep-link path, which also marks read and spends
-- the one-time previous value) checked only `recipient_id = auth.uid()`.
-- `notifications_list`, the counts and the per-record list all filtered with
-- `notification_visible`, but a direct open by id did not: a person removed
-- from a record who still had the email link would mark the alert read and
-- lose the previous value, and be shown "no longer available" anyway.
--
-- Found by the integration suite ("hidden once the person loses access").
-- Now every row that leaves the database passes `notification_visible`, and
-- opening an invisible one is a no-op that returns nothing — which the app
-- renders as "This item is no longer available."
-- =============================================================================

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

create or replace function public.notification_open(p_id uuid)
returns setof public.notification_row
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update notifications n
     set read_at = coalesce(n.read_at, now()),
         opened_at = coalesce(n.opened_at, now())
   where n.id = p_id and n.recipient_id = auth.uid() and notification_visible(n);
  if not found then
    return;
  end if;
  -- Returned BEFORE the old value is cleared, so this one view can show it.
  return query select * from notification_rows(array[p_id]);
  update notifications
     set previous_value = null
   where id = p_id and recipient_id = auth.uid() and previous_value is not null;
end;
$$;
