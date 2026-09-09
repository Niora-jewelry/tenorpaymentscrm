-- =============================================================================
-- Module 2 — Part 4 of 10: record content
--
-- Notes, Updates (with @mentions and generic notifications), Cases, Files,
-- Statements, Logins, and inbound/outbound Messages.
-- =============================================================================

-- Notes: one table, two scopes. "Each tab should have a notes field" is a
-- thread with an author, exactly like the per-field notes.
create table notes (
  id         uuid primary key default gen_random_uuid(),
  record_id  uuid not null references records on delete cascade,
  scope_kind note_scope not null,          -- 'field' | 'tab'
  scope_id   text not null,                -- field key, or 'application/private'
  author_id  uuid not null references profiles,
  body       text not null,
  created_at timestamptz not null default now(),
  edited_at  timestamptz,
  deleted_at timestamptz
);

create index notes_scope
  on notes (record_id, scope_kind, scope_id) where deleted_at is null;

-- -----------------------------------------------------------------------------
-- Updates: threads exactly one level deep
-- -----------------------------------------------------------------------------
create table updates (
  id         uuid primary key default gen_random_uuid(),
  record_id  uuid not null references records on delete cascade,
  parent_id  uuid references updates on delete cascade,
  author_id  uuid not null references profiles,
  body       text not null,
  created_at timestamptz not null default now(),
  edited_at  timestamptz,
  deleted_at timestamptz
);

create index updates_record on updates (record_id, created_at desc) where deleted_at is null;

-- "replies exactly one level deep — no replies to replies"
create or replace function updates_depth_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.parent_id is not null
     and exists (select 1 from updates u where u.id = new.parent_id and u.parent_id is not null)
  then
    raise exception 'Replies are one level deep; cannot reply to a reply'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger updates_depth_guard before insert on updates
  for each row execute function updates_depth_guard();

create table update_mentions (
  update_id uuid not null references updates on delete cascade,
  user_id   uuid not null references profiles on delete cascade,
  primary key (update_id, user_id)
);

