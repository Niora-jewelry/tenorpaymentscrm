-- ============================================================================
-- The inbound phone menu, as configuration.
--
-- Source: the client's "During Hours TapDash" and "After Hours TapDash"
-- documents, and his answers to the fifteen questions raised against them.
--
-- ── WHY ALL OF THIS IS DATA AND NONE OF IT IS CODE ─────────────────────────
-- Two of the client's answers are not yet knowable:
--
--   Q4  "I WANT TO PORT 7324793050 IN TO TWILLIO AND HAVE THAT NUMBER AS THE
--        MAIN NUMBER"   - porting takes days and has not happened
--   Q5  "WE WILL ADD EXTENSIONS AFTER"
--
-- Neither is a reason to wait. A number is a row, an extension is a row, and
-- the greeting wording is a row - so the menu can be built, tested and shipped
-- now, and switching to the ported number later is an UPDATE rather than a
-- deploy. This is the same principle as CLAUDE.md rule 1: the thing that
-- varies belongs in a table, not in an `if`.
--
-- The prompt wording is here for the same reason. It came from a Word document
-- and will be reworded; an admin editing a sentence should not require a
-- release.
--
-- ── WHAT HAPPENS BEFORE THE EXTENSIONS EXIST ───────────────────────────────
-- Option 1 transfers to people who have not been configured yet. The menu must
-- not answer and then fall silent, so "nobody to ring" is a defined state that
-- goes to voicemail. Verified by test, because it is the state the system is
-- actually in today.
-- ============================================================================

-- ── settings ────────────────────────────────────────────────────────────────
-- One row. The `singleton` column with its check + unique index is how that is
-- enforced, rather than by everyone remembering to write `limit 1`.
create table if not exists public.ivr_settings (
  singleton          boolean primary key default true check (singleton),

  -- The number the menu answers on. Null until one is chosen, which is the
  -- honest state right now: 732-479-3050 is still with the old carrier.
  main_number_e164   text,

  -- Q14: "NO" to a holiday list, so hours are the weekly schedule alone.
  -- Stored as a name rather than an offset so daylight saving is the database's
  -- problem, not ours. The documents say Eastern.
  timezone           text not null default 'America/New_York',

  -- Q9: voicemail goes here, and only here. The documents say so twice, in
  -- capitals both times: "The voicemail should go to info@tapdash.co ONLY".
  voicemail_email    text not null default 'info@tapdash.co',

  -- Q10: "STANDARD". Twilio hosts these, so there is nothing to upload and
  -- nothing to keep alive.
  hold_music_url     text not null default 'http://com.twilio.music.classical.s3.amazonaws.com/BusyStrings.mp3',

  -- Q15: "YES" - callers hear that the call may be recorded.
  record_notice      boolean not null default true,

  -- Q11: "COMPUTER". Twilio's neural voices; Polly.Joanna is the US English
  -- default and is what <Say> uses unless told otherwise.
  voice              text not null default 'Polly.Joanna-Neural',
  language           text not null default 'en-US',

  -- The master switch. Off means the inbound behaviour that existed before
  -- this migration - ring the number's owner, else voicemail - so the menu can
  -- be turned on and off without a deploy, and turned off fast if it misbehaves
  -- on a live number.
  enabled            boolean not null default false,

  -- How long to ring before offering voicemail. The documents say one minute.
  ring_seconds       integer not null default 60 check (ring_seconds between 5 and 600),
  -- Cap on one voicemail.
  voicemail_max_seconds integer not null default 180 check (voicemail_max_seconds between 10 and 600),

  updated_at         timestamptz not null default now()
);

insert into public.ivr_settings (singleton) values (true)
on conflict (singleton) do nothing;

-- ── opening hours ───────────────────────────────────────────────────────────
-- Mon-Thu 9-5, Fri 9-3, closed at weekends. A row per open day; a day with no
-- row is closed, which is why Saturday and Sunday simply are not here.
create table if not exists public.ivr_hours (
  -- 0 = Sunday, matching both PostgreSQL's `extract(dow)` and JavaScript's
  -- getDay(), so no translation is needed at either end.
  day_of_week  smallint primary key check (day_of_week between 0 and 6),
  opens_at     time not null,
  closes_at    time not null,
  constraint ivr_hours_ordered check (closes_at > opens_at)
);

insert into public.ivr_hours (day_of_week, opens_at, closes_at) values
  (1, '09:00', '17:00'),  -- Monday
  (2, '09:00', '17:00'),
  (3, '09:00', '17:00'),
  (4, '09:00', '17:00'),  -- Thursday
  (5, '09:00', '15:00')   -- Friday closes at 3
on conflict (day_of_week) do nothing;

-- ── what callers hear ───────────────────────────────────────────────────────
-- Keyed by slug so the TwiML builder asks for 'greeting_open' and gets whatever
-- wording is current. Text taken verbatim from the client's documents.
create table if not exists public.ivr_prompts (
  slug        text primary key,
  body        text not null,
  updated_at  timestamptz not null default now(),
  constraint ivr_prompts_body_not_blank check (length(btrim(body)) > 0)
);

