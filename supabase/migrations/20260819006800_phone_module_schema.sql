-- =============================================================================
-- Part 68: the phone module's schema, rewritten for TapDash.
--
-- Ported from Donny's `phone-module` branch of the old CRM (PH1 / PH7a / PH8a /
-- PH9a, 849 lines of SQL). The TABLE SHAPES are his and are kept almost intact —
-- they are well-considered and his webhook code depends on the column names.
-- The POLICIES are rewritten, because his visibility model and this app's are
-- different in a way that cannot be papered over.
--
-- ── WHY THE POLICIES COULD NOT BE PORTED ─────────────────────────────────
-- His RLS is OWNER-scoped: `owner_id = auth.uid() or auth_role() in
-- ('admin','super_admin')`. You see the calls you made.
--
-- TapDash is RECORD-scoped. `record_visible(record_id)` is how `messages`,
-- `notes`, `files` and every other per-record table already answers this, and
-- the client's spec is explicit that which records someone sees is decided by
-- the Team member field and nothing else. Two contradictory visibility models
-- in one CRM would be a defect no test could catch — a rep would see a call in
-- one place and not in another, with no rule explaining which.
--
-- There is also no `auth_role()` here and no `super_admin`. This app has
-- `auth_is_admin()` plus the grant/template system, which is what the
-- `communication/phone` and `communication/recordings` SUBTAB grants are for —
-- those two rows are already seeded, already marked coming_soon, and already
-- carry permission scopes. Per-user access to telephony is therefore
-- configuration, not code, exactly as CLAUDE.md rule 1 requires.
--
-- ── ONE PLACE HIS MODEL IS KEPT, DELIBERATELY: THE AUDIO ─────────────────
-- Asked whether recordings could move into the existing record-scoped bucket,
-- Donny's answer was that `phone-recordings` gates to OWNER AND ADMIN, not by
-- permission, and folding it into a record-scoped bucket "might widen access".
-- He is right, and it changed this migration.
--
-- So the split is:
--   • the CALL ROW is record-scoped — anyone who can see the merchant sees that
--     a call happened, its direction, time and duration. That is the point of
--     putting calls in a CRM at all.
--   • the AUDIO is owner + admin, in its own private bucket, exactly as he
--     built it.
--
-- Chosen conservatively on purpose: this never exposes a recording more widely
-- than his design does. If the client later decides everyone on a record should
-- be able to listen, widening is one policy. Narrowing afterwards would be a
-- decision made after the audio had already been heard.
--
-- A second, duller reason his bucket has to stay: a call from a number matching
-- no record has no record id, so a `<record>/...` storage path cannot even be
-- constructed for it.
--
-- ── SMS: ITS OWN TABLE, WITH A NULLABLE RECORD ───────────────────────────
-- `messages` looked like the natural home — it already has channel/direction/
-- from_identity/to_identity and the Text subtab renders it today. It cannot be:
-- `messages.record_id` is NOT NULL, and a text from a number matching no record
-- is normal, not an error. Widening that column would weaken a table whose
-- whole policy is `record_visible(record_id)`.
--
-- So SMS lives in `phone_messages` with a NULLABLE `record_id`, threaded by the
-- other party's number (`thread_key`) the way Donny built it. One table serves
-- both readers: filter by `record_id` for the drawer's Text subtab, group by
-- `thread_key` for the standalone phone page.
--
-- ── CONVENTIONS THIS FOLLOWS ─────────────────────────────────────────────
--   • FKs point at `profiles(id)`, not `auth.users(id)` — `notes.author_id`
--     and every other table here does the same.
--   • RLS is enabled AND FORCED on every table, default-deny, granted back
--     deliberately (CLAUDE.md rule 7).
--   • Status columns are UNCONSTRAINED TEXT, keeping Donny's reasoning
--     verbatim: Twilio's status vocabulary drifts, and a CHECK constraint would
--     silently reject a value Twilio started sending.
--   • No code names a module. Nothing below references leads, deals or tickets.
-- =============================================================================

-- ── Enums ────────────────────────────────────────────────────────────────
-- Only for vocabularies WE own. Anything Twilio controls stays text.
do $$ begin
  create type phone_direction as enum ('in', 'out');
