-- =============================================================================
-- Part 86: three read functions a signed-in user could call but never needs.
--
-- Found by listing every SECURITY DEFINER function `authenticated` may EXECUTE
-- and checking what each one guards with. Most were fine. These were not, and
-- none of them is a write — they leak, they do not damage.
--
-- ── 1. `effective_grants(u)` — ANY user's whole permission map ────────────
-- The app reads this through `supabaseAdmin()` (`lib/records/permissions.ts`,
-- and its own comment says so: "Service-role, because the function is revoked
-- from PUBLIC"). It was not revoked from `authenticated`, so the request-scoped
-- client could call it too — with ANY user id:
--
--   POST /rest/v1/rpc/effective_grants  {"u":"<any profile id>"}
--
-- That returns the complete grant map for that person: every module, tab,
-- subtab and field they are allowed to see, and which ones are restricted.
-- A member could read the administrator's, or map the whole permission model
-- to find which record holds what. It is a disclosure of the security
-- configuration, not a way to change it — but it is the blueprint.
--
-- Revoked rather than guarded to self: nothing signed in ever calls it.
--
-- ── 2. `effective_grant(u, kind, scope, module)` — the same, one at a time ─
-- The four-argument form was granted to `authenticated` when migration 78
-- added it. The original three-argument form never was, and nothing broke,
-- which is the proof that no caller needs it: every consumer is a SECURITY
-- DEFINER function, and those run as `postgres` and do not consult the
-- caller's privileges. Checked before revoking: no RLS policy on any table
-- calls `effective_grant` directly.
--
-- ── 3. `resolve_record_by_phone` / `resolve_records_by_phones` ───────────
-- These scan every record in the database for a matching phone number and
-- return the record id and deal name, with no visibility filter — correct for
-- their only caller, an inbound Twilio webhook, which has no viewer to filter
-- by and must route a call regardless of who is looking.
--
-- Both are reached exclusively through `supabaseAdmin()` — the two webhook
-- routes and `lib/phone/{calls,messages}.ts` — so the grant to `authenticated`
-- was unused reach. Left in place it is a phone-number oracle: feed it numbers,
-- learn which ones belong to a merchant in this CRM and what that merchant is
-- called, including records the caller cannot open.
--
-- ── 4. `count_user_records(p_user)` — guarded, not revoked ───────────────
-- Different case: this one IS called with the request-scoped client, by the
-- admin Users screen, so the grant has to stay. `getUserRecordCount` calls
-- `assertAdmin(ctx)` first — in the app. The function itself asked nothing, so
-- calling it directly told any member how many records any colleague owns.
-- The check moves into the function, where the app layer cannot be gone round.
-- =============================================================================

revoke execute on function public.effective_grants(uuid) from authenticated;
revoke execute on function public.effective_grant(uuid, grant_scope, uuid, uuid) from authenticated;

revoke execute on function public.resolve_record_by_phone(text) from authenticated;
revoke execute on function public.resolve_records_by_phones(text[]) from authenticated;


create or replace function public.count_user_records(p_user uuid)
returns bigint
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
begin
  if not auth_is_admin() then
    -- Refuses rather than returning zero. This number is the input to a
    -- destructive decision (reassign-then-delete), so a wrong one is worse
    -- than an error.
    raise exception 'Admins only.' using errcode = '42501';
  end if;

  -- Body unchanged. Note it counts records the user is a TEAM MEMBER of, not
  -- ones they created — that is what the reassignment flow is about, and it
  -- was verified against the original before this function was replaced.
  return (
    select count(*)
      from records r
     where r.deleted_at is null
       and r.values -> 'team_members_assigned' @> to_jsonb(p_user::text)
  );
end;
$function$;
