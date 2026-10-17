-- =============================================================================
-- The Email module — the private bucket outgoing attachments are staged in.
--
-- Vercel caps a function's request body at 4.5 MB, and Outlook allows far
-- larger attachments. So the browser uploads straight to Storage through a
-- SIGNED upload URL that the server mints only after authorize() and the
-- mailbox checks; the send pipeline then streams the file to Microsoft in
-- chunks. Bytes never pass through a Vercel function body in either
-- direction.
--
-- No policy for `authenticated` at all: signed URLs carry their own
-- authority, and every other read or write is the service role. Objects are
-- swept 7 days after the send finishes or is abandoned.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('mail-outbox', 'mail-outbox', false, 157286400)   -- 150 MB, Exchange's ceiling
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;
