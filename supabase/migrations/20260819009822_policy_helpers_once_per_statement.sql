-- =============================================================================
-- Per-statement, not per-row: the permission helpers in RLS policies.
--
-- Since migration 9813, mail_visible_mailbox_ids() resolves the caller's Email
-- setting through auth_perm(). Written as `mailbox_id = any (fn())` it was
-- evaluated for every row scanned: mail_list over 10k messages went from
-- under 150 ms to ~2 s (mail scale test). Wrapping each call in `(select ...)`
-- makes it an initplan, evaluated once per statement. The functions take no
-- row input, so the answer is identical. (The array cast keeps `= any (...)`
-- an array comparison rather than the subquery form.)
--
-- Same treatment for auth_perm('<key>') with a constant key and for
-- my_mail_identities(). Generated from the live definitions; nothing else changes.
-- =============================================================================

alter policy mail_attachments_select on public.mail_attachments
  using ((mailbox_id = ANY ((select mail_visible_mailbox_ids())::uuid[])));

alter policy mail_connections_select on public.mail_connections
  using (((disconnected_at IS NULL) AND ((user_id = auth.uid()) OR (((select auth_perm('email.scope'::text)) = 'all'::text) AND (mailbox_id = ANY ((select mail_visible_mailbox_ids())::uuid[]))))));

alter policy mail_contacts_select on public.mail_contacts
  using (((deleted_at IS NULL) AND (mailbox_id = ANY ((select mail_visible_mailbox_ids())::uuid[]))));

alter policy mail_folders_select on public.mail_folders
  using (((deleted_at IS NULL) AND (mailbox_id = ANY ((select mail_visible_mailbox_ids())::uuid[]))));

alter policy mail_mailboxes_select on public.mail_mailboxes
  using (((deleted_at IS NULL) AND (id = ANY ((select mail_visible_mailbox_ids())::uuid[]))));

alter policy mail_messages_select on public.mail_messages
  using (((deleted_at IS NULL) AND (mailbox_id = ANY ((select mail_visible_mailbox_ids())::uuid[]))));

alter policy mail_pins_select on public.mail_pins
  using ((mailbox_id = ANY ((select mail_visible_mailbox_ids())::uuid[])));

alter policy mail_rules_select on public.mail_rules
  using (((deleted_at IS NULL) AND (mailbox_id = ANY ((select mail_visible_mailbox_ids())::uuid[]))));

alter policy mail_signatures_select on public.mail_signatures
  using ((mailbox_id = ANY ((select mail_visible_mailbox_ids())::uuid[])));

alter policy messages_select on public.messages
  using ((record_visible(record_id) AND tab_visible(record_id, 'communication'::text) AND (((select auth_perm('communication.scope'::text)) = 'org'::text) OR (lower((from_identity)::text) = ANY ((select my_mail_identities())::text[])) OR (lower((to_identity)::text) = ANY ((select my_mail_identities())::text[])))));

alter policy notifications_select_own on public.notifications
  using (((recipient_id = auth.uid()) OR (((select auth_perm('notifications.scope'::text)) = 'all'::text) AND ((record_id IS NULL) OR record_visible(record_id)))));

alter policy permission_audit_log_select on public.permission_audit_log
  using ((auth_is_admin() OR ((select auth_perm('admin.permissions'::text)) = 'full'::text) OR ((select auth_perm('admin.users'::text)) = 'full'::text)));

alter policy phone_calls_select on public.phone_calls
  using (((deleted_at IS NULL) AND (((select auth_perm('phone.scope'::text)) = 'all'::text) OR (owner_id = auth.uid()) OR ((record_id IS NOT NULL) AND record_visible(record_id) AND ((select auth_perm('communication.scope'::text)) = 'org'::text)))));

alter policy phone_messages_select on public.phone_messages
  using (((deleted_at IS NULL) AND (((select auth_perm('phone.scope'::text)) = 'all'::text) OR (owner_id = auth.uid()) OR ((record_id IS NOT NULL) AND record_visible(record_id) AND ((select auth_perm('communication.scope'::text)) = 'org'::text)))));

alter policy phone_recordings_select on public.phone_recordings
  using (((deleted_at IS NULL) AND (EXISTS ( SELECT 1
   FROM phone_calls c
  WHERE ((c.id = phone_recordings.call_id) AND (c.deleted_at IS NULL) AND (((select auth_perm('phone.scope'::text)) = 'all'::text) OR (c.owner_id = auth.uid()) OR ((c.record_id IS NOT NULL) AND record_visible(c.record_id) AND ((select auth_perm('communication.scope'::text)) = 'org'::text))))))));

alter policy records_insert on public.records
  with check (((creator_kind = 'user'::creator_kind) AND (creator_user_id = auth.uid()) AND (auth_is_admin() OR ((select auth_perm('action.create'::text)) = 'yes'::text))));

alter policy phone_recordings_bucket_select on storage.objects
  using (((bucket_id = 'phone-recordings'::text) AND (EXISTS ( SELECT 1
   FROM phone_calls c
  WHERE ((c.id = ((storage.foldername(objects.name))[2])::uuid) AND (c.deleted_at IS NULL) AND (((select auth_perm('phone.scope'::text)) = 'all'::text) OR (c.owner_id = auth.uid()) OR ((c.record_id IS NOT NULL) AND record_visible(c.record_id) AND ((select auth_perm('communication.scope'::text)) = 'org'::text))))))));
