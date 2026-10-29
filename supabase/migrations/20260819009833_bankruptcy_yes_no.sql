-- =============================================================================
-- Bankruptcy becomes Yes / No, like the merchant application.
--
-- The client, 28 Oct 2026: "Bankruptcy — change CRM to match pdf". The PDF
-- asks "Has the business or any of its principals ever filed bankruptcy?"
-- Yes / No, with an "If yes, provide more details" box (which goes into the
-- field's notes). The CRM held a multi-select: Business / Personal / Never.
--
--   Never              → No
--   Business, Personal → Yes, and the kind is kept as a note on the record
--                        (nothing is lost), with a history row for the change
--
-- Backed up first: backups/izzy-2026-10-29/bankruptcy-before-yes-no.json.
-- =============================================================================

do $$
declare
  v_field uuid := (select id from fields where key = 'bankruptcy');
  v_admin uuid := (select p.id from profiles p join roles r on r.id = p.role_id
                    where r.is_admin and p.deleted_at is null and p.status = 'active' order by p.created_at limit 1);
  r       record;
  v_new   text;
  v_kinds text;
begin
  if v_field is null then raise exception 'bankruptcy field not found'; end if;

  for r in
    select id, creator_user_id, values -> 'bankruptcy' as old
      from records
     where values ? 'bankruptcy' and jsonb_typeof(values -> 'bankruptcy') = 'array'
  loop
    v_kinds := (select string_agg(initcap(k), ' and ' order by k)
                  from jsonb_array_elements_text(r.old) k where k in ('business', 'personal'));
    v_new := case
               when v_kinds is not null then 'yes'
               when r.old ? 'never' then 'no'
               else null
             end;

    if v_new is null then
      update records set values = values - 'bankruptcy' where id = r.id;
    else
      update records set values = jsonb_set(values, '{bankruptcy}', to_jsonb(v_new)) where id = r.id;
    end if;

    insert into record_activity (record_id, actor_id, kind, field_key, summary, from_value, to_value, source)
    values (r.id, null, 'field', 'bankruptcy', 'Bankruptcy changed to Yes / No to match the application',
            r.old #>> '{}', v_new, 'Bankruptcy became Yes / No (client decision, 28 Oct 2026)');

    if v_kinds is not null then
      insert into notes (record_id, scope_kind, scope_id, author_id, body)
      values (r.id, 'field', 'bankruptcy', coalesce(r.creator_user_id, v_admin),
              'Before Bankruptcy became Yes / No (28 Oct 2026), this record said: ' || v_kinds || '.');
    end if;
  end loop;

  delete from field_choices where field_id = v_field;
  update fields
     set type = 'dropdown',
         notes_enabled = true,
         hint = 'Has the business or any of its principals ever filed bankruptcy? Details go in the notes.'
   where id = v_field;
  perform set_field_choices(v_field, null, '[{"key":"yes","value":"Yes"},{"key":"no","value":"No"}]'::jsonb);
end $$;
