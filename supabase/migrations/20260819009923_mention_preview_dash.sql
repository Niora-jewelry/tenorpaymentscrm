-- Migration 9920 rewrote mention_field with its dash garbled by an encoding slip, so a
-- field mention's preview read "EIN â€” Please verify". No stored row carries it yet.

CREATE OR REPLACE FUNCTION public.mention_field(p_record_id uuid, p_field_key text, p_mentioned_user_ids uuid[], p_note text, p_include_previous boolean)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_label     text;
  v_sensitive boolean;
  v_valid     uuid[];
  v_current   text;
  v_previous  text;
  v_update_id uuid;
  v_note      text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not record_writable(p_record_id) then
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

  insert into updates (record_id, parent_id, author_id, body, field_key, activity)
  values (p_record_id, null, auth.uid(), coalesce(v_note, 'Mentioned on ' || v_label), p_field_key, false)
  returning id into v_update_id;

  insert into update_mentions (update_id, user_id)
  select v_update_id, m from unnest(v_valid) as m;

  return mention_notify(v_valid, 'mention_field', p_record_id, v_update_id, null, null, p_field_key,
                        mention_preview(v_label || coalesce(' — ' || v_note, '')),
                        v_note, v_current, v_previous);
end;
$function$
;
