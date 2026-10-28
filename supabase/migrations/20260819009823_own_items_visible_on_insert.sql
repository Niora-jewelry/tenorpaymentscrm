-- =============================================================================
-- Your own update, case, reply or tab note is visible to you — read from the
-- row itself, not looked up by id.
--
-- Migration 9815's *_visible_to(u, id) functions find the item by id. In an
-- INSERT … RETURNING (supabase-js `.insert().select()`, and any RPC that
-- returns what it wrote) the SELECT policy is checked against the new row,
-- but a STABLE function's snapshot does not contain it yet: the lookup finds
-- nothing and the author's own new item is refused ("new row violates
-- row-level security policy"). Adding a tab note failed this way.
--
-- The author short-circuit is the spec's own rule — Only mine = "items they
-- created, were @'d on, or were given" — so it widens nothing. Cases keep
-- their Hidden: an author whose Cases setting is Hidden still sees none.
-- =============================================================================

drop policy if exists updates_select on updates;
create policy updates_select on updates for select
  using (record_visible(record_id)
         and tab_visible(record_id, 'updates')
         and (field_key is null or record_field_grant(record_id, field_key::text) <> 'hidden')
         and (author_id = (select auth.uid()) or update_visible_to((select auth.uid()), id)));

drop policy if exists cases_select on cases;
create policy cases_select on cases for select
  using (record_visible(record_id)
         and tab_visible(record_id, 'cases')
         and ((issue_author = (select auth.uid()) and (select auth_perm('items.cases')) <> 'hidden')
              or case_visible_to((select auth.uid()), id)));

drop policy if exists case_replies_select on case_replies;
create policy case_replies_select on case_replies for select
  using (exists (select 1 from cases c
                  where c.id = case_replies.case_id and record_visible(c.record_id) and tab_visible(c.record_id, 'cases'))
         and ((author_id = (select auth.uid()) and (select auth_perm('items.cases')) <> 'hidden')
              or case_reply_visible_to((select auth.uid()), id)));

drop policy if exists notes_select on notes;
create policy notes_select on notes for select
  using (record_visible(record_id)
         and coalesce(tab_visible(record_id, note_scope_tab_key(scope_kind::text, scope_id)), true)
         and (scope_kind <> 'tab' or author_id = (select auth.uid()) or note_visible_to((select auth.uid()), id)));
