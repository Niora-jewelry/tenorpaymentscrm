-- Client UI-UX review, 6 Nov 2026 ("UI-UX Changes to Records-Leads-Deals-
-- Contacts-Tickets").
--
-- 1. @, History and Notes on every field, contact and owner rows included.
--    A row member is addressed as `group[index].member` (contact[0].email).
--    Notes already scope by text; the two helpers that resolve a note's tab
--    and restrictions now read the group key in front of the bracket, so a
--    member's note follows its group's grant exactly as a field's note does.
--    Mentions on a member go through `mention_field_member`: the same checks,
--    candidates and notification as a field mention, against the group, with
--    the member named ("Contact 1 · Email") and recorded on the Update so the
--    entry links straight back to it.
-- 2. Wording the client asked to remove or change, which lives in data:
--    the Merchant pricing description, and Prior processor's tooltip.
-- 3. Prior POS agnostic is greyed out until Prior POS holds something other
--    than N/A: `fields.enabled_by` names the field it waits on.

-- ── 1. Notes on a member ────────────────────────────────────────────────
create or replace function public.note_scope_tab_key(p_kind text, p_scope_id text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select case p_kind
           when 'tab'   then (select t.key::text from tabs t where t.id::text = split_part(p_scope_id, '/', 1))
           when 'field' then (select t.key::text from fields f
                                join tabs t on t.id = f.tab_id
                               where f.key = split_part(p_scope_id, '[', 1)::citext or f.id::text = p_scope_id
                               limit 1)
         end;
$function$;

create or replace function public.note_effect(p_record uuid, p_kind text, p_scope text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select case
    when not exists (select 1 from record_restrictions where record_id = p_record and lifted_at is null) then null
    when p_kind = 'field' then restriction_effect(auth.uid(), p_record, (
      select field_items(f.key::text) from fields f where f.key = split_part(p_scope, '[', 1)::citext or f.id::text = p_scope limit 1))
    when p_kind = 'tab' then (
      select restriction_effect(auth.uid(), p_record, array_remove(array[
               'notes:' || t.key::text, 'tab:' || t.key::text,
               case when split_part(p_scope, '/', 2) <> '' then 'subtab:' || split_part(p_scope, '/', 2) end], null))
        from tabs t where t.id::text = split_part(p_scope, '/', 1))
  end;
$function$;

-- ── 1. Mentions on a member ─────────────────────────────────────────────
alter table public.updates
  add column if not exists field_member text
  check (field_member is null or field_member ~ '^\[[0-9]{1,2}\]\.[a-z0-9_]{1,64}$');

create or replace function public.mention_field_member(
  p_record_id uuid,
  p_group_key text,
  p_index int,
  p_member_key text,
  p_mentioned_user_ids uuid[],
  p_note text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_group     text;
  v_schema    jsonb;
  v_member    jsonb;
  v_label     text;
  v_sensitive boolean;
  v_valid     uuid[];
  v_current   text;
  v_update_id uuid;
  v_note      text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not record_writable(p_record_id) then
    raise exception 'not found';
  end if;
  if p_index is null or p_index < 0 or p_index > 99 or p_member_key !~ '^[a-z0-9_]{1,64}$' then
    raise exception 'not found';
  end if;
  select label, repeat_schema, sensitive into v_group, v_schema, v_sensitive
    from fields where key = p_group_key and archived_at is null and type = 'repeat_group';
  if v_group is null then
    raise exception 'not found';
  end if;
  select m into v_member from jsonb_array_elements(coalesce(v_schema, '[]'::jsonb)) m where m ->> 'key' = p_member_key limit 1;
  if v_member is null then
    raise exception 'not found';
  end if;
  if record_field_grant(p_record_id, p_group_key) = 'hidden' then
    raise exception 'not found';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'The note can be up to 500 characters.' using errcode = '22023';
  end if;

  -- "Contacts" row 1, member Email → "Contact 1 · Email".
  v_label := regexp_replace(v_group, 's$', '') || ' ' || (p_index + 1) || ' · ' || coalesce(v_member ->> 'label', p_member_key);
  v_sensitive := coalesce(v_sensitive, false) or coalesce((v_member ->> 'sensitive')::boolean, false);

  select array_agg(distinct m) into v_valid
    from unnest(coalesce(p_mentioned_user_ids, '{}')) as m
   where m = any (mention_candidates(p_record_id, 'field:' || p_group_key))
     and not exists (select 1 from notification_mutes mu
                      where mu.user_id = m and mu.record_id = p_record_id);
  if v_valid is null then
    return 0;
  end if;

  if not v_sensitive then
    select values #>> array[p_group_key, p_index::text, p_member_key] into v_current from records where id = p_record_id;
  end if;

  insert into updates (record_id, parent_id, author_id, body, field_key, field_member)
  values (p_record_id, null, auth.uid(), coalesce(v_note, 'Mentioned on ' || v_label), p_group_key,
          '[' || p_index || '].' || p_member_key)
  returning id into v_update_id;

  insert into update_mentions (update_id, user_id)
  select v_update_id, m from unnest(v_valid) as m;

  return mention_notify(v_valid, 'mention_field', p_record_id, v_update_id, null, null, p_group_key,
                        mention_preview(v_label || coalesce(' — ' || v_note, '')),
                        v_note, v_current, null);
end;
$function$;

revoke all on function public.mention_field_member(uuid, text, int, text, uuid[], text) from public, anon;
grant execute on function public.mention_field_member(uuid, text, int, text, uuid[], text) to authenticated;

-- ── 2. Wording held in data ──────────────────────────────────────────────
update public.subtabs
   set description = null
 where key = 'td_merchant'
   and description like 'What the merchant pays%';

update public.fields
   set hint = 'The processor the merchant uses today, or "N/A".'
 where key = 'prior_processor'
   and hint = 'The processor the merchant uses today, or "No".';

-- ── 3. A field that waits on another ─────────────────────────────────────
alter table public.fields
  add column if not exists enabled_by citext references public.fields(key) on update cascade on delete set null;

update public.fields
   set enabled_by = 'prior_pos'
 where key = 'prior_pos_agnostic'
   and exists (select 1 from public.fields where key = 'prior_pos');
