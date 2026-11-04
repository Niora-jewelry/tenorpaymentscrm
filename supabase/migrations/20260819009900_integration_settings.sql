-- Integrations (client, 4 Nov 2026): Twilio, Microsoft 365, SignWell and alert-email
-- keys entered in CRM Settings instead of the hosting environment.
--
-- A value here wins over the environment; with no row the environment still
-- applies, so an empty table changes nothing.
--
-- Values are sealed by the server before they get here (lib/integrations/crypto.ts).
-- No browser role can read or write these tables or call this function: the server
-- reaches them with the service role, after checking the caller is a super admin.

create table if not exists integration_settings (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  grp         text not null check (grp in ('twilio', 'microsoft', 'signwell', 'alerts')),
  sealed      text not null,
  iv          text not null,
  -- What the screen may show: a non-secret value, or "ending in 1234". Never a secret.
  hint        text not null,
  updated_by  uuid references profiles(id) on delete set null,
  updated_at  timestamptz not null default now()
);
alter table integration_settings enable row level security;
alter table integration_settings force row level security;
revoke all on integration_settings from public, anon, authenticated;

-- The last time each service was tested, and how it went.
create table if not exists integration_tests (
  id         uuid primary key default gen_random_uuid(),
  grp        text not null unique check (grp in ('twilio', 'microsoft', 'signwell', 'alerts')),
  ok         boolean not null,
  note       text not null,
  tested_by  uuid references profiles(id) on delete set null,
  tested_at  timestamptz not null default now()
);
alter table integration_tests enable row level security;
alter table integration_tests force row level security;
revoke all on integration_tests from public, anon, authenticated;

-- Who changed which key, and when. Holds no values. Append-only, and it keeps the
-- person's name rather than a link so that removing a user cannot rewrite history.
create table if not exists integration_changes (
  id          uuid primary key default gen_random_uuid(),
  key         text not null,
  grp         text not null,
  action      text not null check (action in ('set', 'removed')),
  hint        text,
  actor_id    uuid,
  actor_name  text not null,
  changed_at  timestamptz not null default now()
);
create index if not exists integration_changes_recent on integration_changes (changed_at desc);
alter table integration_changes enable row level security;
alter table integration_changes force row level security;
revoke all on integration_changes from public, anon, authenticated;

drop trigger if exists integration_changes_append_only on integration_changes;
create trigger integration_changes_append_only
  before update or delete on integration_changes
  for each row execute function refuse_mutation();

-- A change and its history row succeed or fail together.
create or replace function integration_apply(
  p_actor uuid,
  p_group text,
  p_set jsonb,        -- [{ key, sealed, iv, hint }]
  p_remove text[],
  p_test_ok boolean,  -- null = no test ran
  p_test_note text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
  v_row  jsonb;
  v_key  text;
begin
  select coalesce(nullif(trim(p.full_name), ''), p.email, 'Unknown') into v_name from profiles p where p.id = p_actor;
  if v_name is null then raise exception 'unknown user' using errcode = '42501'; end if;

  for v_row in select * from jsonb_array_elements(coalesce(p_set, '[]'::jsonb)) loop
    insert into integration_settings (key, grp, sealed, iv, hint, updated_by, updated_at)
    values (v_row->>'key', p_group, v_row->>'sealed', v_row->>'iv', v_row->>'hint', p_actor, now())
    on conflict (key) do update
      set grp = excluded.grp, sealed = excluded.sealed, iv = excluded.iv, hint = excluded.hint,
          updated_by = excluded.updated_by, updated_at = excluded.updated_at;
    insert into integration_changes (key, grp, action, hint, actor_id, actor_name)
    values (v_row->>'key', p_group, 'set', v_row->>'hint', p_actor, v_name);
  end loop;

  foreach v_key in array coalesce(p_remove, '{}'::text[]) loop
    delete from integration_settings where key = v_key and grp = p_group;
    if found then
      insert into integration_changes (key, grp, action, hint, actor_id, actor_name)
      values (v_key, p_group, 'removed', null, p_actor, v_name);
    end if;
  end loop;

  if p_test_ok is not null then
    insert into integration_tests (grp, ok, note, tested_by, tested_at)
    values (p_group, p_test_ok, coalesce(p_test_note, ''), p_actor, now())
    on conflict (grp) do update
      set ok = excluded.ok, note = excluded.note, tested_by = excluded.tested_by, tested_at = excluded.tested_at;
  end if;
end;
$$;
revoke all on function integration_apply(uuid, text, jsonb, text[], boolean, text) from public, anon, authenticated;
grant execute on function integration_apply(uuid, text, jsonb, text[], boolean, text) to service_role;