-- -----------------------------------------------------------------------------
-- notifications — SCHEMA-DECISIONS §9. Written by the server action that
-- parses an update's rich text for @mentions, in the same transaction as the
-- update itself — NOT by a database trigger (parsing markup in plpgsql is
-- fragile, and the same parse already has to happen server-side to render the
-- mention as a chip). Kept generic (`source_kind`, not `mention_id`/
-- `case_id`/…) per the Modules Plan: "the developer must build the
-- notification primitive generically, not Updates-specific" — case assignment
-- and future sources reuse this same table and insert pattern.
-- -----------------------------------------------------------------------------
create table notifications (
  id           uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references profiles,
  body         text not null,
  record_id    uuid references records,
  source_kind  text not null,
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index notifications_recipient
  on notifications (recipient_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Cases
-- -----------------------------------------------------------------------------

-- "a single global sequence spanning the entire CRM, starting at #10000".
-- nextval is transactional-but-not-rollback-safe by design: a rolled-back
-- insert consumes the number and never reuses it, matching "numbers are never
-- reused, including after a purge".
create sequence case_number_seq start 10000;

create table cases (
  id              uuid primary key default gen_random_uuid(),
  record_id       uuid not null references records on delete cascade,
  number          bigint not null unique default nextval('case_number_seq'),
  title           text not null,
  issue           text not null,                    -- required, immutable
  issue_author    uuid not null references profiles,
  issue_at        timestamptz not null default now(),
  solution        text,
  solution_author uuid references profiles,
  solution_at     timestamptz,
  state           case_state not null default 'open',
  edited_by       uuid references profiles,          -- admin override marker
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  -- "A case cannot be marked Closed until its Solution has been written."
  constraint closed_requires_solution
    check (state = 'open' or solution is not null)
);

create index cases_record on cases (record_id) where deleted_at is null;

create table case_managers (
  case_id uuid not null references cases on delete cascade,
  user_id uuid not null references profiles on delete cascade,
  primary key (case_id, user_id)
);

create table case_replies (
  id         uuid primary key default gen_random_uuid(),
  case_id    uuid not null references cases on delete cascade,
  author_id  uuid not null references profiles,
  body       text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index case_replies_case on case_replies (case_id, created_at);

-- toggle_case_state — enforces closed-requires-solution a second time, as a
-- friendly pre-check ahead of the raw constraint violation, and is the one
-- place "closing" and "reopening" a case are defined.
create or replace function toggle_case_state(p_case_id uuid, p_close boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_close then
    update cases set state = 'closed'
     where id = p_case_id and solution is not null;
    if not found then
      raise exception 'A case cannot be closed until its Solution has been written'
        using errcode = '23514';
    end if;
  else
    update cases set state = 'open' where id = p_case_id;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Files, statements, credentials
-- -----------------------------------------------------------------------------
create table file_rows (
  id         uuid primary key default gen_random_uuid(),
  record_id  uuid not null references records on delete cascade,
  kind       file_row_kind not null,     -- 'application' | 'other'
  name       text not null,
  locked     boolean not null default false,   -- the 5 application rows
  note       text,
  position   int not null default 0,
  deleted_at timestamptz
);

create index file_rows_record on file_rows (record_id) where deleted_at is null;

create table files (
  id           uuid primary key default gen_random_uuid(),
  file_row_id  uuid not null references file_rows on delete cascade,
  storage_path text not null,            -- Supabase Storage, RLS-enforced bucket
  name         text not null,
  size_bytes   bigint not null check (size_bytes <= 25 * 1024 * 1024),
  version      int not null default 1,   -- replacement retains the prior version
  uploaded_by  uuid not null references profiles,
  uploaded_at  timestamptz not null default now(),
  deleted_at   timestamptz
);

create index files_row on files (file_row_id) where deleted_at is null;

-- "each file row holds up to 5 files"
create or replace function files_cap_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (select count(*) from files
      where file_row_id = new.file_row_id and deleted_at is null) >= 5 then
    raise exception 'A file row holds at most 5 files' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger files_cap_guard before insert on files
  for each row execute function files_cap_guard();

-- Month rows are GLOBAL and prebuilt, not per record. Extending a year is 12
-- inserts, not 12 × every record.
create table statement_periods (
  id    uuid primary key default gen_random_uuid(),
  year  int not null,
  month int not null check (month between 1 and 12),
  unique (year, month),
  -- July 2024 is fixed and never moves
  check ((year, month) >= (2024, 7))
);

create table statement_files (
  id           uuid primary key default gen_random_uuid(),
  record_id    uuid not null references records on delete cascade,
  period_id    uuid not null references statement_periods,
  storage_path text not null,
  name         text not null,
  size_bytes   bigint not null check (size_bytes <= 25 * 1024 * 1024),
  uploaded_by  uuid not null references profiles,
  uploaded_at  timestamptz not null default now(),
  deleted_at   timestamptz
);

create index statement_files_record on statement_files (record_id, period_id)
  where deleted_at is null;

-- -----------------------------------------------------------------------------
-- Logins — envelope-encrypted passwords. The plaintext never reaches this
-- table; password_enc/password_key are locked down by column-level REVOKE in
-- migration 9, reachable only through the security-definer reveal_password().
-- -----------------------------------------------------------------------------
create table logins (
  id            uuid primary key default gen_random_uuid(),
  record_id     uuid not null references records on delete cascade,
  login_type    text not null,
  link          text,
  username      text,
  password_enc  bytea,
  password_key  text,
  note          text,
  position      int not null default 0,
  deleted_at    timestamptz
);

create index logins_record on logins (record_id) where deleted_at is null;

-- "every reveal is written to the audit log (user, credential, timestamp)"
create table credential_reveals (
  id       uuid primary key default gen_random_uuid(),
  login_id uuid not null references logins on delete cascade,
  user_id  uuid not null references profiles,
  ip       inet,
  at       timestamptz not null default now()
);

create index credential_reveals_login on credential_reveals (login_id, at desc);

-- -----------------------------------------------------------------------------
-- Messages — inbound/outbound, one row per provider event.
-- -----------------------------------------------------------------------------
create table messages (
  id            uuid primary key default gen_random_uuid(),
  record_id     uuid not null references records on delete cascade,
  channel       message_channel not null,
  direction     message_direction not null,
  from_identity citext not null,
  to_identity   citext not null,
  subject       text,
  body          text,
  external_id   text,                       -- provider id, for idempotency
  sent_at       timestamptz not null,
  created_at    timestamptz not null default now(),
  unique (channel, external_id)              -- "no duplicate creation", structural
);

create index messages_record_channel on messages (record_id, channel, sent_at desc);
