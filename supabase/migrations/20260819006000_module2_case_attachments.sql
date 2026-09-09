-- =============================================================================
-- Module 2 — Part 60: files on a case's Issue, Solution and individual replies.
--
-- ── THE REQUIREMENT ──────────────────────────────────────────────────────
-- Modules Plan §3.7: "Files. Files can be attached to the Issue, to the
-- Solution, and to individual replies. Standard file limits apply (up to 5 files
-- per attachment point, 25MB per file), stored and versioned like all files."
-- And: "Every case event — thread creation, manager additions/removals, solution
-- written, every open/close transition, every reply, every file attachment — is
-- written to the record's activity log with actor and timestamp."
--
-- The Cases tab had no attachment of any kind. This adds one, by making a case
-- attachment point an ordinary `file_rows` row.
--
-- ── WHY `file_rows` AND NOT A NEW TABLE ──────────────────────────────────
-- "Stored and versioned like all files" is a design instruction, and taking it
-- literally is also the cheapest correct answer. Reusing the row inherits, with
-- no second implementation to hold in step:
--
--   * the five-per-attachment-point cap — `files_cap_guard`, already a trigger;
--   * the 25MB ceiling — already a CHECK on `files.size_bytes`;
--   * versioning — a replacement adds a row, and the list IS the history;
--   * `delete_file` / `restore_file`, and therefore the Recycle Bin, which
--     already lists these with no change (they are `files` rows);
--   * `record_file_upload`, and therefore the activity-log entry §3.7 asks for.
--
-- A separate `case_attachments` table would have had to re-derive every one of
-- those, and the fifth-file rule would then exist in two places — which is the
-- shape of a rule that quietly stops matching itself.
--
-- ── THE ANCHOR, AND WHY IT IS TWO COLUMNS ────────────────────────────────
-- `case_id` says which thread; `case_reply_id` says which reply, and is null for
-- the Issue and the Solution. Two columns rather than one polymorphic id
-- because a reply belongs to a case and BOTH facts are needed: the Issue's
-- attachment point and reply #3's attachment point are different rows on the
-- same thread, and every read is "this case's attachments" before it is "this
-- reply's".
--
-- The CHECK is what keeps the three new kinds and the two old ones from
-- drifting into each other — an 'other' row with a case_id, or a 'case_reply'
-- row without a reply, are both states no code should have to consider.
--
-- ── PERMISSION: THE CASES TAB, NOT THE FILES TAB ─────────────────────────
-- These files live in Cases and are governed by the Cases tab's grant. The Files
-- tab's grant has nothing to do with them, and the data layer checks the right
-- one — `ensure_case_file_row` below asks only that the record be visible, and
-- `caseAttachments.ts` applies the Cases tab check above it, the same split
-- `record_file_upload` already uses.
-- =============================================================================

alter table file_rows
  add column if not exists case_id       uuid references cases        on delete cascade,
  add column if not exists case_reply_id uuid references case_replies on delete cascade;

create index if not exists file_rows_case
  on file_rows (case_id) where deleted_at is null and case_id is not null;

-- A case row is anchored; an ordinary row is not. Stated once, in the database,
-- so no writer can produce a row that reads as both or neither.
alter table file_rows drop constraint if exists file_rows_case_anchor;
alter table file_rows add constraint file_rows_case_anchor check (
  (kind in ('application', 'other')  and case_id is null and case_reply_id is null)
  or (kind = 'case_issue'    and case_id is not null and case_reply_id is null)
  or (kind = 'case_solution' and case_id is not null and case_reply_id is null)
  or (kind = 'case_reply'    and case_id is not null and case_reply_id is not null)
);

-- At most ONE attachment point per place. Partial unique indexes rather than a
-- table constraint because the Issue and Solution have no reply id to key on.
create unique index if not exists file_rows_case_issue_one
  on file_rows (case_id) where kind = 'case_issue' and deleted_at is null;
create unique index if not exists file_rows_case_solution_one
  on file_rows (case_id) where kind = 'case_solution' and deleted_at is null;
create unique index if not exists file_rows_case_reply_one
  on file_rows (case_reply_id) where kind = 'case_reply' and deleted_at is null;

-- -----------------------------------------------------------------------------
-- Get (or create) the attachment point for one place on a case.
--
-- Created on demand rather than seeded with the case: most cases never carry a
-- file, and a row per reply per case created up front would be thousands of
-- empty rows whose only purpose is to be counted.
--
-- ⚠️ Returns the row id, and is therefore the ONLY thing the upload path needs.
-- `record_file_upload` takes it from here unchanged — no new upload function
-- exists, which is what makes "stored like all files" true rather than merely
-- claimed.
--
-- ON CONFLICT is deliberately NOT used: PostgREST and Postgres alike cannot
-- infer a PARTIAL unique index for conflict resolution (42P10 — the same trap
-- migration 43 documents), and these three indexes are all partial. The
-- select-then-insert is inside one function, and the unique indexes remain the
-- real guard against a concurrent second insert.
-- -----------------------------------------------------------------------------
create or replace function ensure_case_file_row(
  p_case_id  uuid,
  p_kind     text,
  p_reply_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record uuid;
  v_number bigint;
  v_row    uuid;
  v_name   text;
begin
  if p_kind not in ('case_issue', 'case_solution', 'case_reply') then
    raise exception 'Not a case attachment point' using errcode = '23514';
  end if;
  if (p_kind = 'case_reply') <> (p_reply_id is not null) then
    raise exception 'A reply attachment needs its reply, and only a reply attachment may have one'
      using errcode = '23514';
  end if;

  select c.record_id, c.number into v_record, v_number
    from cases c where c.id = p_case_id and c.deleted_at is null;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;

  -- A reply id from ANOTHER case would otherwise anchor this row to a thread it
  -- does not belong to, and every read would then disagree with itself.
  if p_reply_id is not null and not exists (
    select 1 from case_replies r where r.id = p_reply_id and r.case_id = p_case_id
  ) then
    raise exception 'That reply is not part of this case' using errcode = '23503';
  end if;

  select id into v_row
    from file_rows
   where case_id = p_case_id
     and kind = p_kind::file_row_kind
     and coalesce(case_reply_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = coalesce(p_reply_id,  '00000000-0000-0000-0000-000000000000'::uuid)
     and deleted_at is null;
  if v_row is not null then
    return v_row;
  end if;

  -- The name is what the Recycle Bin and the activity log will show, so it says
  -- where the file was rather than repeating the file's own name.
  v_name := case p_kind
              when 'case_issue'    then format('Case #%s — Issue', v_number)
              when 'case_solution' then format('Case #%s — Solution', v_number)
              else                      format('Case #%s — reply', v_number)
            end;

  insert into file_rows (record_id, kind, name, locked, position, case_id, case_reply_id)
  values (v_record, p_kind::file_row_kind, v_name, true, 0, p_case_id, p_reply_id)
  returning id into v_row;

  return v_row;
end;
$$;

revoke execute on function ensure_case_file_row(uuid, text, uuid) from public;
grant  execute on function ensure_case_file_row(uuid, text, uuid) to authenticated;

comment on function ensure_case_file_row(uuid, text, uuid) is
  'The attachment point for a case Issue, Solution or reply (Modules §3.7), as '
  'an ordinary file_rows row — so the 5-file cap, the 25MB ceiling, versioning, '
  'the Recycle Bin and the activity log all apply with no second implementation.';
