-- =============================================================================
-- Module 2 — Part 36: the atomic writer for a field's choice list, plus the
-- database half of "a choice's key is permanent".
--
-- Presets sub-step 4 (Admin → Choices) edits one SCOPE at a time — a field's
-- global options, or its override for one module — and saves the whole
-- ordered list in a single write, the same posture as migration 35's column
-- lists and for the same reason: an admin screen that can leave a status field
-- with half its options after a failed second round trip is worse than one
-- that cannot save at all.
--
-- ── WHY THIS UPSERTS AND NEVER DELETES ───────────────────────────────────
-- `records.values` stores a choice's KEY. Removing a choice that records still
-- hold leaves those records with a value that resolves to nothing — the pill
-- falls back to printing the raw key, and the drawer's picker cannot show the
-- current selection at all. That is real data loss with no error, so this pass
-- deliberately ships add / rename / reorder / re-swatch and NOT delete
-- (`remaining-plan.md` § Phase 3, same posture as its pipeline-step rule).
--
-- Making that structural rather than a UI omission is the point: the function
-- has no DELETE in it, so no request shape — and no future caller who forgets
-- the rule — can remove a choice through it. Deleting an in-use choice is its
-- own piece of work, alongside the other deletion work already deferred.
--
-- ── WHY `key` IS IMMUTABLE, ENFORCED BY A TRIGGER ────────────────────────
-- The whole point of key/label separation is that RENAMING IS FREE: `value` is
-- the display label and can change at any time, touching zero record rows.
-- Changing `key` is the opposite — it orphans every record holding the old one,
-- silently. `set_field_choices` cannot do it (the key is the conflict target,
-- so a changed key inserts a new choice instead of renaming one), but direct
-- SQL could, and this is exactly the "rules that must never break belong in the
-- database as well as the code" case. Naming FIELD keys in SQL is fine —
-- CLAUDE.md §1 forbids code naming a MODULE.
-- =============================================================================

create or replace function field_choices_key_is_permanent()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.key is distinct from old.key then
    raise exception 'A choice key is permanent — records store it. Change the label (value) instead, or add a new choice.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger field_choices_key_permanent
  before update of key on field_choices
  for each row execute function field_choices_key_is_permanent();

-- -----------------------------------------------------------------------------
-- The writer.
--
-- One scope per call: `p_module_id` NULL is the global set ("applies
-- everywhere"), a uuid is that module's override. They are separate lists, not
-- layers — `choicesFor()` (`config.ts`) returns the module set INSTEAD OF the
-- global one whenever any module row exists, never a merge. `adminChoices.ts`
-- carries the full account of what that means for the editor.
--
-- Positions step by 10, matching migration 35 and the seed's own scale.
--
-- `security definer` with a pinned `search_path` per CLAUDE.md §8, reachable
-- only through the service role (migration 19's convention): the admin check is
-- `assertAdmin(ctx)` in the data layer, and no browser-side role has any reason
-- to call this directly.
-- -----------------------------------------------------------------------------

create or replace function set_field_choices(p_field_id uuid, p_module_id uuid, p_choices jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_type field_type;
begin
  select f.type into v_type from fields f where f.id = p_field_id;
  if v_type is null then
    raise exception 'That field no longer exists.' using errcode = '23503';
  end if;

  -- The four types whose values ARE choices. Anything else has no picker to
  -- feed, so options on it would be invisible rows an admin could never
  -- explain. `adminChoices.ts` offers only these; this is the half that holds
  -- against direct SQL.
  if v_type not in ('dropdown', 'status', 'multi_select', 'percent_split') then
    raise exception 'A % field does not have choices.', v_type using errcode = '23514';
  end if;

  if p_module_id is not null and not exists (select 1 from modules m where m.id = p_module_id) then
    raise exception 'That module no longer exists.' using errcode = '23503';
  end if;

  -- The unique index is `nulls not distinct (field_id, module_id, key)`, so the
  -- global scope (module_id IS NULL) conflicts correctly too — without that,
  -- every save of a global list would insert duplicates instead of updating.
  insert into field_choices (field_id, module_id, key, value, swatch, position)
  select p_field_id,
         p_module_id,
         (elem.val->>'key')::citext,
         elem.val->>'value',
         nullif(elem.val->>'swatch', '')::swatch,
         (elem.ord - 1) * 10
    from jsonb_array_elements(p_choices) with ordinality as elem(val, ord)
      on conflict (field_id, module_id, key)
      do update set value    = excluded.value,
                    swatch   = excluded.swatch,
                    position = excluded.position;
end;
$$;

revoke execute on function set_field_choices(uuid, uuid, jsonb) from public, anon, authenticated;
