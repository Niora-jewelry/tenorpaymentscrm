-- =============================================================================
-- The drawer has to drop a field someone can't see because of a hide, and the
-- server works that out from `viewer_restrictions`. It now returns every active
-- item, but for one the viewer is hidden from, only the item and the effect: no
-- automation, no date, nothing to show. The item's name never leaves the server,
-- since the page leaves that field out.
-- =============================================================================

create or replace function public.viewer_restrictions(rec uuid)
returns table (
  item text, kind text, effect text, automation_name text, applied_at timestamptz,
  can_lift boolean, allow_download boolean, batch_id uuid, batch_items text[], lifted boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (select auth.uid() as u, auth_is_admin() as admin),
  mine as (
    select r.*, m.admin or user_in_group(m.u, r.can_lift) as lifts,
           m.admin or user_in_group(m.u, r.can_lift) or user_in_group(m.u, r.can_see) as sees
      from record_restrictions r cross join me m
     where r.record_id = rec and record_visible(rec)
  ),
  merged as (
    select a.item, a.kind, bool_or(a.lifts) as lifts, bool_or(a.sees) as sees
      from mine a where a.lifted_at is null group by a.item, a.kind
  ),
  shown as (
    select r.*, g.lifts as any_lifts, g.sees as any_sees,
           r.lifted_at is null and r.kind = 'hide' and not g.sees as unseen
      from mine r left join merged g on g.item = r.item and g.kind = r.kind
  )
  select r.item, r.kind,
         case
           when r.lifted_at is not null then null
           when r.kind = 'hide' and not r.any_sees then 'hide'
           when r.kind = 'lock' and not r.any_lifts then 'lock'
         end,
         case when r.unseen then null else r.automation_name end,
         case when r.unseen then null else r.applied_at end,
         not r.unseen and coalesce(r.any_lifts, r.lifts) and r.lifted_at is null,
         r.allow_download,
         case when r.unseen then null else r.batch_id end,
         case when r.unseen then null else
           (select array_agg(l.label) from (select distinct item_label(x.item) as label from mine x where x.batch_id = r.batch_id) l where l.label is not null)
         end,
         r.lifted_at is not null
    from shown r
   where r.lifted_at is null
      or (r.lifted_by is not null and r.lifts
          and not exists (select 1 from mine n where n.batch_id = r.batch_id and n.lifted_at is null)
          and not exists (select 1 from mine n where n.item = r.item and n.kind = r.kind and n.lifted_at is null));
$$;
