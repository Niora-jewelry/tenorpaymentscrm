-- =============================================================================
-- An admin can remove a dropdown or status option — but only one nobody holds.
--
-- Asked for by the client (14 Oct 2026), about Current Status: "I want it to
-- be editable in the admin panel." Add, rename, reorder and recolour have been
-- there since migration 36. Remove was deliberately left out, and the reason
-- still stands: `records.values` stores a choice's KEY, so deleting an option
-- that records hold leaves them resolving to nothing — the pill prints a raw
-- key, the picker cannot show the current selection, and no error says why.
--
-- What changes is that the rule is now "you may not remove an option IN USE",
-- rather than "you may not remove an option". That is the narrowest form that
-- is both safe and useful: an admin left with a stray "Urgent / High / Mid /
-- Low" on a field cannot tidy it up today, and that is a real complaint.
--
-- ── WHAT "IN USE" MEANS, PRECISELY ───────────────────────────────────────
-- A choice belongs to a SCOPE: the global list (`module_id IS NULL`) or one
-- module's override. It is in use when a record that DISPLAYS that list holds
-- its key:
--
--   * Module scope — a record that is a member of that module. A record in
--     Deals holding the same key is not affected by Leads' list, so it does
--     not block removing the option from Leads.
--   * Global scope — ANY record. The Records List shows every record and has
--     no override, so it resolves every record's value against the global
--     list; an option removed from there orphans the value for everyone.
--
-- "Any record" includes the Recycle Bin. A record restored from it would come
-- back holding a key that no longer resolves, which is the same orphan with a
-- delay.
--
-- The match is `values -> <field key> ? <choice key>`, which is true when the
-- value IS the key (status, dropdown), CONTAINS it as an element
-- (multi-select) or HAS it as a member (percent split) — one operator for all
-- four choice types, and verified not to match on a prefix.
--
-- ── WHAT IS STILL REFUSED ────────────────────────────────────────────────
--   * An option on a pipeline's status field. Those are the pipeline's steps,
--     mirrored in by `sync_pipeline_status_choices`; removing one here would be
--     undone by the next sync, or leave a step with no option. They are
--     changed in Pipelines.
--   * The LAST option in a scope. For a module that is a trap rather than a
--     tidy-up: `choicesFor()` returns a module's own list only if it has rows,
--     so emptying it silently swaps that module back to the global options —
--     a different list, with no message. For the global scope it leaves every
--     module without an override with an empty picker.
--
-- ── WHAT IS NOT CLOSED ───────────────────────────────────────────────────
-- A user could set a record to this option in the instant between the count
-- and the delete. Closing that needs a constraint on `records.values` that
-- consults `field_choices`, which is a much larger change than the request.
-- The window is a single statement long and needs an admin and a user acting
-- on the same option at the same moment; it is named here rather than hidden.
--
-- Returns the number of records holding the option. 0 means it was removed;
-- anything else means it was not, and says how many are in the way.
-- `security definer` with a pinned search_path (CLAUDE.md §8), reachable only
-- through the service role, same as `set_field_choices`.
-- =============================================================================

create or replace function remove_field_choice(p_field_id uuid, p_module_id uuid, p_key text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_field_key  text;
  v_field_type field_type;
  v_pipeline   text;
  v_in_scope   integer;
  v_in_use     integer;
begin
  select f.key, f.type into v_field_key, v_field_type from fields f where f.id = p_field_id;
  if v_field_key is null then
    raise exception 'That field no longer exists.' using errcode = '23503';
  end if;

  if v_field_type not in ('dropdown', 'status', 'multi_select', 'percent_split') then
    raise exception 'A % field does not have options.', v_field_type using errcode = '23514';
  end if;

  select p.label into v_pipeline from pipelines p where p.status_field_id = p_field_id limit 1;
  if v_pipeline is not null then
    raise exception 'These options are the steps of the % pipeline. Change them in Pipelines.', v_pipeline
      using errcode = '23514';
  end if;

  -- Lock the scope's rows, so two admins removing the last two options at
  -- once cannot both pass the count below and leave the scope empty.
  select count(*) into v_in_scope
    from (select 1 from field_choices c
           where c.field_id = p_field_id
             and c.module_id is not distinct from p_module_id
           for update) locked;

  if not exists (
    select 1 from field_choices c
     where c.field_id = p_field_id
       and c.module_id is not distinct from p_module_id
       and c.key = p_key::citext
  ) then
    raise exception 'That option no longer exists.' using errcode = '23503';
  end if;

  if v_in_scope <= 1 then
    raise exception 'This is the last option in this list. A list needs at least one — add its replacement first.'
      using errcode = '23514';
  end if;

  select count(*) into v_in_use
    from records r
   where (r.values -> v_field_key) ? p_key
     and (
       p_module_id is null
       or exists (select 1 from record_modules rm
                   where rm.record_id = r.id and rm.module_id = p_module_id)
     );

  if v_in_use > 0 then
    return v_in_use;
  end if;

  delete from field_choices c
   where c.field_id = p_field_id
     and c.module_id is not distinct from p_module_id
     and c.key = p_key::citext;

  return 0;
end;
$$;

revoke execute on function remove_field_choice(uuid, uuid, text) from public, anon, authenticated;
