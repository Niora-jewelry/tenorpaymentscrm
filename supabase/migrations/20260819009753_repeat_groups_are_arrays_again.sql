begin;

-- ════════════════════════════════════════════════════════════════════════
-- "Contacts 91": a repeat group stored as text instead of an array
-- ════════════════════════════════════════════════════════════════════════
--
-- Reported by the client: he added ONE contact to a record, the tab then said
-- "CONTACTS 91" and showed ninety-one blank contact rows, and the contact he
-- had typed was nowhere on screen.
--
-- ── WHAT ACTUALLY HAPPENED ──────────────────────────────────────────────
-- Nothing was deleted. His contact was in the database the entire time:
--
--   "[{\"name\":\"Yitzchok Cohen\",\"email\":\"…\",\"phone\":\"…\"},{}]"
--
-- A jsonb STRING, ninety-one characters long, where an array of two instances
-- belonged. The drawer did what you would expect of code handed a string
-- where it expects a list: it treated each CHARACTER as an instance. Ninety-
-- one characters, ninety-one contact rows, none of them with a name in it.
--
-- The cause is in the application, and is fixed in the same change:
-- `setValueAction` keeps a list of the field types whose value is a JSON
-- document and must therefore be `JSON.parse`d back out of the FormData the
-- client sends. `repeat_group` was missing from that list, so the string the
-- client had already encoded was stored verbatim. The write SUCCEEDS — jsonb
-- accepts a string scalar as happily as an array — which is why nothing ever
-- errored, in testing or in production.
--
-- This migration repairs the rows already written that way.
--
-- ── WHY IT IS SAFE TO PARSE THEM BACK ───────────────────────────────────
-- The damage is exactly reversible, because it is one extra encoding step and
-- nothing else: the text is the output of `JSON.stringify` on the value that
-- should have been stored, so `::jsonb` on it gives back precisely that
-- value. No data was dropped on the way in, so none has to be guessed on the
-- way out.
--
-- Three guards, so this can only ever narrow:
--
--   * only fields whose TYPE stores a JSON document — the same set the
--     application now parses, named here rather than inferred;
--   * only values currently stored as a jsonb `string`;
--   * only strings that are VALID JSON beginning with `[` or `{`.
--     `pg_input_is_valid` (PostgreSQL 16+) does that test without raising,
--     so a value that is genuinely a user's text — somebody who typed
--     "{tbd}" into a text field — is left untouched instead of aborting the
--     migration.
--
-- A field holding a legitimate string is therefore never rewritten, and a
-- field already holding an array is not in scope to begin with.
--
-- Measured before writing: five rows across four records, every one of them
-- `repeat_group` (`contact` ×4, `owner_private` ×1). The other JSON-valued
-- types are listed anyway — they have been missing from that list before, and
-- a repair that only covers today's symptom would have to be written again.

-- ⚠️ ONE PATCH PER RECORD, AGGREGATED — NOT ONE ROW PER FIELD.
--
-- The obvious form of this is `update records r ... from fields f where
-- <f matches a damaged key on r>`, and it is wrong in a way that is easy to
-- ship: in an `UPDATE ... FROM`, when several source rows match the same
-- target row, PostgreSQL applies ONE of them and silently discards the rest.
-- A record with two damaged fields therefore gets one of them fixed and the
-- other left exactly as it was.
--
-- That is not hypothetical here. Of the four affected records, one (Apex
-- Landscaping) has both `contact` AND `owner_private` stored as text, and the
-- naive form repaired one and left the other — caught only because the check
-- at the bottom of this migration refused to commit.
--
-- Aggregating every damaged key for a record into a single jsonb patch first
-- means each record is touched once, with all of its repairs in that one
-- write.
update public.records r
   set values = r.values || fix.patch
  from (
    select rec.id,
           jsonb_object_agg(f.key, (rec.values ->> f.key)::jsonb) as patch
      from public.records rec
      join public.fields f
        on jsonb_typeof(rec.values -> f.key) = 'string'
     where f.type in (
             'repeat_group', 'address', 'grid', 'percent_split',
             'months', 'multi_select', 'team_member'
           )
       and (rec.values ->> f.key) ~ '^\s*[\[{]'
       and pg_input_is_valid(rec.values ->> f.key, 'jsonb')
     group by rec.id
  ) as fix
 where fix.id = r.id;

-- ── IT MUST HAVE WORKED ─────────────────────────────────────────────────
-- A silent no-op here would leave the client looking at the same ninety-one
-- rows, so the migration refuses to commit unless the condition it exists to
-- clear is actually gone.
do $$
declare
  remaining int;
begin
  select count(*) into remaining
    from public.records r
    join public.fields f
      on jsonb_typeof(r.values -> f.key) = 'string'
   where f.type in (
           'repeat_group', 'address', 'grid', 'percent_split',
           'months', 'multi_select', 'team_member'
         )
     and (r.values ->> f.key) ~ '^\s*[\[{]'
     and pg_input_is_valid(r.values ->> f.key, 'jsonb');

  if remaining > 0 then
    raise exception
      'repeat-group repair left % JSON-encoded string value(s) behind', remaining;
  end if;
end $$;

commit;
