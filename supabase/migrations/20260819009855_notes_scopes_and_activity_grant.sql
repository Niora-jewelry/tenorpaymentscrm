-- =============================================================================
-- Found by testing as a real member.
--
-- A note's scope is what the drawer sends: a field's KEY, or `tabId/subtabId`.
-- These two functions compared it to a field's id and a whole tab id, found
-- nothing, and returned null. `record_tab_grant(rec, null)` is 'hidden', so a
-- non-admin could not add a field note or a sub-tab note at all, and could not
-- read one. Nothing errored in a way anyone would connect to this: the note
-- simply failed to save.
--
-- `record_activity` also let a signed-in viewer read the old and new value of a
-- field hidden from them, by querying it directly. The screens already filtered
-- it; the table now does too.
-- =============================================================================

create or replace function public.note_scope_tab_key(p_kind text, p_scope_id text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case p_kind
           when 'tab'   then (select t.key::text from tabs t where t.id::text = split_part(p_scope_id, '/', 1))
           when 'field' then (select t.key::text from fields f
                                join tabs t on t.id = f.tab_id
                               where f.key = p_scope_id::citext or f.id::text = p_scope_id
                               limit 1)
         end;
$$;

create or replace function public.note_tab_key(p_note_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select note_scope_tab_key(n.scope_kind::text, n.scope_id) from notes n where n.id = p_note_id;
$$;

drop policy if exists record_activity_select on record_activity;
create policy record_activity_select on record_activity for select using (
  record_visible(record_id)
  and (field_key is null or record_field_grant(record_id, field_key::text) <> 'hidden')
  and (team_id is null or actor_id = (select auth.uid()) or team_log_visible((select auth.uid()), team_id, names_person))
  and (field_key is distinct from 'team_members_assigned' or cardinality((select viewer_hidden_assignees())) = 0)
);