exception when duplicate_object then null; end $$;

do $$ begin
  create type phone_number_kind as enum ('user', 'campaign');
exception when duplicate_object then null; end $$;

do $$ begin
  create type phone_recording_kind as enum ('call', 'voicemail');
exception when duplicate_object then null; end $$;


-- ── phone_numbers ────────────────────────────────────────────────────────
-- One Twilio number per user. `kind='campaign'` numbers have no owning user and
-- route inbound callbacks to `fallback_user_id` instead (Donny's PH8a shape,
-- kept so the autocaller can be added later without a schema change).
create table if not exists public.phone_numbers (
  id                uuid primary key default gen_random_uuid(),
  e164              text not null,
  kind              phone_number_kind not null default 'user',
  user_id           uuid references public.profiles(id) on delete set null,
  fallback_user_id  uuid references public.profiles(id) on delete set null,
  label             text,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  -- A campaign number must not carry an owning user, and a user number must not
  -- carry a fallback. Enforced here because the routing resolver branches on
  -- exactly this, and a mixed row would route two ways at once.
  constraint phone_numbers_kind_shape check (
    (kind = 'user'     and fallback_user_id is null)
    or
    (kind = 'campaign' and user_id is null)
  )
);

-- One live row per number, and at most one active number per user. Partial, so
-- a soft-deleted or deactivated row never blocks reassignment.
create unique index if not exists phone_numbers_e164_live
  on public.phone_numbers (e164) where deleted_at is null;
create unique index if not exists phone_numbers_one_active_per_user
  on public.phone_numbers (user_id)
  where deleted_at is null and is_active and kind = 'user';


