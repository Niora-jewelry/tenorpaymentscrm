-- =============================================================================
-- Module 2 — Part 58: full delete, the third of the client's three levels.
--
-- ── THE REQUIREMENT ──────────────────────────────────────────────────────
-- Admin Plan §2.1: "Remove users — three levels: Pause … Soft delete … Full
-- delete — permanent removal." Migration 55 built Pause's two successors as far
-- as the Recycle Bin. This is the bottom of that bin.
--
-- ── WHY "PERMANENT REMOVAL" CANNOT ALWAYS BE A ROW DELETE ────────────────
-- `profiles` is referenced by fourteen NO ACTION foreign keys, and every one of
-- them is a piece of authorship: who wrote a note, who uploaded a file, who
-- opened a case, who created a record, who revealed a credential. Deleting the
-- row would have to take that history with it or forge it, and this build's
-- whole audit posture (CLAUDE.md §4, "gaps in a history the spec requires to be
-- complete and unbroken … undetectable and unfixable after the fact") says it
-- may do neither.
--
-- So this function does the strongest thing that is actually true, and says
-- which of two things it did:
--
--   'deleted'    Nobody references this person. The `auth.users` row goes,
--                which CASCADEs the profile away — the account and every trace
--                of it are gone. This is the ordinary case for an invited
--                account that never did any work.
--
--   'anonymised' They wrote something. The login is destroyed (the auth row is
--                still deleted where possible; where it is not, the password is
--                cleared and every session invalidated), the name and email are
--                replaced with an unusable placeholder, and every preference,
--                permission and visibility grant is removed. What remains is an
--                id with no person attached to it, so "Deleted user" is what
--                their old notes and files are signed by.
--
-- Both are irreversible and neither leaves a way back in. ⚠️ The distinction is
-- REPORTED rather than hidden, because an admin told "permanently deleted" about
-- a row that still exists has been misled about something they may have a legal
-- duty to be right about.
--
-- ── THE PRECONDITIONS ────────────────────────────────────────────────────
-- Already in the Recycle Bin (soft-deleted first), never yourself, and no
-- records still assigned — all three re-checked here at write time rather than
-- trusted from the screen, exactly as `soft_delete_user` re-counts.
-- `purge_record` sets the same precedent: permanent removal is reachable only
-- from the bin.
-- =============================================================================

create or replace function purge_user(p_user uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email   text;
  v_left    bigint;
  v_stub    text;
begin
  if not auth_is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_user = auth.uid() then
    raise exception 'You cannot delete your own account' using errcode = '23514';
  end if;

  -- Only from the bin. A profile that is still live has not been through the
  -- reversible step, and this one has no reverse.
  select email into v_email from profiles where id = p_user and deleted_at is not null;
  if v_email is null then
    raise exception 'Soft delete this user first — permanent removal is only available from the Recycle Bin'
      using errcode = '23514';
  end if;

  v_left := count_user_records(p_user);
  if v_left > 0 then
    raise exception 'Reassign this user''s % record(s) before deleting them', v_left
      using errcode = '23514';
  end if;

  -- Everything that is purely about this person rather than about their work.
  -- Deleted explicitly rather than left to the CASCADE, because the CASCADE only
  -- fires on the branch where the row can actually go.
  delete from user_grants              where user_id  = p_user;
  delete from user_templates           where user_id  = p_user;
  delete from user_filters             where user_id  = p_user;
  delete from user_column_order        where user_id  = p_user;
  delete from user_field_order         where user_id  = p_user;
  delete from record_visibility_grants where owner_id = p_user or viewer_id = p_user;
  delete from case_managers            where user_id  = p_user;
  delete from record_team_members      where user_id  = p_user;
  delete from update_mentions          where user_id  = p_user;
  delete from notifications            where recipient_id = p_user;

  -- The audit entry is written BEFORE the attempt, and names the email while
  -- there is still an email to name. `auth_audit_log` is append-only at the
  -- database and has no foreign key to `profiles` (migration 18's rule, the same
  -- one that lets a record's activity outlive the record), so it survives either
  -- branch below.
  insert into auth_audit_log (actor_id, event_type, email_attempted, metadata)
  values (auth.uid(), 'user_purged', v_email, jsonb_build_object('user_id', p_user));

  -- ── Branch 1: nothing references them, so they can genuinely go. ──────────
  -- `profiles.id` REFERENCES auth.users ON DELETE CASCADE, so deleting the auth
  -- row removes the profile with it. If any of the fourteen authorship keys
  -- still points here, that CASCADE cannot complete and Postgres raises 23503 —
  -- which is the test, performed by trying it rather than by asking fourteen
  -- questions that could fall out of date with the schema.
  begin
    delete from auth.users where id = p_user;
    return 'deleted';
  exception
    when foreign_key_violation then
      null;   -- fall through to branch 2
  end;

  -- ── Branch 2: they wrote things, so the stub stays and the person goes. ───
  -- A per-row unique placeholder: `profiles.email` is NOT NULL and unique, and
  -- two purged users must not collide.
  v_stub := 'deleted-' || replace(p_user::text, '-', '') || '@removed.invalid';

  update profiles
     set email               = v_stub,
         full_name           = null,
         status              = 'suspended',
         sessions_valid_from = now(),   -- every live session dies here
         last_login_at       = null,
         last_seen_at        = null,
         deleted_at          = now()
   where id = p_user;

  -- The credential itself. Deleting the identities and clearing the password
  -- hash means there is nothing left to sign in with and no way to reset into
  -- the account — the profile row that remains is a name-plate on old work, not
  -- a login.
  delete from auth.identities      where user_id = p_user;
  delete from auth.mfa_factors     where user_id = p_user;
  delete from auth.one_time_tokens where user_id = p_user;
  delete from auth.sessions        where user_id = p_user;
  -- ⚠️ `auth.refresh_tokens.user_id` is `character varying`, not `uuid` — a
  -- GoTrue quirk, and the one column in this block that is. Comparing it to a
  -- uuid raises 42883 ("operator does not exist: character varying = uuid"),
  -- which aborts the purge halfway through with the preferences already gone.
  delete from auth.refresh_tokens  where user_id = p_user::text;

  update auth.users
     set encrypted_password     = null,
         email                  = v_stub,
         email_change           = '',
         email_change_token_new = '',
         recovery_token         = '',
         confirmation_token     = '',
         -- A thousand years rather than `'infinity'`: Postgres accepts the
         -- latter, and GoTrue — which reads this column in Go — does not scan
         -- an infinite timestamp into a `time.Time`. A ban the auth server
         -- cannot read is not a ban.
         banned_until           = now() + interval '1000 years'
   where id = p_user;

  return 'anonymised';
end;
$$;

revoke execute on function purge_user(uuid) from public;
grant  execute on function purge_user(uuid) to authenticated;

comment on function purge_user(uuid) is
  'Admin §2.1 full delete. Removes the row outright when nothing references '
  'the person; otherwise destroys the login and anonymises the profile, '
  'because fourteen NO ACTION keys carry authorship that may not be forged. '
  'Returns which of the two happened — the caller must tell the admin.';
