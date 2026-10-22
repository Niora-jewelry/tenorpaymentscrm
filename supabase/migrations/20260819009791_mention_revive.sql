-- =============================================================================
-- @mentions: mentioning someone again revives a revoked alert
-- =============================================================================
-- An update is edited and a person's tag is removed: their notification is
-- revoked (soft; Realtime cannot deliver a usable DELETE). The author then
-- edits the update again and puts the tag back. The dedupe index on
-- (recipient_id, update_id) made the second insert a no-op under
-- `on conflict do nothing`, so the person was silently never told.
--
-- Found by the integration suite (mentions.integration.test.ts, "editing an
-- update notifies only the people added"). The same applies to case replies;
-- field mentions have no dedupe key and were unaffected.
--
-- A revived row is a fresh alert: unread, unopened, not yet emailed, new
-- timestamp and actor. Mutes still win.
-- =============================================================================

create or replace function public.mention_notify(
  p_recipients     uuid[],
  p_source_kind    text,
  p_record_id      uuid,
  p_update_id      uuid,
  p_case_id        uuid,
  p_case_reply_id  uuid,
  p_field_key      text,
  p_preview        text,
  p_note           text,
  p_current        text,
  p_previous       text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inserted int := 0;
  v_revived  int := 0;
begin
  if p_recipients is null or cardinality(p_recipients) = 0 then
    return 0;
  end if;

  if p_update_id is not null or p_case_reply_id is not null then
    update notifications n
       set revoked_at    = null,
           read_at       = null,
           opened_at     = null,
           email_sent_at = null,
           created_at    = now(),
           actor_id      = auth.uid(),
           body          = coalesce(p_preview, ''),
           preview       = p_preview
     where n.recipient_id = any (p_recipients)
       and n.recipient_id <> auth.uid()
       and n.revoked_at is not null
       and (   (p_update_id is not null and n.update_id = p_update_id)
            or (p_case_reply_id is not null and n.case_reply_id = p_case_reply_id))
       and not exists (select 1 from notification_mutes m
                        where m.user_id = n.recipient_id and m.record_id = p_record_id);
    get diagnostics v_revived = row_count;
  end if;

  insert into notifications
    (recipient_id, actor_id, body, record_id, source_kind,
     update_id, case_id, case_reply_id, field_key, preview, note, current_value, previous_value)
  select r, auth.uid(), coalesce(p_preview, ''), p_record_id, p_source_kind,
         p_update_id, p_case_id, p_case_reply_id, p_field_key, p_preview, p_note, p_current, p_previous
    from unnest(p_recipients) as r
   where r <> auth.uid()
     and not exists (select 1 from notification_mutes m where m.user_id = r and m.record_id = p_record_id)
  on conflict do nothing;
  get diagnostics v_inserted = row_count;

  return v_inserted + v_revived;
end;
$$;