insert into public.ivr_prompts (slug, body) values
  ('greeting_open',
   'Thank you for calling TapDash Payments. We appreciate your business and are here to assist you. '
   'If you know your party''s extension, you may dial it at any time. '
   'For sales inquiries, please press 1. '
   'For merchant support, please press 2. '
   'For the Discover Settlement please press 3. '
   'For all other inquiries, please stay on the line, and one of our representatives will be with you shortly. '
   'Thank you for choosing TapDash and we look forward to serving you!'),

  ('greeting_closed',
   'Thank you for calling TapDash Payments. Our office is currently closed. Our regular business hours are '
   'Monday through Thursday, 9 AM to 5 PM Eastern, and Friday, 9 AM to 3 PM Eastern. '
   'To access the Discover Class Action Settlement Fund please visit tapdash.co forward slash discover. '
   'If you''d like us to check if any of our hardworking representatives are available, please press 1. '
   'To leave a voicemail, press 2, and we will return your call during business hours. '
   'If this is an emergency, please email a short description to urgent at tapdash.co to reach our after-hours team. '
   'Thank you for choosing TapDash Payments, and we look forward to assisting you.'),

  ('transfer_open',
   'Please hold while we transfer your call to the next available representative. '
   'We appreciate your patience and will be with you shortly.'),

  ('transfer_closed',
   'Please hold while we check for one of our dedicated representatives. '
   'We appreciate your patience and will assist you as soon as possible.'),

  ('high_volume',
   'We are currently experiencing high call volume. If you would like to leave a voicemail, please press 1. '
   'Otherwise, simply remain on the line, and the next available representative will assist you shortly. '
   'Thank you for your patience.'),

  ('voicemail_prompt',
   'Please leave your message after the beep, and one of our representatives will get back to you as soon as '
   'possible. Thank you, and have a great day!'),

  ('voicemail_closed',
   'Unfortunately, we are unable to take your call at this time. Please leave a message after the beep, and a '
   'representative will get back to you as soon as possible. If this is an emergency, please email urgent at '
   'tapdash.co to reach our after-hours team.'),

  ('support_transfer',
   'Thank you for reaching out to merchant support. When prompted please press option 3 to reach one of our '
   'support representatives.'),

  ('discover',
   'The Discover Class Action Settlement is available to nearly all merchants who processed Discover credit '
   'card transactions between January 1, 2007 and December 31, 2023. To apply online, visit tapdash.co '
   'forward slash discover and click on the 60-second quiz.'),

  -- Q13: "SAY THAT IS A INVALID ENTRY".
  ('invalid_entry', 'That is an invalid entry.'),

  -- Q15: "YES".
  ('record_notice', 'This call may be recorded for quality and training purposes.')
on conflict (slug) do nothing;

-- ── who the menu rings ──────────────────────────────────────────────────────
create table if not exists public.ivr_extensions (
  id              uuid primary key default gen_random_uuid(),

  -- What a caller dials to reach this person directly. The greeting promises
  -- "if you know your party's extension, you may dial it at any time", so this
  -- is a real feature and not decoration. Null means "rings in the group but
  -- has no direct number yet" - the state everything is in until the client
  -- supplies them (Q5: "WE WILL ADD EXTENSIONS AFTER").
  digits          text unique check (digits is null or digits ~ '^[0-9]{1,6}$'),
  label           text not null,

  -- A row may ring a browser, a real telephone, or both. Q6 asked where calls
  -- should land and the answer was "the document says where it should ring" -
  -- the during-hours document says extensions, the after-hours document says
  -- extensions AND three mobile numbers. Both columns exist so one row can be
  -- a person reachable either way.
  user_id         uuid references public.profiles(id) on delete set null,
  external_e164   text check (external_e164 is null or external_e164 ~ '^\+[1-9][0-9]{6,14}$'),

  -- Q7: "DURING HOURS IT SHOULD NOT RING THERE" - the mobiles are after-hours
  -- only. Two flags rather than one, because that difference is the answer.
  ring_during_hours boolean not null default false,
  ring_after_hours  boolean not null default false,

  position        integer not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),

  -- A row that rings nothing is a configuration mistake that would be invisible
  -- at runtime: the group would simply be one smaller than the admin believes.
  constraint ivr_extensions_rings_something
    check (user_id is not null or external_e164 is not null)
);

/*
 * The three mobiles from the after-hours document, seeded because they are
 * stated outright there and are not waiting on anything:
 *   "It should also ring at 973 370 4989, 732 351 5922 and 908 783 2747"
 *
 * After-hours only, per Q7. The named people - Eli Birnhack, Izzy Hershko and
 * Jay Birnhack - are deliberately NOT guessed at here: which mobile belongs to
 * whom is not stated in either document, and a wrong guess would route a call
 * to the wrong person while looking perfectly correct.
 */
