-- =============================================================================
-- The Email module (Outlook / Microsoft 365) — tables.
--
-- Client spec, 16 Oct 2026: a standalone Email module that works like Outlook
-- on the web, two-way synced with Microsoft, up to 30 mailboxes per user,
-- shared mailboxes, admin visibility. Not linked to CRM records — so none of
-- this touches `records` or the record-level `messages` table, which stays as
-- it is.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────
--   mail_identities        a CRM user's Microsoft sign-in (who holds a token)
--   mail_identity_secrets  that token, AES-GCM encrypted in the app (no policies)
--   mail_mailboxes         ONE row per mailbox address — pulled once, however
--                          many people connect it (spec: "no duplicate pulls")
--   mail_connections       user ↔ mailbox, at most 30 live per user
--   mail_folders / mail_messages / mail_attachments   the synced content
--   mail_pins, mail_templates, mail_user_settings, mail_signatures
--   mail_outbox            undo-send hold, scheduled send, send pipeline
--   mail_ops               every change sent to Microsoft, idempotent, retried
--   mail_rules, mail_contacts   caches of Outlook rules and contacts
--   mail_subscriptions, mail_sync_queue, mail_sync_runs, mail_provider_health
--                          the sync engine's own state (service role only)
--   mail_notices           per-user dismissible notices
--
-- ── RULES THIS FOLLOWS (CLAUDE.md) ───────────────────────────────────────
--   * RLS enabled AND forced on every table, from this first migration.
--   * insert/update/delete revoked from anon and authenticated on every table:
--     the sync engine writes as the service role after the app has checked the
--     caller; the few person-initiated writes go through SECURITY DEFINER
--     functions that check the caller themselves (migration 9771).
--   * Vocabularies are text + CHECK, not enums — extending one is then a
--     constraint change, not an `alter type` that cannot share a transaction.
--   * SELECT policies are in 9770, alongside the visibility function they use.
-- =============================================================================

create extension if not exists citext;
create extension if not exists pg_trgm;

-- ── identities ───────────────────────────────────────────────────────────
create table public.mail_identities (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references public.profiles(id) on delete cascade,
  microsoft_user_id         text not null,
  tenant_id                 text,
  primary_email             citext not null,
  display_name              text not null default '',
  scopes                    text[] not null default '{}',
  missing_scopes            text[] not null default '{}',
  status                    text not null default 'ok'
                              check (status in ('ok', 'degraded', 'broken', 'disconnected')),
  status_changed_at         timestamptz not null default now(),
  last_error_code           text check (char_length(last_error_code) <= 64),
  last_error                text check (char_length(last_error) <= 500),
  last_error_at             timestamptz,
  last_token_ok_at          timestamptz,
  consecutive_auth_failures int not null default 0,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  deleted_at                timestamptz
);
create unique index mail_identities_user_oid_live
  on public.mail_identities (user_id, microsoft_user_id) where deleted_at is null;
create index mail_identities_user_idx on public.mail_identities (user_id) where deleted_at is null;

-- Encrypted in Node with MAIL_TOKEN_ENC_KEY (src/lib/mail/crypto.ts); the AAD
-- is identity_id, so a ciphertext copied to another row will not decrypt.
create table public.mail_identity_secrets (
  identity_id             uuid primary key references public.mail_identities(id) on delete cascade,
  refresh_token_enc       bytea not null,
  refresh_token_iv        bytea not null,
  access_token_enc        bytea,
  access_token_iv         bytea,
  access_token_expires_at timestamptz,
  key_version             text not null default 'v1',
  updated_at              timestamptz not null default now()
);

