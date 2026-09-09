-- =============================================================================
-- Module 2 — Part 8 of 10: per-user personalization — 19 Aug amendment
--
-- "Admin default → user override → permission filter." Column and field
-- order, plus filters, are personal. Nothing here writes to record_activity —
-- the client's own words: "pure UI preference, would be noise".
--
-- RLS is owner-only and lands in THIS migration, not the big atomic RLS pass
-- in migration 9 — these three tables have exactly one policy shape each and
-- no admin bypass, so there's nothing gained by batching them with the rest.
-- =============================================================================

create table user_column_order (
  user_id   uuid not null references profiles on delete cascade,
  module_id uuid not null references modules  on delete cascade,
  field_id  uuid not null references fields   on delete cascade,
  position  int  not null,
  primary key (user_id, module_id, field_id)
);

-- Deliberately no module_id: the drawer is one global definition, so one
-- saved order per tab covers every module the user opens it from, not five
-- copies of the same preference.
create table user_field_order (
  user_id   uuid not null references profiles on delete cascade,
  tab_id    uuid not null references tabs     on delete cascade,
  subtab_id uuid references subtabs           on delete cascade,
  field_id  uuid not null references fields   on delete cascade,
  position  int  not null,
  primary key (user_id, tab_id, subtab_id, field_id)
);

-- No admin default layer here (unlike columns/fields): a filter is entirely
-- the user's own, so there is nothing to reset TO, only to clear.
create table user_filters (
  user_id    uuid not null references profiles on delete cascade,
  module_id  uuid not null references modules  on delete cascade,
  filters    jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  primary key (user_id, module_id)
);

alter table user_column_order enable row level security;
alter table user_column_order force  row level security;
alter table user_field_order  enable row level security;
alter table user_field_order  force  row level security;
alter table user_filters      enable row level security;
alter table user_filters      force  row level security;

create policy user_column_order_owner on user_column_order
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy user_field_order_owner on user_field_order
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy user_filters_owner on user_filters
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select, insert, update, delete on user_column_order, user_field_order, user_filters
  to authenticated;