insert into public.ivr_extensions (label, external_e164, ring_after_hours, position)
values
  ('After-hours mobile 1', '+19733704989', true, 10),
  ('After-hours mobile 2', '+17323515922', true, 20),
  ('After-hours mobile 3', '+19087832747', true, 30)
on conflict do nothing;

create index if not exists ivr_extensions_during_idx
  on public.ivr_extensions (position) where is_active and ring_during_hours;
create index if not exists ivr_extensions_after_idx
  on public.ivr_extensions (position) where is_active and ring_after_hours;

-- ── voicemail ───────────────────────────────────────────────────────────────
-- A voicemail is already a `phone_recordings` row with kind = 'voicemail'.
-- What is NOT already recorded is whether the email went out, and that matters:
-- the documents are emphatic that voicemail reaches info@tapdash.co, so a
-- failed send must be visible rather than assumed.
create table if not exists public.ivr_voicemail_deliveries (
  id            uuid primary key default gen_random_uuid(),
  recording_id  uuid not null references public.phone_recordings(id) on delete cascade,
  to_email      text not null,
  delivered_at  timestamptz,
  error         text,
  attempts      integer not null default 0,
  created_at    timestamptz not null default now(),

  -- One delivery record per recording; retries increment `attempts` rather
  -- than inserting again, so "did this voicemail get emailed" has one answer.
  constraint ivr_voicemail_deliveries_one_per_recording unique (recording_id)
);

-- ============================================================================
-- RLS — default deny. These tables are read by the webhooks with the service
-- role, and administered by admins. Nobody else needs them at all.
-- ============================================================================
alter table public.ivr_settings              enable row level security;
alter table public.ivr_settings              force  row level security;
alter table public.ivr_hours                 enable row level security;
alter table public.ivr_hours                 force  row level security;
alter table public.ivr_prompts               enable row level security;
alter table public.ivr_prompts               force  row level security;
alter table public.ivr_extensions            enable row level security;
alter table public.ivr_extensions            force  row level security;
alter table public.ivr_voicemail_deliveries  enable row level security;
alter table public.ivr_voicemail_deliveries  force  row level security;

revoke all on public.ivr_settings             from anon;
revoke all on public.ivr_hours                from anon;
revoke all on public.ivr_prompts              from anon;
revoke all on public.ivr_extensions           from anon;
revoke all on public.ivr_voicemail_deliveries from anon;

grant select, insert, update, delete on public.ivr_settings   to authenticated;
grant select, insert, update, delete on public.ivr_hours      to authenticated;
grant select, insert, update, delete on public.ivr_prompts    to authenticated;
grant select, insert, update, delete on public.ivr_extensions to authenticated;
grant select on public.ivr_voicemail_deliveries to authenticated;

-- Admin-only, every table, every verb. `auth_is_admin()` already exists and is
-- what the rest of the schema uses.
do $$
declare t text;
begin
  foreach t in array array['ivr_settings', 'ivr_hours', 'ivr_prompts', 'ivr_extensions'] loop
    execute format('drop policy if exists %1$s_admin_all on public.%1$s', t);
    execute format(
      'create policy %1$s_admin_all on public.%1$s for all to authenticated '
      'using (auth_is_admin()) with check (auth_is_admin())', t);
  end loop;
end $$;

drop policy if exists ivr_voicemail_deliveries_admin_select on public.ivr_voicemail_deliveries;
create policy ivr_voicemail_deliveries_admin_select on public.ivr_voicemail_deliveries
  for select to authenticated using (auth_is_admin());

-- ============================================================================
-- Is the office open right now?
--
-- In SQL rather than TypeScript because the answer depends on a timezone and a
-- set of rows, and because both the menu and any admin screen must agree. Two
-- implementations of "are we open" would eventually disagree by an hour twice
-- a year, when the clocks change, and nobody would notice until a caller did.
-- ============================================================================
create or replace function public.ivr_is_open(p_at timestamptz default now())
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz    text;
  v_local timestamp;
  v_row   public.ivr_hours%rowtype;
begin
  select timezone into v_tz from public.ivr_settings where singleton;
  v_tz := coalesce(v_tz, 'America/New_York');

  -- The conversion is the whole point: 9am Eastern is a different UTC instant
  -- in January and in July.
  v_local := p_at at time zone v_tz;

  select * into v_row
    from public.ivr_hours
   where day_of_week = extract(dow from v_local)::smallint;

  -- No row for this weekday means closed. That is how Saturday and Sunday are
  -- expressed, rather than as rows saying "closed all day".
  if not found then
    return false;
  end if;

  return v_local::time >= v_row.opens_at and v_local::time < v_row.closes_at;
end;
$$;

revoke all on function public.ivr_is_open(timestamptz) from public;
grant execute on function public.ivr_is_open(timestamptz) to authenticated, service_role;

comment on function public.ivr_is_open(timestamptz) is
  'True while the office is open, per ivr_hours in ivr_settings.timezone. '
  'A weekday with no ivr_hours row is closed.';