-- ── mailboxes (one per address) ──────────────────────────────────────────
create table public.mail_mailboxes (
  id                    uuid primary key default gen_random_uuid(),
  kind                  text not null check (kind in ('personal', 'shared')),
  address               citext not null,
  graph_user_id         text,
  tenant_id             text,
  display_name          text not null default '',
  sync_identity_id      uuid references public.mail_identities(id) on delete set null,
  sync_status           text not null default 'pending'
                          check (sync_status in ('pending', 'ok', 'throttled', 'degraded', 'broken', 'stalled', 'paused')),
  last_error_code       text check (char_length(last_error_code) <= 64),
  last_error            text check (char_length(last_error) <= 500),
  last_error_at         timestamptz,
  last_graph_ok_at      timestamptz,
  last_sync_at          timestamptz,
  consecutive_failures  int not null default 0,
  throttled_until       timestamptz,
  next_sync_at          timestamptz,
  lease_until           timestamptz,
  lease_owner           text,
  folders_delta_link    text,
  folders_synced_at     timestamptz,
  rules_synced_at       timestamptz,
  rules_viewed_at       timestamptz,
  contacts_delta_link   text,
  contacts_synced_at    timestamptz,
  subscription_healthy  boolean not null default false,
  seeded_at             timestamptz,
  deactivated_at        timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz
);
create unique index mail_mailboxes_address_live on public.mail_mailboxes (address) where deleted_at is null;
create index mail_mailboxes_claim_idx
  on public.mail_mailboxes (lease_until, next_sync_at) where deleted_at is null and deactivated_at is null;

-- ── connections (user ↔ mailbox) ─────────────────────────────────────────
create table public.mail_connections (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles(id) on delete cascade,
  mailbox_id           uuid not null references public.mail_mailboxes(id) on delete cascade,
  identity_id          uuid not null references public.mail_identities(id) on delete cascade,
  status               text not null default 'ok'
                         check (status in ('ok', 'degraded', 'broken', 'paused_user', 'disconnected')),
  status_changed_at    timestamptz not null default now(),
  notice_dismissed_at  timestamptz,
  last_error_code      text check (char_length(last_error_code) <= 64),
  last_error           text check (char_length(last_error) <= 500),
  last_error_at        timestamptz,
  connected_at         timestamptz not null default now(),
  disconnected_at      timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index mail_connections_user_mailbox_live
  on public.mail_connections (user_id, mailbox_id) where disconnected_at is null;
create index mail_connections_mailbox_idx on public.mail_connections (mailbox_id) where disconnected_at is null;
create index mail_connections_user_idx on public.mail_connections (user_id) where disconnected_at is null;

-- The spec's 30-mailbox ceiling, personal and shared together. The advisory
-- lock serialises two connects by the same person so both cannot read "29".
create or replace function public.tg_mail_connection_cap()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  if new.disconnected_at is not null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('mail_conn_cap:' || new.user_id::text));
  select count(*) into v_count
    from public.mail_connections c
   where c.user_id = new.user_id
     and c.disconnected_at is null
     and c.id <> new.id;
  if v_count >= 30 then
    raise exception 'mail_limit_reached' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger mail_connections_cap
  before insert or update of disconnected_at on public.mail_connections
  for each row execute function public.tg_mail_connection_cap();

-- ── folders ──────────────────────────────────────────────────────────────
create table public.mail_folders (
  id                 uuid primary key default gen_random_uuid(),
  mailbox_id         uuid not null references public.mail_mailboxes(id) on delete cascade,
  graph_id           text not null,
  parent_graph_id    text,
  parent_folder_id   uuid references public.mail_folders(id) on delete set null,
  display_name       text not null,
  well_known         text check (well_known in ('inbox', 'drafts', 'sentitems', 'deleteditems', 'junkemail', 'archive', 'outbox')),
  depth              smallint not null default 0,
  total_count        int not null default 0,
  unread_count       int not null default 0,
  child_count        int not null default 0,
  tier               text not null default 'cold' check (tier in ('hot', 'warm', 'cold')),
  delta_link         text,
  delta_synced_at    timestamptz,
  delta_error_count  int not null default 0,
  delta_last_error   text check (char_length(delta_last_error) <= 500),
  seeded_at          timestamptz,
  oldest_loaded_at   timestamptz,
  last_opened_at     timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);
