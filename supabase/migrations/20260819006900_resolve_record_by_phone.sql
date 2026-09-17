-- =============================================================================
-- Part 69: match a phone number to a record — the CRM's own identity rule,
-- in one place.
--
-- ── WHAT THIS REPLACES ───────────────────────────────────────────────────
-- Donny's module resolves an inbound number against `lead_gen_threads`, a table
-- that does not exist here. The equivalent question in TapDash is already
-- specified — the Communication tab says it on screen: "Inbound messages land
-- on a record by matching the sender against SYNC-ENABLED Email and Phone
-- fields." This function is that sentence, executable.
--
-- ── WHERE THE SYNC FLAGS ACTUALLY LIVE (the surprise) ─────────────────────
-- Not where you would expect. The three top-level phone/email fields
-- (`affiliate_main_phone`, `affiliate_main_email`, `fax_number`) all carry
-- `sync_enabled = false`. The flags that matter are INSIDE repeat-group
-- schemas, as a `sync` key on each sub-field:
--
--   contact          → phone: sync true,  email: sync true
--   owner_ownership  → phone: sync true
--   affiliate        → phone: sync false
--
-- Which is correct — the number you call a merchant on is a contact's or an
-- owner's number, not the fax line. But it means a resolver that only looked at
-- `fields.sync_enabled` would match NOTHING, silently, forever. Both shapes are
-- handled below, and both read the flag from data rather than naming a field,
-- so turning sync on for a new field is configuration (CLAUDE.md rule 1).
--
-- ── ONE RECORD, NOT MANY — AND WHY THAT DIFFERS FROM `messages` ───────────
-- The spec says an inbound MESSAGE matching several records deposits into ALL
-- of them. A call does not work that way: a call is a single event with one
-- duration, one recording and one delivery state, and copying it would mean
-- copying its audio and its billing. So this returns exactly one record — the
-- oldest match, which is deterministic rather than arbitrary — and null when
-- nothing matches. Null is a normal outcome, not an error: it means somebody
-- rang from a number the CRM has never seen.
--
-- ── EXACT MATCH, WHICH IS WHY THE BACKFILL EXISTS ────────────────────────
-- Twilio always sends E.164 (`+19733704989`). A human types `(973) 370-4989`.
-- Those are different strings and this function compares strings, so every
-- stored number has to BE E.164 or nothing will ever match. The seeded data was
-- not — `scripts/backfill-phone-e164.mjs` converts what is already stored, and
-- the write paths normalise from here on. Donny hit this exact problem in the
-- old CRM; his notes are explicit that a backfill would be needed on any
-- database that already held data. This one does.
--
-- SECURITY DEFINER with a pinned search_path (CLAUDE.md rule 8). It is called
-- by the Twilio webhooks, which run as the service role and have no
-- `auth.uid()` — it deliberately does NOT consult record visibility, because
-- routing an inbound call must not depend on who happens to be looking.
-- =============================================================================

create or replace function public.resolve_record_by_phone(p_e164 text)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with candidates as (
    -- Shape 1: a top-level phone field with sync_enabled on the field row.
    select r.id, r.created_at
      from records r
      join fields f
        on f.type = 'phone'
       and f.sync_enabled
       and f.repeat_group_key is null
       and f.archived_at is null
     where r.deleted_at is null
       and r.values ->> f.key::text = p_e164

    union

    -- Shape 2: a phone sub-field inside a repeat group, whose schema entry
    -- carries "sync": true. `values -> <group key>` is an array of instance
    -- objects, so every owner and every contact on the record is considered.
    select r.id, r.created_at
      from records r
      join fields g
        on g.type = 'repeat_group'
       and g.repeat_group_key is not null
       and g.archived_at is null
      cross join lateral jsonb_array_elements(
             case
               when jsonb_typeof(r.values -> g.repeat_group_key) = 'array'
                 then r.values -> g.repeat_group_key
               else '[]'::jsonb
             end
           ) as instance
      cross join lateral jsonb_array_elements(
             case
               when jsonb_typeof(g.repeat_schema) = 'array' then g.repeat_schema
               else '[]'::jsonb
             end
           ) as sub
     where r.deleted_at is null
       and sub ->> 'type' = 'phone'
       and coalesce((sub ->> 'sync')::boolean, false)
       and instance ->> (sub ->> 'key') = p_e164
  )
  select id from candidates order by created_at, id limit 1;
$$;

revoke execute on function public.resolve_record_by_phone(text) from public, anon;
grant execute on function public.resolve_record_by_phone(text) to authenticated, service_role;


-- =============================================================================
-- The same question, for a whole page of numbers at once.
--
-- The call history pane needs a record label per row. Calling the single
-- resolver once per row is the N+1 that turns a 50-row page into 50 round
-- trips, so the batched form exists from the start rather than being added
-- after someone notices the pane is slow.
-- =============================================================================

create or replace function public.resolve_records_by_phones(p_e164s text[])
returns table (e164 text, record_id uuid, deal_name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select n.e164,
         r.id,
         r.deal_name
    from unnest(p_e164s) as n(e164)
    cross join lateral (
      select resolve_record_by_phone(n.e164) as id
    ) m
    left join records r on r.id = m.id
   where m.id is not null;
$$;

revoke execute on function public.resolve_records_by_phones(text[]) from public, anon;
grant execute on function public.resolve_records_by_phones(text[]) to authenticated, service_role;
