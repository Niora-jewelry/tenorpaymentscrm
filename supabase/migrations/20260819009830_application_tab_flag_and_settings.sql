-- =============================================================================
-- Prepopulated Application — configuration.
--
--   tabs.shows_applications   which drawer tab carries the Applications panel
--                             (Send Application, statuses, review). A row
--                             flag, like modules.shows_open_cases: no code
--                             names the tab.
--   set_application_settings  Presets › Application: link lifetime and the
--                             email template. Presets page only.
--   default email             names nobody's company, so the same template
--                             reads right on any deployment of the CRM.
-- =============================================================================

alter table tabs add column if not exists shows_applications boolean not null default false;
comment on column tabs.shows_applications is
  'This tab shows the Prepopulated Application panel (send, status, review) above its fields.';
update tabs set shows_applications = true where key = 'application';

update application_settings
   set email_subject = 'Your merchant application — {{merchant}}',
       email_body =
         'Hi {{contact_name}},' || chr(10) || chr(10) ||
         'Here is your merchant application. We have filled in what we already know, so it should only take a few minutes.' || chr(10) || chr(10) ||
         'Complete it online: {{link}}' || chr(10) || chr(10) ||
         'Prefer paper? Fill in the attached PDF on your computer and send it back to us, or upload it on the same page.' || chr(10) || chr(10) ||
         'The link is valid until {{expires}}.' || chr(10) || chr(10) ||
         'Thank you,' || chr(10) || '{{sender_name}}'
 where singleton
   and email_subject = 'Your {{company}} merchant application';

create or replace function set_application_settings(p_expiry_days int, p_subject text, p_body text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not auth_admin_page('presets') then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_expiry_days is null or p_expiry_days < 1 or p_expiry_days > 365 then
    raise exception 'The link must last between 1 and 365 days.' using errcode = '23514';
  end if;
  if coalesce(btrim(p_subject), '') = '' or length(p_subject) > 200 then
    raise exception 'The subject is required (200 characters at most).' using errcode = '23514';
  end if;
  if coalesce(btrim(p_body), '') = '' or length(p_body) > 5000 then
    raise exception 'The message is required (5,000 characters at most).' using errcode = '23514';
  end if;
  update application_settings
     set link_expiry_days = p_expiry_days,
         email_subject = btrim(p_subject),
         email_body = p_body,
         updated_by = auth.uid(),
         updated_at = now()
   where singleton;
end;
$$;
revoke execute on function set_application_settings(int, text, text) from public, anon;
grant execute on function set_application_settings(int, text, text) to authenticated;
