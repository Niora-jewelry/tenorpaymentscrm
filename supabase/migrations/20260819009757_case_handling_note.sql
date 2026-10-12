begin;

-- ════════════════════════════════════════════════════════════════════════
-- "How to deal with this merchant's tickets", at the top of Cases
-- ════════════════════════════════════════════════════════════════════════
--
-- The client, in his own words:
--
--   "The tab 'Cases' should have an input at the top where we can input a
--    method of dealing with tickets so anyone dealing with the ticket knows
--    how to deal with it"
--
-- One standing instruction per RECORD, not per case. It is the thing you
-- want to have read BEFORE you open a case, which is why it sits above the
-- list rather than inside any one thread.
--
-- ── WHY ITS OWN TABLE AND NOT A FIELD ───────────────────────────────────
-- Fields live in tabs made of fields; Cases is not one of those — it is a
-- tab of threads, with its own table, exactly like Updates and Notes. Adding
-- a field would have meant inventing a subtab under Cases purely to hang it
-- from, and every field-grid behaviour (column, filter, bulk edit, history)
-- would have come along uninvited for something that is one paragraph of
-- prose.
--
-- ── PERMISSIONS ARE THE CASES TAB'S, EXACTLY ────────────────────────────
-- Copied from `cases` deliberately, predicate for predicate: if you can read
-- this record's Cases you can read the note, and if you can write them you
-- can write it. Anything looser would leak an instruction about a merchant
-- to somebody who cannot see that merchant's cases; anything stricter would
-- hide it from the person it is written for. There is no third rule to get
-- out of step.
--
-- One row per record, so the primary key IS the record id — the note is
-- edited in place, never appended to, and a second row for the same record
-- is meaningless rather than merely unwanted.

create table if not exists public.case_handling_notes (
  record_id   uuid primary key references public.records(id) on delete cascade,
  body        text not null,
  updated_by  uuid references auth.users(id),
  updated_at  timestamptz not null default now(),
  constraint case_handling_notes_body_len check (length(body) <= 4000)
);

alter table public.case_handling_notes enable row level security;
alter table public.case_handling_notes force row level security;

revoke all on public.case_handling_notes from anon, authenticated;
grant select, insert, update, delete on public.case_handling_notes to authenticated;

drop policy if exists case_handling_notes_select on public.case_handling_notes;
create policy case_handling_notes_select on public.case_handling_notes
  for select using (
    record_visible(record_id) and tab_visible(record_id, 'cases')
  );

drop policy if exists case_handling_notes_insert on public.case_handling_notes;
create policy case_handling_notes_insert on public.case_handling_notes
  for insert with check (
    record_visible(record_id)
    and record_tab_grant(record_id, 'cases') = 'edit'
  );

drop policy if exists case_handling_notes_update on public.case_handling_notes;
create policy case_handling_notes_update on public.case_handling_notes
  for update using (
    record_visible(record_id)
    and record_tab_grant(record_id, 'cases') = 'edit'
  ) with check (
    record_visible(record_id)
    and record_tab_grant(record_id, 'cases') = 'edit'
  );

drop policy if exists case_handling_notes_delete on public.case_handling_notes;
create policy case_handling_notes_delete on public.case_handling_notes
  for delete using (
    record_visible(record_id)
    and record_tab_grant(record_id, 'cases') = 'edit'
  );

comment on table public.case_handling_notes is
  'One standing instruction per record for how its tickets should be handled, shown above the Cases list. Permissions mirror the cases table exactly.';

commit;
