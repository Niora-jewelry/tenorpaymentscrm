-- =============================================================================
-- Part 75: FIELD permissions now reach the data. The most important one.
--
-- ── MEASURED, AND THIS IS THE WORST OF THE THREE ─────────────────────────
-- Migrations 72/73 closed tabs, 74 closed modules. Fields were still open, and
-- fields are where the sensitive values live. A signed-in user with the `ein`
-- field set to Hidden — a field flagged `sensitive`, i.e. a tax ID that the UI
-- renders behind a Reveal button and audit-logs every time it is shown:
--
--   GET /rest/v1/records?select=deal_name,values
--     -> 200  "ein": "450172628"
--     -> 130 field values returned in full
--
-- Every field on the record, whatever the grants said. The application layer
-- does strip hidden keys — `stripHidden()` in `lib/records/records.ts` — but it
-- strips them AFTER fetching, in JavaScript, which is precisely the thing
-- CLAUDE.md rule 3 forbids:
--
--     "A field the user may not see must be ABSENT FROM THE QUERY, not
--      filtered out afterwards and not hidden with CSS."
--
-- ── WHY THIS NEEDS A COLUMN GRANT, NOT A POLICY ──────────────────────────
-- Row-level security is row-level. Every field value lives in ONE jsonb column,
-- `records.values`, so no policy can return the row while withholding some
-- keys from it. The only thing in Postgres that can refuse a COLUMN is a
-- column-level GRANT — so `values` is taken away from `authenticated` outright,
-- and handed back through a function that strips before returning.
--
-- ── WHAT THE APPLICATION HAS TO DO DIFFERENTLY ───────────────────────────
-- Two queries in `records.ts` selected `*`, which now fails on this column.
-- Both name their columns explicitly and fetch values through
-- `record_values_for()` instead. `listDeletedRecords` is untouched: it already
-- runs as the service role and is admin-only.
--
-- `stripHidden()` stays in the TypeScript. It is now redundant — belt and
-- braces — and that is the right way round: the database is the boundary, the
-- application agrees with it.
-- =============================================================================

/*
 * The keys this viewer may not see.
 *
 * Mirrors `hiddenKeysFor()` exactly, including the part that surprises people:
 * it consults the FIELD's own grant only, not a chain capped under the tab.
 * That is what the application does today, and two rules that disagree are
 * worse than one rule someone might want to tighten later.
 *
 * STABLE, so it is evaluated once per query rather than once per row.
 */
create or replace function public.hidden_field_keys()
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when auth_is_admin() then '{}'::text[]
    else coalesce(
      (
        select array_agg(f.key::text)
          from fields f
         where effective_grant(auth.uid(), 'field', f.id) = 'hidden'
      ),
      '{}'::text[]
    )
  end;
$$;

revoke execute on function public.hidden_field_keys() from public, anon;
grant execute on function public.hidden_field_keys() to authenticated, service_role;


/*
 * Values for a set of records, with the viewer's hidden keys removed.
 *
 * `jsonb - text[]` deletes those keys, so what comes back never contained them
 * — the removal happens in the database, before the row is sent.
 *
 * Re-checks `record_visible()` itself rather than trusting the ids it was
 * handed. The caller has already been filtered by RLS, but this function is
 * reachable by any authenticated session with any ids it cares to invent, so it
 * cannot assume its input was honest.
 */
create or replace function public.record_values_for(p_ids uuid[])
-- ⚠ `values` is a RESERVED WORD in Postgres and must be quoted wherever it
-- appears as an identifier — both here and in the revoke below, which is what
-- the first attempt at this migration got wrong (42601).
returns table (id uuid, "values" jsonb)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.id, r.values - hidden_field_keys()
    from records r
   where r.id = any(p_ids)
     and record_visible(r.id);
$$;

revoke execute on function public.record_values_for(uuid[]) from public, anon;
grant execute on function public.record_values_for(uuid[]) to authenticated, service_role;


-- ── The column itself ────────────────────────────────────────────────────
-- ⚠ THIS IS THE LINE THAT ACTUALLY CLOSES THE HOLE. Everything above is the
-- supported way back in. `service_role` keeps it: the webhooks, the seeder and
-- the admin paths read values directly, and that key never reaches a browser.
revoke select ("values") on records from authenticated, anon;