create unique index mail_folders_mailbox_graph on public.mail_folders (mailbox_id, graph_id);
create unique index mail_folders_mailbox_wellknown
  on public.mail_folders (mailbox_id, well_known) where well_known is not null and deleted_at is null;
create index mail_folders_tier_due on public.mail_folders (tier, delta_synced_at) where deleted_at is null;

-- ── messages ─────────────────────────────────────────────────────────────
create table public.mail_messages (
  id                    uuid primary key default gen_random_uuid(),
  mailbox_id            uuid not null references public.mail_mailboxes(id) on delete cascade,
  folder_id             uuid references public.mail_folders(id) on delete set null,
  graph_id              text not null,                      -- IMMUTABLE id
  conversation_id       text,
  conversation_index    text,
  internet_message_id   text,
  change_key            text,
  subject               text,
  from_address          citext,
  from_name             text,
  sender_address        citext,
  to_recipients         jsonb not null default '[]'::jsonb,
  cc_recipients         jsonb not null default '[]'::jsonb,
  bcc_recipients        jsonb not null default '[]'::jsonb,
  reply_to              jsonb not null default '[]'::jsonb,
  recipients_text       text not null default '',
  preview               text,
  body_html             text,                               -- SANITISED at ingest
  body_text             text,
  body_state            text not null default 'stored' check (body_state in ('stored', 'evicted', 'unavailable', 'protected')),
  external_images       jsonb not null default '[]'::jsonb, -- URLs blocked until clicked
  has_attachments       boolean not null default false,
  attachment_names      text not null default '',
  importance            text,
  received_at           timestamptz,
  sent_at               timestamptz,
  is_read               boolean not null default false,
  is_draft              boolean not null default false,
  direction             text not null default 'inbound' check (direction in ('inbound', 'outbound')),
  meeting_message_type  text,
  event_graph_id        text,
  event_start           timestamptz,
  event_end             timestamptz,
  event_location        text,
  event_response        text,
  graph_last_modified   timestamptz,
  synced_at             timestamptz not null default now(),
  search_vector         tsvector generated always as (
      setweight(to_tsvector('simple', coalesce(subject, '')), 'A') ||
      setweight(to_tsvector('simple', coalesce(from_name, '') || ' ' || coalesce(from_address::text, '')), 'A') ||
      setweight(to_tsvector('simple', recipients_text), 'B') ||
      setweight(to_tsvector('simple', attachment_names), 'B') ||
      setweight(to_tsvector('simple', left(coalesce(body_text, ''), 100000)), 'C')
  ) stored,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz
);
alter table public.mail_messages alter column body_html set compression lz4;
alter table public.mail_messages alter column body_text set compression lz4;
-- NOT partial: a message moved away and back must resurrect the same row.
create unique index mail_messages_mailbox_graph on public.mail_messages (mailbox_id, graph_id);
create index mail_messages_folder_recv on public.mail_messages (folder_id, received_at desc) where deleted_at is null;
create index mail_messages_conv on public.mail_messages (mailbox_id, conversation_id, received_at desc) where deleted_at is null;
create index mail_messages_unread on public.mail_messages (folder_id) where deleted_at is null and not is_read;
create index mail_messages_fts on public.mail_messages using gin (search_vector);
create index mail_messages_from_trgm on public.mail_messages using gin ((from_address::text) gin_trgm_ops);

-- ── attachments (metadata only; bytes stream from Microsoft on demand) ───
create table public.mail_attachments (
  id            uuid primary key default gen_random_uuid(),
  message_id    uuid not null references public.mail_messages(id) on delete cascade,
  mailbox_id    uuid not null references public.mail_mailboxes(id) on delete cascade,
  graph_id      text not null,
  name          text not null,
  content_type  text,
  size_bytes    bigint,
  is_inline     boolean not null default false,
  content_id    text,
  kind          text not null default 'file' check (kind in ('file', 'item', 'reference')),
  created_at    timestamptz not null default now()
);
create unique index mail_attachments_msg_graph on public.mail_attachments (message_id, graph_id);

