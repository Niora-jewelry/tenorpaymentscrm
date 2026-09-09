-- =============================================================================
-- Module 2 — Part 49: the Other tab and note authority become traceable.
--
-- Migration 48 added the two `activity_kind` values. This is the half that
-- writes them.
--
-- ── WHY THESE ARE FUNCTIONS AND NOT TYPESCRIPT ───────────────────────────
-- CLAUDE.md rule 5: a change and its history succeed together or fail
-- together. Every other writer in this schema honours that by doing both in
-- one function — `set_record_value`, `set_record_memberships`,
-- `toggle_case_state`, `record_file_upload`, `reveal_password`. The Other tab
-- wrote its rows straight from the data layer with `supabase.from(...)`, which
-- is why adding a log line in TypeScript would have been the one writer in the
-- codebase where the row and its history could diverge on a failure.
--
-- So the three Other-tab writes move into functions, matching the pattern
-- rather than being an exception to it. `edit_note`/`delete_note` already were
-- functions and simply gain their missing `log_activity` call.
--
-- ── PERMISSION IS UNCHANGED, DELIBERATELY ────────────────────────────────
-- These are `security invoker`, not definer: the existing
-- `record_custom_entries_all` RLS policy and the Other tab's own grant check
-- in `tabAccess.ts` stay exactly the gate they are today. Moving the write
-- into a function must not quietly widen who may perform it — the only thing
-- being added is the history row. `log_activity` is itself SECURITY DEFINER,
-- so the append-only insert works from an invoker-rights caller.
--
-- ── WHAT EACH EVENT RECORDS ──────────────────────────────────────────────
-- `from_value`/`to_value` carry the entry's VALUE across a change so the
-- timeline reads like a field edit, and the label travels in the summary
-- because an Other entry's label is user-authored and is itself editable — a
-- summary of "Fee schedule changed" is useless if the label was renamed in the
-- same breath, so a rename says both names.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Other tab — add
-- -----------------------------------------------------------------------------
create or replace function add_custom_entry(
  p_record_id uuid,
  p_label     text,
  p_value     text
)
returns record_custom_entries
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_row record_custom_entries;
begin
  insert into record_custom_entries (record_id, label, value, created_by)
  values (p_record_id, p_label, p_value, auth.uid())
  returning * into v_row;

  perform log_activity(
    p_record_id, 'custom_entry',
    format('Added %s on the Other tab', p_label),
    null, null, p_value);

  return v_row;
end;
$$;

-- -----------------------------------------------------------------------------
-- Other tab — edit
-- -----------------------------------------------------------------------------
create or replace function update_custom_entry(
  p_entry_id uuid,
  p_label    text,
  p_value    text
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_record uuid;
  v_old_label text;
  v_old_value text;
begin
  select record_id, label, value
    into v_record, v_old_label, v_old_value
    from record_custom_entries
   where id = p_entry_id and deleted_at is null;

  -- RLS has already decided whether this row is visible; a miss here is a row
  -- this caller may not touch, and it is reported the same way every other
  -- function in this schema reports one.
  if v_record is null then
    raise exception 'not found';
  end if;

  update record_custom_entries
     set label = p_label, value = p_value, updated_at = now()
   where id = p_entry_id;

  perform log_activity(
    v_record, 'custom_entry',
    case when v_old_label is distinct from p_label
         then format('Renamed %s to %s on the Other tab', v_old_label, p_label)
         else format('Changed %s on the Other tab', p_label)
    end,
    null, v_old_value, p_value);
end;
$$;

-- -----------------------------------------------------------------------------
-- Other tab — remove (soft, as it always was)
-- -----------------------------------------------------------------------------
create or replace function delete_custom_entry(p_entry_id uuid)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_record uuid;
  v_label  text;
  v_value  text;
begin
  select record_id, label, value
    into v_record, v_label, v_value
    from record_custom_entries
   where id = p_entry_id and deleted_at is null;

  if v_record is null then
    raise exception 'not found';
  end if;

  update record_custom_entries set deleted_at = now() where id = p_entry_id;

  perform log_activity(
    v_record, 'custom_entry',
    format('Removed %s from the Other tab', v_label),
    null, v_value, null);
end;
$$;

revoke execute on function add_custom_entry(uuid, text, text) from public;
revoke execute on function update_custom_entry(uuid, text, text) from public;
revoke execute on function delete_custom_entry(uuid) from public;
grant execute on function add_custom_entry(uuid, text, text) to authenticated;
grant execute on function update_custom_entry(uuid, text, text) to authenticated;
grant execute on function delete_custom_entry(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Note authority — the §9 requirement these two were missing.
-- Bodies are otherwise carried over verbatim from migration 29.
-- -----------------------------------------------------------------------------
create or replace function edit_note(p_note_id uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_record uuid; v_author uuid; v_old text;
begin
  select record_id, author_id, body into v_record, v_author, v_old from notes where id = p_note_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;
  if v_author <> auth.uid() and not auth_is_admin() then
    raise exception 'Only the author or an admin may edit this note' using errcode = '42501';
  end if;

  update notes set body = p_body, edited_at = now() where id = p_note_id;

  -- Names the case the requirement exists for: an admin rewriting somebody
  -- else's note. The author's own edit is logged too, so the trail is complete
  -- rather than only recording the suspicious half.
  perform log_activity(
    v_record, 'note',
    case when v_author <> auth.uid()
         then 'Edited another user''s note'
         else 'Edited their own note' end,
    null, v_old, p_body);
end;
$$;

create or replace function delete_note(p_note_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_record uuid; v_author uuid; v_old text;
begin
  select record_id, author_id, body into v_record, v_author, v_old from notes where id = p_note_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;
  if v_author <> auth.uid() and not auth_is_admin() then
    raise exception 'Only the author or an admin may delete this note' using errcode = '42501';
  end if;

  update notes set deleted_at = now() where id = p_note_id;

  perform log_activity(
    v_record, 'note',
    case when v_author <> auth.uid()
         then 'Deleted another user''s note'
         else 'Deleted their own note' end,
    null, v_old, null);
end;
$$;
