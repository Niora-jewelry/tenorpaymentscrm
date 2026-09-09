-- =============================================================================
-- Module 2 — Part 29: notes need author-or-admin authorization on edit/delete
-- — a real gap, not a style issue.
--
-- FOUND WHILE BUILDING the real Notes UI: `notes_all` (migration 9) is a
-- single `for all` policy gated only on `record_visible(record_id)` — it
-- never distinguished author from any other team member who can see the
-- record. `updates` already got this right (`edit_update`/`delete_update`,
-- migration 13, check `author_id = auth.uid() or auth_is_admin()` before
-- writing) because those went through an RPC from day one; `notes.ts`'s
-- `editNote`/`deleteNote` used a raw `.update()` instead, so there was
-- nothing enforcing "only the author or an admin" — any signed-in teammate
-- who could see the record could silently edit or delete anyone else's note.
-- This was never exercised because the real Notes UI didn't have edit/delete
-- controls until this pass — same category of bug as the ones the live
-- audit already caught (delete_record/restore_record's missing checks), just
-- found by building the feature instead of by auditing ahead of it.
--
-- Fix mirrors edit_update/delete_update exactly: move edit/delete behind a
-- SECURITY DEFINER function that checks authorship, and revoke UPDATE/DELETE
-- on the table itself so the function is the only path — the same "no grant
-- = safe" posture already used for credential_reveals/messages.
-- =============================================================================

create or replace function edit_note(p_note_id uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_record uuid; v_author uuid;
begin
  select record_id, author_id into v_record, v_author from notes where id = p_note_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;
  if v_author <> auth.uid() and not auth_is_admin() then
    raise exception 'Only the author or an admin may edit this note' using errcode = '42501';
  end if;

  update notes set body = p_body, edited_at = now() where id = p_note_id;
end;
$$;

create or replace function delete_note(p_note_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_record uuid; v_author uuid;
begin
  select record_id, author_id into v_record, v_author from notes where id = p_note_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;
  if v_author <> auth.uid() and not auth_is_admin() then
    raise exception 'Only the author or an admin may delete this note' using errcode = '42501';
  end if;

  update notes set deleted_at = now() where id = p_note_id;
end;
$$;

revoke update, delete on notes from authenticated;

revoke all on function edit_note(uuid, text) from public, anon, authenticated;
revoke all on function delete_note(uuid) from public, anon, authenticated;
grant execute on function edit_note(uuid, text) to authenticated;
grant execute on function delete_note(uuid) to authenticated;
