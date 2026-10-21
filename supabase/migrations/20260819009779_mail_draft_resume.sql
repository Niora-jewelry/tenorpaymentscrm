-- =============================================================================
-- Email module P6b: picking a draft up again exactly as it was left.
--
-- A draft's body in Outlook is "the person's words + signature + Outlook's
-- quote", all in one HTML document. Loading that back into the editor would
-- flatten the signature and the quoted history into editable paragraphs.
-- So each autosave also records what the CRM itself wrote:
--
--   editor_html        the person's words alone (sanitised), as the editor had them
--   include_signature  whether the signature was on
--   change_key         the changeKey Outlook returned for that save
--
-- When the draft is opened again and Outlook's changeKey still matches,
-- nobody touched it in Outlook: the editor gets editor_html back, and the
-- signature and quote stay where they belong. If Outlook's changeKey moved
-- (edited in Outlook meanwhile), Outlook's body wins, as everywhere else.
--
-- Columns only: the table's RLS (forced; owner may select) is unchanged.
-- =============================================================================

alter table public.mail_drafts
  add column if not exists editor_html text not null default '' check (char_length(editor_html) <= 1000000),
  add column if not exists include_signature boolean not null default true,
  add column if not exists change_key text check (change_key is null or char_length(change_key) <= 200);
