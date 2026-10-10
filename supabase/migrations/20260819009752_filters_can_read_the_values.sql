begin;

-- ════════════════════════════════════════════════════════════════════════
-- Filtering a list by a field value: "permission denied for table records"
-- ════════════════════════════════════════════════════════════════════════
--
-- Reported as "This page didn't load" on Leads, reference `…@E394`. The
-- underlying error:
--
--   42501  permission denied for table records
--   hint:  GRANT SELECT ON public.records TO authenticated;
--
-- ── WHY IT HAPPENED, AND WHY IT IS NOT A MISSING GRANT ──────────────────
-- Migration 75 revoked `records.values` from `authenticated` on purpose:
-- field permissions could not be enforced while the whole jsonb blob came
-- back in one column, so the column was taken away and handed back through
-- `record_values_for()`, which strips the viewer's hidden keys IN THE
-- DATABASE. That is CLAUDE.md rule 3 — "a field the user may not see must be
-- absent from the query" — and it is working as intended.
--
-- `listRecords` therefore selects every column EXCEPT `values`. But a filter
-- is applied as `values->>key`, and PostgreSQL requires SELECT privilege on
-- every column named in a WHERE clause, not only on the ones returned. So the
-- query was refused outright.
--
-- This has been true of EVERY filter on a value-backed field since migration
-- 75 — which is to say almost every filter there is. It surfaced now because
-- `…9751` put the pipeline step on the dashboard, and the funnel on that new
-- column is one click away from a saved `{"kind":"present"}` filter. One user
-- had exactly that saved against Leads, which is why the page failed for them
-- and nobody else.
--
-- The obvious "fix" is the hint the database itself prints. Do not take it:
-- granting the column back re-opens the hole migration 75 closed, since
-- PostgREST would then serve `?select=values` to anyone.
--
-- ── WHAT THIS DOES INSTEAD ──────────────────────────────────────────────
-- A view that exposes, to the signed-in user, EXACTLY what they can already
-- obtain through `record_values_for()` — no more:
--
--   * the same rows        — `record_visible(r.id)`, which is the `records`
--                            SELECT policy spelled out:
--                              deleted_at is null
--                              and can_see_record(id)
--                              and record_module_visible(id)
--   * the same values      — `r.values - hidden_field_keys_for_record(r.id)`,
--                            the identical expression `record_values_for`
--                            uses.
--
-- Because the hidden keys are removed BEFORE any filter touches the column,
-- filtering on a field you may not see matches nothing rather than telling
-- you whether a value is there. A filter cannot become an oracle for a field
-- the permission system hides.
--
-- ⚠️ `security_invoker = false` is load-bearing and is the whole reason this
-- works: the view runs as its owner, so it may read `records.values`, and its
-- own WHERE clause is then the ENTIRE access boundary. It must stay exactly
-- equal to the SELECT policy above. If that policy is ever changed, change
-- this with it, in the same migration.
--
-- ── module_ids, RATHER THAN AN EMBEDDED JOIN ────────────────────────────
-- `listRecords` filtered to one module with `record_modules!inner(module_id)`.
-- Embedding a related table through a VIEW relies on PostgREST inferring the
-- relationship from the view's base columns, which is more machinery than
-- this needs. An array of the record's modules filters with a plain `cs`
-- containment test and cannot be mis-inferred.
--
-- The Records List passes no module and so joins nothing, which is what keeps
-- ARCHIVED records (zero display memberships) visible there — the same reason
-- the `!inner` join it replaces was conditional.

create or replace view public.records_filterable
with (security_invoker = false) as
  select
    r.id,
    r.deal_name,
    r.creator_kind,
    r.creator_user_id,
    r.creator_campaign_id,
    r.created_at,
    r.updated_at,
    r.deleted_at,
    /* Identical to record_values_for(). Selectable so that PostgREST can
       filter on `values->>key`; safe because the keys this viewer may not
       see are already gone. */
    r.values - hidden_field_keys_for_record(r.id) as values,
    coalesce(
      (select array_agg(rm.module_id)
         from public.record_modules rm
        where rm.record_id = r.id),
      '{}'::uuid[]
    ) as module_ids
  from public.records r
 where record_visible(r.id);

comment on view public.records_filterable is
  'records, scoped to the caller exactly as the records SELECT policy does, with `values` stripped of the caller''s hidden field keys. Exists so a list can be FILTERED by a field value: `records.values` is not selectable by `authenticated` (migration 75) and PostgreSQL requires SELECT privilege on any column named in a WHERE clause. Discloses nothing beyond record_values_for().';

revoke all on public.records_filterable from anon, authenticated;
grant select on public.records_filterable to authenticated;

commit;
