-- =============================================================================
-- Decouple the audit log from the lifetime of the users it references.
--
-- FOUND BY: the end-to-end auth flow test, when deleting a test user failed
-- with "Table auth_audit_log is append-only".
--
-- THE BUG
-- auth_audit_log.actor_id carried `references profiles(id) on delete set null`.
-- Deleting a profile therefore issued an UPDATE against auth_audit_log, which
-- the append-only trigger correctly refused — so users could not be deleted at
-- all.
--
-- The deeper problem is what would have happened if it HAD succeeded: every
-- historical entry for that person would have had its actor blanked. An audit
-- trail that forgets who did something the moment they leave is not an audit
-- trail, and the Admin Module Plan requires exactly this data to survive
-- ("Soft delete", "Full delete", and the per-user login history drill-down).
--
-- THE FIX
-- Drop the foreign key. actor_id keeps the raw uuid forever, independent of
-- whether that profile still exists. This is standard practice for audit
-- tables: they record what happened, not what currently exists.
--
-- Reads join with LEFT JOIN and show the stored email when the profile is gone.
-- =============================================================================

alter table auth_audit_log
  drop constraint if exists auth_audit_log_actor_id_fkey;

comment on column auth_audit_log.actor_id is
  'The acting user at the time of the event. Deliberately NOT a foreign key: the '
  'entry must survive the deletion of the user it refers to, or the trail is '
  'destroyed exactly when it matters most. Join with LEFT JOIN and fall back to '
  'email_attempted when the profile no longer exists.';

-- The same reasoning applies to invites.invited_by: who issued an invitation is
-- history, and must not be rewritten when that admin is removed.
alter table invites
  drop constraint if exists invites_invited_by_fkey;

comment on column invites.invited_by is
  'The admin who created this invite. Not a foreign key, for the same reason as '
  'auth_audit_log.actor_id: removing an admin must not rewrite the record of '
  'what they did.';