-- ── pins (CRM-only; Graph has no pin API) ────────────────────────────────
create table public.mail_pins (
  mailbox_id      uuid not null references public.mail_mailboxes(id) on delete cascade,
  folder_id       uuid not null references public.mail_folders(id) on delete cascade,
  conversation_id text not null,
  pinned_by_id    uuid references public.profiles(id) on delete set null,
  pinned_at       timestamptz not null default now(),
  primary key (mailbox_id, folder_id, conversation_id)
);

-- ── templates (owner_id null = shared, company-wide) ─────────────────────
create table public.mail_templates (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid references public.profiles(id) on delete cascade,
  name           text not null check (char_length(name) between 1 and 120),
  subject        text check (char_length(subject) <= 255),
  body_html      text not null check (char_length(body_html) <= 200000),
  created_by_id  uuid not null references public.profiles(id),
  updated_by_id  uuid references public.profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);
create index mail_templates_owner on public.mail_templates (owner_id) where deleted_at is null;

-- ── per-user settings ────────────────────────────────────────────────────
create table public.mail_user_settings (
  user_id                       uuid primary key references public.profiles(id) on delete cascade,
  undo_send_seconds             smallint not null default 5 check (undo_send_seconds between 1 and 10),
  hide_my_mailboxes_from_admins boolean not null default false,
  default_from_mailbox_id       uuid references public.mail_mailboxes(id) on delete set null,
  updated_at                    timestamptz not null default now()
);

-- ── signatures (Graph has no signature API — captured in the CRM) ────────
create table public.mail_signatures (
  mailbox_id    uuid primary key references public.mail_mailboxes(id) on delete cascade,
  body_html     text not null check (char_length(body_html) <= 50000),
  source        text not null default 'manual' check (source in ('manual', 'detected', 'confirmed')),
  updated_by_id uuid references public.profiles(id) on delete set null,
  updated_at    timestamptz not null default now()
);

