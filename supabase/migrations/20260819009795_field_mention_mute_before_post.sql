-- =============================================================================
-- A field mention to people who all muted the record posts nothing
-- =============================================================================
-- 9794 made `mention_field` write a feed entry (plus `update_mentions` rows,
-- the "was notified" line) before asking `mention_notify`, which is where a
-- mute is honoured. So a mention aimed only at someone who muted the record
-- left an entry saying "@X was notified" while X was, correctly, not.
--
-- Found by the browser suite. Mutes are now applied to the recipient set
-- before anything is written: the entry and its chips name only people who
-- were actually alerted, and when that leaves nobody, nothing is posted and
-- the sender's box reports "Nobody picked can see this field any more"
-- (its existing wording for a zero result).
-- =============================================================================

create or replace function public.mention_field(
  p_record_id           uuid,
  p_field_key           text,
  p_mentioned_user_ids  uuid[],
  p_note                text,
  p_include_previous    boolean
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_label     text;
  v_sensitive boolean;
  v_valid     uuid[];
  v_current   text;
  v_previous  text;
  v_update_id uuid;
  v_note      text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;
  select label, sensitive into v_label, v_sensitive
    from fields where key = p_field_key and archived_at is null;
  if v_label is null then
    raise exception 'not found';
  end if;
  if record_field_grant(p_record_id, p_field_key) = 'hidden' then
    raise exception 'not found';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'The note can be up to 500 characters.' using errcode = '22023';
  end if;

  -- Eligible AND not muted: the people who will actually be alerted.
  select array_agg(distinct m) into v_valid
    from unnest(coalesce(p_mentioned_user_ids, '{}')) as m
   where m = any (mention_candidates(p_record_id, 'field:' || p_field_key))
     and not exists (select 1 from notification_mutes mu
                      where mu.user_id = m and mu.record_id = p_record_id);
  if v_valid is null then
    return 0;
  end if;

  if not v_sensitive then
    select values #>> array[p_field_key] into v_current from records where id = p_record_id;
    if coalesce(p_include_previous, false) then
      -- The sender's own change in the last ten minutes, else nothing.
      select from_value into v_previous
        from record_activity
       where record_id = p_record_id
         and kind = 'field'
         and field_key = p_field_key
         and actor_id = auth.uid()
         and at > now() - interval '10 minutes'
       order by at desc
       limit 1;
    end if;
  end if;

  insert into updates (record_id, parent_id, author_id, body, field_key)
  values (p_record_id, null, auth.uid(), coalesce(v_note, 'Mentioned on ' || v_label), p_field_key)
  returning id into v_update_id;

  insert into update_mentions (update_id, user_id)
  select v_update_id, m from unnest(v_valid) as m;

  return mention_notify(v_valid, 'mention_field', p_record_id, v_update_id, null, null, p_field_key,
                        mention_preview(v_label || coalesce(' — ' || v_note, '')),
                        v_note, v_current, v_previous);
end;
$$;
