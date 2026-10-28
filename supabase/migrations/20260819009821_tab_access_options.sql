-- =============================================================================
-- Which levels a drawer tab offers (Permissions spec, "Tab levels").
--
--   levels       Hidden · View only · Edit            (most tabs; Logins' View
--                                                     is "View / copy only")
--   hidden_full  Hidden · Full access                 (Marketing)
--   setting      no tab level at all — a setting decides it:
--                  Communication → communication.scope ("There is no Hidden
--                  option … no separate sub tab settings"),
--                  Updates / Cases → items.updates / items.cases.
--
-- A row in tables, not code: a new tab is configuration. The trigger refuses a
-- grant the tab does not offer, on every grant table, so no writer can store
-- a level the spec says does not exist.
-- =============================================================================

alter table tabs
  add column if not exists access_options text not null default 'levels'
    check (access_options in ('levels', 'hidden_full', 'setting'));

comment on column tabs.access_options is
  'levels = Hidden/View/Edit; hidden_full = Hidden/Full (no View); setting = no tab, sub-tab or field level — a permission setting decides it.';

update tabs set access_options = 'hidden_full' where key = 'marketing';
update tabs set access_options = 'setting' where kind in ('communication', 'updates', 'cases');

-- The seeded Edit rows on those tabs say nothing (Edit is the default) and
-- would now be refused; remove them so every stored grant is one the tab offers.
delete from template_grants g using tabs t
 where g.scope_kind = 'tab' and g.scope_id = t.id and t.access_options = 'setting';
delete from template_grants g using subtabs s join tabs t on t.id = s.tab_id
 where g.scope_kind = 'subtab' and g.scope_id = s.id and t.access_options = 'setting';
delete from user_grants g using tabs t
 where g.scope_kind = 'tab' and g.scope_id = t.id and t.access_options = 'setting';
delete from user_grants g using subtabs s join tabs t on t.id = s.tab_id
 where g.scope_kind = 'subtab' and g.scope_id = s.id and t.access_options = 'setting';
delete from invite_grants g using tabs t
 where g.scope_kind = 'tab' and g.scope_id = t.id and t.access_options = 'setting';
delete from invite_grants g using subtabs s join tabs t on t.id = s.tab_id
 where g.scope_kind = 'subtab' and g.scope_id = s.id and t.access_options = 'setting';

create or replace function grants_respect_tab_access_options()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_opts  text;
  v_label text;
begin
  if new.scope_kind = 'tab' then
    select access_options, label into v_opts, v_label from tabs where id = new.scope_id;
  elsif new.scope_kind = 'subtab' then
    select t.access_options, t.label into v_opts, v_label
      from subtabs s join tabs t on t.id = s.tab_id where s.id = new.scope_id;
  else
    return new;
  end if;

  if v_opts = 'setting' then
    raise exception 'The % tab has no tab or sub-tab level — its setting decides it.', v_label using errcode = '23514';
  end if;
  if v_opts = 'hidden_full' and new.scope_kind = 'tab' and new.grant_level = 'view' then
    raise exception 'The % tab is Hidden or Full access — there is no View only.', v_label using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists template_grants_respect_tab_access_options on template_grants;
create trigger template_grants_respect_tab_access_options
  before insert or update on template_grants
  for each row execute function grants_respect_tab_access_options();

drop trigger if exists user_grants_respect_tab_access_options on user_grants;
create trigger user_grants_respect_tab_access_options
  before insert or update on user_grants
  for each row execute function grants_respect_tab_access_options();

drop trigger if exists invite_grants_respect_tab_access_options on invite_grants;
create trigger invite_grants_respect_tab_access_options
  before insert or update on invite_grants
  for each row execute function grants_respect_tab_access_options();
