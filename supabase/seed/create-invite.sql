-- =============================================================================
-- Bootstrap: create the first invite
--
-- Spec §2: "the invite management UI arrives in Phase 3 (Admin Panel). Until
-- then, invites are inserted directly via SQL/Supabase dashboard so the first
-- users — including the super_admin — can be created."
--
-- IMPORTANT: this creates an INVITE, never an account and never a password.
-- The first admin then signs up through /signup like everyone else, so no
-- default credential is ever left behind in the system.
--
-- Usage:
--   1. Replace the email below with the real address.
--   2. Run it against the target database (SQL editor, or `psql`).
--   3. Go to /signup, enter that email, and complete the normal flow.
-- =============================================================================

insert into invites (email, role_id, status, expires_at)
select
  lower(btrim('izzy@example.com')),          -- <-- REPLACE with the real address
  r.id,
  'pending',
  now() + interval '7 days'
from roles r
where r.slug = 'super_admin'
on conflict do nothing;


-- -----------------------------------------------------------------------------
-- Verify it landed
-- -----------------------------------------------------------------------------
-- select i.email, r.slug as role, i.status, i.expires_at
--   from invites i join roles r on r.id = i.role_id
--  order by i.created_at desc
--  limit 5;


-- -----------------------------------------------------------------------------
-- Invite a normal (non-admin) user
-- -----------------------------------------------------------------------------
-- insert into invites (email, role_id, status, expires_at)
-- select lower(btrim('person@example.com')), r.id, 'pending', now() + interval '7 days'
--   from roles r where r.slug = 'member';


-- -----------------------------------------------------------------------------
-- Revoke an invite that has not been used yet
-- -----------------------------------------------------------------------------
-- update invites
--    set status = 'revoked'
--  where email = lower(btrim('person@example.com'))
--    and status = 'pending';


-- -----------------------------------------------------------------------------
-- Pause a user
--
-- Takes effect on their VERY NEXT REQUEST, not their next login — middleware
-- re-checks status every time.
-- -----------------------------------------------------------------------------
-- update profiles set status = 'suspended' where email = lower(btrim('person@example.com'));


-- -----------------------------------------------------------------------------
-- Sign a user out everywhere (moves their session epoch forward)
-- -----------------------------------------------------------------------------
-- update profiles set sessions_valid_from = now() where email = lower(btrim('person@example.com'));


-- -----------------------------------------------------------------------------
-- Read a user's login history (the Admin Panel's drill-down, in SQL for now)
-- -----------------------------------------------------------------------------
-- select created_at, event_type, ip, user_agent
--   from auth_audit_log
--  where email_attempted = lower(btrim('person@example.com'))
--  order by created_at desc
--  limit 50;
