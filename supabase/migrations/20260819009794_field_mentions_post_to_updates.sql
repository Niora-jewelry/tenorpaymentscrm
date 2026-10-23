-- =============================================================================
-- Field mentions are posted to the Updates feed as well
-- =============================================================================
-- The build plan's default was "a field mention is not posted to Updates".
-- The client reversed that on 22 Oct 2026: the @ on a field must also leave
-- an entry in the record's Updates feed, showing the tab, sub-tab and field
-- next to the sender's name. The alert itself is unchanged — it still lands
-- on the field (dot, deep link, one-time previous value).
--
-- Design:
--   * `updates.field_key` marks the entry; its presence IS the kind. The body
--     is the note (or "Mentioned on <Field>" when there was none), so the
--     Recycle Bin excerpt and the activity log keep reading plain text.
--   * The entry is written by `mention_field` itself, by the sender, with
--     `update_mentions` rows for the recipients (the "was notified" line), and
--     the notification carries the entry's id in `update_id` so that removing
--     the entry revokes the alert through `delete_update`, unchanged.
--   * A viewer whose grant hides the field never receives the entry: the
--     Updates SELECT policy gains a field-grant predicate. Absent from the
--     query, never hidden by the UI (CLAUDE.md §3).
--   * The entry cannot be edited (it records what was sent); it can be removed.
-- =============================================================================

alter table public.updates
  add column if not exists field_key citext
    references public.fields (key) on update cascade on delete set null;

create index if not exists updates_field_key_idx
  on public.updates (record_id) where field_key is not null;

-- ── Visibility: the Updates tab AND, for a field entry, the field ───────────
drop policy if exists updates_select on public.updates;
create policy updates_select on public.updates for select to authenticated
  using (
    record_visible(record_id)
    and tab_visible(record_id, 'updates')
    and (field_key is null or record_field_grant(record_id, field_key::text) <> 'hidden')
  );

-- ── The mention itself: alert + feed entry, one transaction ─────────────────
create or replace function public.mention_field(
  p_record_id           uuid,
  p_field_key           text,
  p_mentioned_user_ids  uuid[],
  p_note                text,
  p_include_previous    boolean
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_label     text;
  v_sensitive boolean;
  v_valid     uuid[];
  v_current   text;
  v_previous  text;
  v_update_id uuid;
  v_note      text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;
  select label, sensitive into v_label, v_sensitive
    from fields where key = p_field_key and archived_at is null;
  if v_label is null then
    raise exception 'not found';
  end if;
  if record_field_grant(p_record_id, p_field_key) = 'hidden' then
    raise exception 'not found';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'The note can be up to 500 characters.' using errcode = '22023';
  end if;

  select array_agg(distinct m) into v_valid
    from unnest(coalesce(p_mentioned_user_ids, '{}')) as m
   where m = any (mention_candidates(p_record_id, 'field:' || p_field_key));
  if v_valid is null then
    return 0;
  end if;

  if not v_sensitive then
    select values #>> array[p_field_key] into v_current from records where id = p_record_id;
    if coalesce(p_include_previous, false) then
      -- The sender's own change in the last ten minutes, else nothing.
      select from_value into v_previous
        from record_activity
       where record_id = p_record_id
         and kind = 'field'
         and field_key = p_field_key
         and actor_id = auth.uid()
         and at > now() - interval '10 minutes'
       order by at desc
       limit 1;
    end if;
  end if;

  -- The feed entry, by the sender. The sender's right here is the FIELD
  -- (checked above), not the Updates tab — so no require_tab_edit. Not a
  -- value change, so no record_activity row of its own.
  insert into updates (record_id, parent_id, author_id, body, field_key)
  values (p_record_id, null, auth.uid(), coalesce(v_note, 'Mentioned on ' || v_label), p_field_key)
  returning id into v_update_id;

  insert into update_mentions (update_id, user_id)
  select v_update_id, m from unnest(v_valid) as m;

  return mention_notify(v_valid, 'mention_field', p_record_id, v_update_id, null, null, p_field_key,
                        mention_preview(v_label || coalesce(' — ' || v_note, '')),
                        v_note, v_current, v_previous);
end;
$$;

-- ── A field entry records what was sent; it is not editable ─────────────────
create or replace function public.edit_update_with_mentions(
  p_update_id           uuid,
  p_body                text,
  p_mentioned_user_ids  uuid[]
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record uuid;
  v_author uuid;
  v_field  citext;
  v_old    uuid[];
  v_new    uuid[];
  v_added  uuid[];
  v_gone   uuid[];
begin
  select record_id, author_id, field_key into v_record, v_author, v_field
    from updates where id = p_update_id and deleted_at is null;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;
  perform require_tab_edit(v_record, 'updates');
  if v_author <> auth.uid() and not auth_is_admin() then
    raise exception 'Only the author or an admin may edit this update' using errcode = '42501';
  end if;
  if v_field is not null then
    raise exception 'A field mention cannot be edited' using errcode = '42501';
  end if;

  select coalesce(array_agg(user_id), '{}') into v_old from update_mentions where update_id = p_update_id;
  select coalesce(array_agg(distinct m), '{}') into v_new
    from unnest(coalesce(p_mentioned_user_ids, '{}')) as m
   where m = any (mention_candidates(v_record, 'updates'));

  select coalesce(array_agg(x), '{}') into v_added from unnest(v_new) as x where not (x = any (v_old));
  select coalesce(array_agg(x), '{}') into v_gone  from unnest(v_old) as x where not (x = any (v_new));

  update updates set body = p_body, edited_at = now() where id = p_update_id;

  if cardinality(v_added) > 0 then
    insert into update_mentions (update_id, user_id) select p_update_id, m from unnest(v_added) as m
    on conflict do nothing;
    perform mention_notify(v_added, 'mention_update', v_record, p_update_id, null, null, null,
                           mention_preview(p_body), null, null, null);
  end if;
  if cardinality(v_gone) > 0 then
    delete from update_mentions where update_id = p_update_id and user_id = any (v_gone);
    update notifications set revoked_at = now()
     where update_id = p_update_id and recipient_id = any (v_gone) and revoked_at is null;
  end if;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'update', 'Update edited');
end;
$$;