-- ── phone_calls ──────────────────────────────────────────────────────────
create table if not exists public.phone_calls (
  id                uuid primary key default gen_random_uuid(),
  -- Nullable: a call to or from a number matching no record is normal. The
  -- resolver fills this in when a sync-enabled phone field matches.
  record_id         uuid references public.records(id) on delete set null,
  direction         phone_direction not null,
  from_e164         text not null,
  to_e164           text not null,
  -- Twilio's vocabulary, stored raw. See the header note.
  status            text not null default 'queued',
  twilio_call_sid   text,
  -- The person whose line it was: the caller for outbound, the number's owner
  -- for inbound. Null for a call to an unowned number — admin-visible, not lost.
  owner_id          uuid references public.profiles(id) on delete set null,
  created_by_id     uuid references public.profiles(id) on delete set null,
  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  duration_seconds  integer,
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

create unique index if not exists phone_calls_sid_unique
  on public.phone_calls (twilio_call_sid) where twilio_call_sid is not null;
create index if not exists phone_calls_record_idx
  on public.phone_calls (record_id, started_at desc) where deleted_at is null;
create index if not exists phone_calls_owner_idx
  on public.phone_calls (owner_id, started_at desc) where deleted_at is null;


-- ── phone_recordings ─────────────────────────────────────────────────────
-- `transcript` is kept and always null: transcription is deliberately off
-- (Donny's product decision, carried over). The column stays so a better
-- transcription source can fill it later without a migration.
create table if not exists public.phone_recordings (
  id                    uuid primary key default gen_random_uuid(),
  call_id               uuid not null references public.phone_calls(id) on delete cascade,
  kind                  phone_recording_kind not null default 'call',
  twilio_recording_sid  text,
  storage_path          text,
  duration_seconds      integer,
  transcript            text,
  created_at            timestamptz not null default now(),
  deleted_at            timestamptz
);

-- Idempotency for the recording webhook: Twilio retries, and the route
-- pre-checks this SID. The index is the guard that actually holds.
create unique index if not exists phone_recordings_sid_unique
  on public.phone_recordings (twilio_recording_sid) where twilio_recording_sid is not null;
create index if not exists phone_recordings_call_idx
  on public.phone_recordings (call_id) where deleted_at is null;


-- ── phone_messages ───────────────────────────────────────────────────────
create table if not exists public.phone_messages (
  id                  uuid primary key default gen_random_uuid(),
  record_id           uuid references public.records(id) on delete set null,
  -- The conversation key: the OTHER party's E.164, exactly as Donny defined it.
  thread_key          text not null,
  direction           phone_direction not null,
  from_e164           text not null,
  to_e164             text not null,
  body                text,
  status              text not null default 'queued',
  twilio_message_sid  text,
  owner_id            uuid references public.profiles(id) on delete set null,
  created_by_id       uuid references public.profiles(id) on delete set null,
  sent_at             timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  deleted_at          timestamptz
);

create unique index if not exists phone_messages_sid_unique
  on public.phone_messages (twilio_message_sid) where twilio_message_sid is not null;
create index if not exists phone_messages_thread_idx
  on public.phone_messages (thread_key, sent_at desc) where deleted_at is null;
create index if not exists phone_messages_record_idx
  on public.phone_messages (record_id, sent_at desc) where deleted_at is null;


-- ── RLS: enabled AND forced, default-deny, granted back deliberately ─────
alter table public.phone_numbers    enable row level security;
alter table public.phone_numbers    force row level security;
alter table public.phone_calls      enable row level security;
alter table public.phone_calls      force row level security;
alter table public.phone_recordings enable row level security;
alter table public.phone_recordings force row level security;
alter table public.phone_messages   enable row level security;
alter table public.phone_messages   force row level security;

-- Writes are NOT granted to `authenticated` on any of these. Every write comes
-- from a webhook running as the service role, or from a SECURITY DEFINER
-- function that checks the grant chain first — the same shape `messages` uses,
-- and what keeps a single writer per table.
revoke insert, update, delete on
  public.phone_numbers, public.phone_calls, public.phone_recordings, public.phone_messages
  from anon, authenticated;

-- phone_numbers: readable by any signed-in user (the dialer has to know its own
-- number, and the admin screen lists them). It holds no secret — a number is
-- printed on the caller id of every call it places.
drop policy if exists phone_numbers_select on public.phone_numbers;
create policy phone_numbers_select on public.phone_numbers
  for select to authenticated
  using (deleted_at is null);

-- phone_calls: record-scoped, plus the owner's own calls even when the call
-- matched no record (otherwise a rep could not see their own call history).
drop policy if exists phone_calls_select on public.phone_calls;
create policy phone_calls_select on public.phone_calls
  for select to authenticated
  using (
    deleted_at is null
    and (
      auth_is_admin()
      or owner_id = auth.uid()
      or (record_id is not null and record_visible(record_id))
    )
  );

-- phone_messages: identical rule, for the same reason.
drop policy if exists phone_messages_select on public.phone_messages;
create policy phone_messages_select on public.phone_messages
  for select to authenticated
  using (
    deleted_at is null
    and (
      auth_is_admin()
      or owner_id = auth.uid()
      or (record_id is not null and record_visible(record_id))
    )
  );

-- phone_recordings: OWNER AND ADMIN ONLY — narrower than the call row above,
-- and deliberately so. See the header. Someone who can see the merchant learns
-- that a call happened; only the person on it, and an admin, can hear it.
drop policy if exists phone_recordings_select on public.phone_recordings;
create policy phone_recordings_select on public.phone_recordings
  for select to authenticated
  using (
    deleted_at is null
    and exists (
      select 1 from public.phone_calls c
       where c.id = phone_recordings.call_id
         and c.deleted_at is null
         and (auth_is_admin() or c.owner_id = auth.uid())
    )
  );


-- ── The recordings bucket ────────────────────────────────────────────────
-- Private, and SEPARATE from the `records` bucket on purpose — see the header.
-- Path is `calls/<phone_calls.id>/<RecordingSid>.mp3`, so the gate can read the
-- call id out of the second path segment.
insert into storage.buckets (id, name, public)
values ('phone-recordings', 'phone-recordings', false)
on conflict (id) do nothing;

drop policy if exists phone_recordings_bucket_select on storage.objects;
create policy phone_recordings_bucket_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'phone-recordings'
    and exists (
      select 1 from public.phone_calls c
       where c.id = ((storage.foldername(name))[2])::uuid
         and c.deleted_at is null
         and (auth_is_admin() or c.owner_id = auth.uid())
    )
  );
-- No INSERT/UPDATE/DELETE policy: uploads come from the recording webhook,
-- which runs as the service role and bypasses RLS. Nothing signed in should be
-- writing audio into this bucket.
