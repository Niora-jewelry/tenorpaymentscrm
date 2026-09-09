-- =============================================================================
-- Module 2 — Part 15: Storage bucket and RLS
--
-- SCHEMA-DECISIONS §11 designed this (one bucket, path-scoped, RLS on the
-- bucket not the file) but never actually created it — a gap caught while
-- building `lib/records/files.ts`, which needs somewhere real to upload to.
--
-- Path convention (the bucket is already "records", so the object NAME
-- itself does not repeat that prefix — SCHEMA-DECISIONS §11's illustrative
-- path included it as part of the string; here it is the bucket boundary):
--   {record_id}/application/{file_row_id}/{filename}
--   {record_id}/other/{file_row_id}/{filename}
--   {record_id}/statements/{yyyy-mm}/{filename}
--
-- storage.foldername(name)[1] pulls record_id straight out of the object
-- name — no join table mapping storage objects back to records is needed,
-- because the path IS the mapping. Private bucket: every read goes through
-- RLS, never a public URL.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('records', 'records', false, 25 * 1024 * 1024)
on conflict (id) do nothing;

create policy records_bucket_select on storage.objects for select
  to authenticated
  using (bucket_id = 'records' and can_see_record((storage.foldername(name))[1]::uuid));

create policy records_bucket_insert on storage.objects for insert
  to authenticated
  with check (bucket_id = 'records' and can_see_record((storage.foldername(name))[1]::uuid));

create policy records_bucket_update on storage.objects for update
  to authenticated
  using (bucket_id = 'records' and can_see_record((storage.foldername(name))[1]::uuid));

create policy records_bucket_delete on storage.objects for delete
  to authenticated
  using (bucket_id = 'records' and can_see_record((storage.foldername(name))[1]::uuid));
