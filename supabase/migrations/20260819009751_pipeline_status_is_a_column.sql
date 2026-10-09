begin;

-- ════════════════════════════════════════════════════════════════════════
-- The pipeline step, on the dashboard, beside Current Status
-- ════════════════════════════════════════════════════════════════════════
--
-- It was only ever on the record drawer: the pipeline bar, and since the last
-- change the header strip too. On the list — the screen you scan to see where
-- everything stands — there was no way to see which stage a record was at
-- without opening it.
--
-- ── NO CODE, BECAUSE IT IS ALREADY A FIELD ──────────────────────────────
-- A pipeline keeps a SYNCED STATUS FIELD: `pipelines.status_field_id`, and
-- `schema.ts` states the relationship plainly — "a record is on a pipeline
-- exactly when that pipeline's synced Status field holds a step". Leads has
-- `leads_lead_pipeline_status`, Deals `deals_deal_pipeline_status`, and so on.
--
-- So the step is a field with a value, and putting a field on the dashboard
-- is a `module_columns` row. No new column type, no computed column, no
-- special case in `DataTable` — and because it is an ordinary column, an
-- admin can reorder, rename through the field, or remove it from Presets
-- afterwards like any other.
--
-- The alternative was `extraColumn`, the locked system-column slot Tickets'
-- "Open case managers" uses. It would have worked and been worse: it renders
-- last, it cannot be moved, and it would have made a configurable thing
-- permanent in code for no gain.
--
-- ── POSITION 15, DELIBERATELY ───────────────────────────────────────────
-- `current_status` sits at 10 in all four of these modules and the seed
-- spaces columns by 10, so 15 lands the pipeline immediately after it and
-- before whatever held 20 — which is where it was asked for, and where it
-- reads best: the two "where is this record" answers side by side.
--
-- Only the four modules that HAVE a pipeline get the column. Residuals and
-- the Records List have none, and a column that is empty for every row in a
-- module is noise in the one place a column costs the most.
--
-- Idempotent: a module that somehow already lists its pipeline field is left
-- alone rather than gaining a duplicate.

insert into public.module_columns (module_id, field_id, position)
select p.module_id, p.status_field_id, 15
  from public.pipelines p
 where p.status_field_id is not null
   and not exists (
     select 1
       from public.module_columns mc
      where mc.module_id = p.module_id
        and mc.field_id = p.status_field_id
   )
group by p.module_id, p.status_field_id;

commit;
