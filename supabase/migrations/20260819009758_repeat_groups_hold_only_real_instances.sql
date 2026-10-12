begin;

-- ════════════════════════════════════════════════════════════════════════
-- Debris left inside repeat groups by the double-encoding bug
-- ════════════════════════════════════════════════════════════════════════
--
-- Migration …9753 repaired repeat groups whose whole value had been stored
-- as a JSON *string*, by parsing the string back. That fixed the shape, and
-- it recovered every contact anyone had typed.
--
-- It could not fix a value that had already been parsed into an array of
-- NONSENSE, though, because such a value was never a string and so was never
-- in scope. One record was left like this:
--
--     Peak Fitness Club -> [ "[", { "0": "]", "name": "" } ]
--
-- Fragments of the old encoded text, split into "instances". The first is not
-- even an object; the second has a stray "0" key holding a bracket. Neither
-- carries a contact. On screen it is two empty contact rows that cannot be
-- typed into usefully and will not go away.
--
-- ── WHAT COUNTS AS A REAL INSTANCE ──────────────────────────────────────
-- `fields.repeat_schema` already declares the member keys of each group —
-- for Contacts: name, email, phone. So "real" is decided by the
-- configuration rather than by a list written here, and a seventh group
-- added later is covered without touching this logic (CLAUDE.md rule 1).
--
-- An instance survives when it is an object AND at least one of ITS OWN
-- schema keys holds a non-blank value. Keys outside the schema are dropped
-- from the instances that survive, which is what removes the stray "0".
--
-- ⚠️ A GROUP IS NEVER EMPTIED TO NOTHING.
-- The key is removed entirely rather than left as `[]`, because the drawer
-- already renders one blank row for a group with no instances. Leaving `[]`
-- would be a second way to say the same thing, and `addRepeatInstance` pads
-- from whatever is there — so one representation is safer than two.
--
-- Measured before writing: two records change, and both only lose instances
-- that hold nothing. No contact, affiliate or owner with any data in it is
-- touched; the dry run is in the commit message.

-- ⚠️ ONE STATEMENT PER GROUP, IN A LOOP.
-- Two reasons. A LATERAL in `UPDATE ... FROM` cannot see the target row, so
-- the obvious single statement does not compile; and even if it did, a record
-- with two damaged groups would hit the `UPDATE ... FROM` multi-match rule
-- that bit migration ...9753 — several source rows matching one target row
-- means one is applied and the rest discarded. One field per statement means
-- each record is touched at most once per statement, so neither applies.
do $$
declare
  g record;
  touched int;
begin
  for g in
    select key, repeat_schema
      from public.fields
     where type = 'repeat_group' and repeat_schema is not null
  loop
    /* The cleaned array is computed in a CTE over `rec`, its OWN alias —
       `UPDATE ... FROM` may not LATERAL-reference the row being updated, so
       the lateral has to live where `rec` is an ordinary FROM entry. */
    with cleaned as (
      select rec.id,
             rec.values -> g.key as old,
             coalesce(
               (select jsonb_agg(z.trimmed order by t.i)
                  from jsonb_array_elements(rec.values -> g.key) with ordinality t(e, i)
                  cross join lateral (
                    /* The instance, reduced to the keys its schema declares —
                       which is what drops a stray "0" holding a bracket. */
                    select coalesce(
                             (select jsonb_object_agg(kv.key, kv.value)
                                from jsonb_each(t.e) kv
                               where kv.key in (
                                 select sch ->> 'key'
                                   from jsonb_array_elements(g.repeat_schema) sch
                               )),
                             '{}'::jsonb
                           ) as trimmed
                  ) z
                 where jsonb_typeof(t.e) = 'object'
                   /* ...and it says something. */
                   and exists (
                     select 1 from jsonb_each_text(z.trimmed) kv2
                      where coalesce(btrim(kv2.value), '') <> ''
                   )),
               '[]'::jsonb
             ) as kept
        from public.records rec
       where rec.deleted_at is null
         and jsonb_typeof(rec.values -> g.key) = 'array'
    )
    update public.records r
       set values = case
                      when cleaned.kept = '[]'::jsonb then r.values - g.key
                      else jsonb_set(r.values, array[g.key], cleaned.kept, true)
                    end
      from cleaned
     where cleaned.id = r.id
       /* Only where it actually differs, so no row is touched needlessly. */
       and cleaned.kept is distinct from cleaned.old;

    get diagnostics touched = row_count;
    if touched > 0 then
      raise notice 'repeat group %: cleaned % record(s)', g.key, touched;
    end if;
  end loop;
end $$;

-- ── NOTHING UNREADABLE MAY REMAIN ───────────────────────────────────────
do $$
declare
  bad int;
begin
  select count(*) into bad
    from public.records r
    join public.fields f
      on f.type = 'repeat_group'
     and jsonb_typeof(r.values -> f.key) = 'array'
   cross join lateral jsonb_array_elements(r.values -> f.key) e
   where r.deleted_at is null
     and jsonb_typeof(e) <> 'object';

  if bad > 0 then
    raise exception 'still % non-object instance(s) inside a repeat group', bad;
  end if;
end $$;

commit;