-- ── outbox: undo-send hold, scheduled send, send pipeline ────────────────
create table public.mail_outbox (
  id                      uuid primary key default gen_random_uuid(),
  idempotency_key         uuid not null unique,
  mailbox_id              uuid not null references public.mail_mailboxes(id) on delete cascade,
  user_id                 uuid not null references public.profiles(id) on delete cascade,
  identity_id             uuid references public.mail_identities(id) on delete set null,
  kind                    text not null check (kind in ('new', 'reply', 'replyAll', 'forward')),
  source_graph_id         text,
  existing_draft_graph_id text,
  subject                 text check (char_length(subject) <= 255),
  body_html               text not null check (char_length(body_html) <= 2000000),
  to_recipients           jsonb not null default '[]'::jsonb,
  cc_recipients           jsonb not null default '[]'::jsonb,
  bcc_recipients          jsonb not null default '[]'::jsonb,
  attachments             jsonb not null default '[]'::jsonb,
  status                  text not null check (status in ('held', 'scheduled', 'sending', 'sent', 'cancelled', 'failed')),
  release_at              timestamptz not null,
  draft_graph_id          text,
  sent_graph_id           text,
  attempts                int not null default 0,
  lease_until             timestamptz,
  last_error_code         text check (char_length(last_error_code) <= 64),
  last_error              text check (char_length(last_error) <= 500),
  acknowledged_at         timestamptz,
  sent_at                 timestamptz,
  cancelled_at            timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index mail_outbox_due on public.mail_outbox (release_at) where status in ('held', 'scheduled');
create index mail_outbox_user on public.mail_outbox (user_id, created_at desc);

-- ── ops: every change sent to Microsoft ──────────────────────────────────
create table public.mail_ops (
  id               uuid primary key default gen_random_uuid(),
  idempotency_key  uuid not null unique,
  mailbox_id       uuid not null references public.mail_mailboxes(id) on delete cascade,
  user_id          uuid not null references public.profiles(id) on delete cascade,
  identity_id      uuid references public.mail_identities(id) on delete set null,
  kind             text not null check (kind in (
                     'mark_read', 'mark_unread', 'move', 'hard_delete',
                     'folder_create', 'folder_rename', 'folder_move_to_deleted', 'folder_hard_delete',
                     'rule_create', 'rule_update', 'rule_delete', 'rule_reorder',
                     'event_accept', 'event_decline', 'draft_patch', 'draft_delete')),
  target_graph_id  text,
  payload          jsonb not null default '{}'::jsonb,
  status           text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempts         int not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_error_code  text check (char_length(last_error_code) <= 64),
  last_error       text check (char_length(last_error) <= 500),
  created_at       timestamptz not null default now(),
  done_at          timestamptz
);
create index mail_ops_pending on public.mail_ops (mailbox_id, next_attempt_at) where status in ('queued', 'running');
create index mail_ops_target on public.mail_ops (mailbox_id, target_graph_id) where status in ('queued', 'running');

-- ── caches: Outlook rules and contacts ───────────────────────────────────
create table public.mail_rules (
  id            uuid primary key default gen_random_uuid(),
  mailbox_id    uuid not null references public.mail_mailboxes(id) on delete cascade,
  graph_id      text not null,
  display_name  text not null,
  sequence      int not null,
  is_enabled    boolean not null,
  is_read_only  boolean not null default false,
  has_error     boolean not null default false,
  conditions    jsonb,
  exceptions    jsonb,
  actions       jsonb,
  synced_at     timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index mail_rules_mailbox_graph on public.mail_rules (mailbox_id, graph_id);

create table public.mail_contacts (
  id            uuid primary key default gen_random_uuid(),
  mailbox_id    uuid not null references public.mail_mailboxes(id) on delete cascade,
  graph_id      text not null,
  display_name  text,
  addresses     text[] not null default '{}',
  search_text   text not null default '',
  synced_at     timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index mail_contacts_mailbox_graph on public.mail_contacts (mailbox_id, graph_id);
create index mail_contacts_trgm on public.mail_contacts using gin (search_text gin_trgm_ops);

-- ── engine state (service role only — no policies in 9770) ───────────────
create table public.mail_subscriptions (
  id                    uuid primary key default gen_random_uuid(),
  mailbox_id            uuid not null references public.mail_mailboxes(id) on delete cascade,
  resource              text not null check (resource in ('messages', 'mailFolders')),
  graph_subscription_id text,
  client_state          text not null,
  expires_at            timestamptz,
  status                text not null default 'failed' check (status in ('active', 'expired', 'failed', 'removed')),
  last_notification_at  timestamptz,
  last_error            text check (char_length(last_error) <= 500),
  renewed_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create unique index mail_subscriptions_mailbox_resource on public.mail_subscriptions (mailbox_id, resource);
create index mail_subscriptions_graph_id on public.mail_subscriptions (graph_subscription_id);

create table public.mail_sync_queue (
  id            bigint generated always as identity primary key,
  mailbox_id    uuid not null references public.mail_mailboxes(id) on delete cascade,
  kind          text not null check (kind in (
                  'message_changed', 'message_deleted', 'folder_delta', 'folders_refresh', 'seed_folder',
                  'load_older', 'subscription_ensure', 'rules_refresh', 'contacts_delta', 'attachments_list')),
  target        text not null default '',
  payload       jsonb not null default '{}'::jsonb,
  priority      smallint not null default 5,
  requested_at  timestamptz not null default now(),
  not_before    timestamptz not null default now(),
  attempts      int not null default 0,
  last_error    text check (char_length(last_error) <= 500),
  processed_at  timestamptz
);
create unique index mail_sync_queue_coalesce
  on public.mail_sync_queue (mailbox_id, kind, target) where processed_at is null;
create index mail_sync_queue_due
  on public.mail_sync_queue (mailbox_id, priority, not_before) where processed_at is null;

create table public.mail_sync_runs (
  id           bigint generated always as identity primary key,
  mailbox_id   uuid references public.mail_mailboxes(id) on delete cascade,
  trigger      text not null,
  status       text not null default 'running' check (status in ('running', 'ok', 'throttled', 'failed')),
  items        int not null default 0,
  error_code   text check (char_length(error_code) <= 64),
  error_detail text check (char_length(error_detail) <= 500),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index mail_sync_runs_mailbox on public.mail_sync_runs (mailbox_id, started_at desc);

create table public.mail_provider_health (
  id              smallint primary key default 1 check (id = 1),
  state           text not null default 'up' check (state in ('up', 'down', 'config_error')),
  down_since      timestamptz,
  last_success_at timestamptz,
  last_probe_at   timestamptz,
  last_error_code text check (char_length(last_error_code) <= 64),
  updated_at      timestamptz not null default now()
);
insert into public.mail_provider_health (id) values (1) on conflict do nothing;

-- ── per-user notices ─────────────────────────────────────────────────────
create table public.mail_notices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  kind         text not null check (kind in ('connection_broken', 'send_failed', 'scheduled_failed', 'action_failed', 'draft_conflict')),
  mailbox_id   uuid references public.mail_mailboxes(id) on delete cascade,
  outbox_id    uuid references public.mail_outbox(id) on delete set null,
  body         text not null check (char_length(body) <= 500),
  created_at   timestamptz not null default now(),
  dismissed_at timestamptz
);
create unique index mail_notices_one_open_broken
  on public.mail_notices (user_id, mailbox_id) where kind = 'connection_broken' and dismissed_at is null;
create index mail_notices_open on public.mail_notices (user_id) where dismissed_at is null;

-- ── updated_at maintenance (tg_set_updated_at exists since 009699) ───────
create trigger mail_identities_set_updated_at before update on public.mail_identities
  for each row execute function public.tg_set_updated_at();
create trigger mail_mailboxes_set_updated_at before update on public.mail_mailboxes
  for each row execute function public.tg_set_updated_at();
create trigger mail_connections_set_updated_at before update on public.mail_connections
  for each row execute function public.tg_set_updated_at();
create trigger mail_folders_set_updated_at before update on public.mail_folders
  for each row execute function public.tg_set_updated_at();
create trigger mail_messages_set_updated_at before update on public.mail_messages
  for each row execute function public.tg_set_updated_at();
create trigger mail_templates_set_updated_at before update on public.mail_templates
  for each row execute function public.tg_set_updated_at();
create trigger mail_outbox_set_updated_at before update on public.mail_outbox
  for each row execute function public.tg_set_updated_at();
create trigger mail_subscriptions_set_updated_at before update on public.mail_subscriptions
  for each row execute function public.tg_set_updated_at();

-- ── RLS: enabled AND forced on every table; writes revoked ───────────────
do $$
declare t text;
begin
  foreach t in array array[
    'mail_identities', 'mail_identity_secrets', 'mail_mailboxes', 'mail_connections', 'mail_folders',
    'mail_messages', 'mail_attachments', 'mail_pins', 'mail_templates', 'mail_user_settings',
    'mail_signatures', 'mail_outbox', 'mail_ops', 'mail_rules', 'mail_contacts', 'mail_subscriptions',
    'mail_sync_queue', 'mail_sync_runs', 'mail_provider_health', 'mail_notices'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

revoke execute on function public.tg_mail_connection_cap() from public, anon, authenticated;
