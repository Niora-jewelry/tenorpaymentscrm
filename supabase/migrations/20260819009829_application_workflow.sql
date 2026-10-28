-- =============================================================================
-- Prepopulated Application — the workflow, one transaction per step.
--
--   application_log            "Application APP-000123 sent / opened / voided …"
--                              in the record's activity (kind 'application').
--   application_record_return  answers came back (online or PDF): store every
--                              difference, write the empty CRM fields with
--                              their history and source, move the status —
--                              all or nothing.
--   application_decide         the review screen's Accept / Keep: values,
--                              history, decisions and "Reviewed" together.
--
-- All three are for the server only (service role). The app checks who may do
-- what before calling — the record, the Applications tab, each field's grant.
-- =============================================================================

alter type activity_kind add value if not exists 'application';

create or replace function application_log(p_application uuid, p_actor uuid, p_summary text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into record_activity (record_id, actor_id, kind, summary, source)
  select a.record_id, p_actor, 'application', p_summary, 'Application ' || application_label(a.number)
    from applications a where a.id = p_application;
end;
$$;
revoke execute on function application_log(uuid, uuid, text) from public, anon, authenticated;

-- The writer from 9827, now also settling the "kept" rows and marking the
-- application Reviewed once nothing is left to decide.
drop function if exists application_write_values(uuid, jsonb, jsonb, uuid[], text, uuid, text, timestamptz);

create or replace function application_write_values(
  p_application uuid,
  p_values      jsonb,
  p_notes       jsonb,
  p_change_ids  uuid[],
  p_status      text,
  p_kept_ids    uuid[],
  p_actor       uuid,
  p_via         text,
  p_expected_updated_at timestamptz
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a        record;
  v_old    jsonb;
  v_at     timestamptz;
  v_source text;
  v_bad    text;
  n        jsonb;
begin
  select ap.id, ap.number, ap.record_id, ap.sent_by, ap.status into a from applications ap where ap.id = p_application for update;
  if a.id is null then raise exception 'That application no longer exists.'; end if;
  if a.status = 'voided' then raise exception 'This application was voided.'; end if;
  if p_status not in ('applied', 'accepted') then raise exception 'bad status'; end if;
  if p_via not in ('online', 'pdf', 'manual') then raise exception 'bad source'; end if;
  v_source := 'Application ' || application_label(a.number) || ', ' || case p_via when 'manual' then 'entered from PDF' else p_via end;

  p_values := coalesce(p_values, '{}'::jsonb);
  select k into v_bad from jsonb_object_keys(p_values) k
   where k = 'deal_name' or is_pipeline_status_key(k)
      or not exists (select 1 from fields f where f.key = k and f.archived_at is null and f.type not in ('auto', 'grid'))
   limit 1;
  if v_bad is not null then raise exception 'An application cannot write %.', v_bad; end if;

  select r.values into v_old from records r where r.id = a.record_id and r.deleted_at is null for update;
  if v_old is null then raise exception 'not found'; end if;

  if p_values <> '{}'::jsonb then
    update records
       set values = values || p_values, updated_at = now()
     where id = a.record_id
       and (p_expected_updated_at is null or records.updated_at = p_expected_updated_at)
    returning updated_at into v_at;
    if v_at is null then
      raise exception 'The record changed while this was being applied. Reload and try again.' using errcode = '40001';
    end if;

    insert into record_activity (record_id, actor_id, kind, field_key, summary, from_value, to_value, source)
    select a.record_id, p_actor, 'field', k,
           coalesce((select f.label from fields f where f.key = k), k) || ' set from ' || application_label(a.number),
           v_old -> k #>> '{}', p_values -> k #>> '{}', v_source
      from jsonb_object_keys(p_values) k
     where (v_old -> k) is distinct from (p_values -> k);
  else
    select updated_at into v_at from records where id = a.record_id;
  end if;

  for n in select * from jsonb_array_elements(coalesce(p_notes, '[]'::jsonb)) loop
    insert into notes (record_id, scope_kind, scope_id, author_id, body)
    values (a.record_id, 'field', n ->> 'field_key',
            coalesce(p_actor, a.sent_by, (select creator_user_id from records where id = a.record_id)),
            (n ->> 'body') || chr(10) || '— ' || v_source);
  end loop;

  if cardinality(coalesce(p_change_ids, '{}')) > 0 then
    update application_changes
       set status = p_status, decided_by = p_actor, decided_at = now()
     where application_id = p_application and id = any (p_change_ids) and status = case p_status when 'applied' then 'applied' else 'pending' end;
  end if;
  if cardinality(coalesce(p_kept_ids, '{}')) > 0 then
    update application_changes
       set status = 'kept', decided_by = p_actor, decided_at = now()
     where application_id = p_application and id = any (p_kept_ids) and status = 'pending';
  end if;

  -- Nothing left to decide → Reviewed (spec: "once nothing is left to decide").
  if a.status in ('submitted', 'pdf_uploaded')
     and not exists (select 1 from application_changes c where c.application_id = p_application and c.status = 'pending') then
    update applications set status = 'reviewed', reviewed_at = now() where id = p_application;
    perform application_log(p_application, p_actor, application_label(a.number) || ' reviewed — every returned answer is settled');
  end if;

  return v_at;
end;
$$;
revoke execute on function application_write_values(uuid, jsonb, jsonb, uuid[], text, uuid[], uuid, text, timestamptz) from public, anon, authenticated;

-- ── answers came back ───────────────────────────────────────────────────────
-- p_changes: [{ target, field_key, question, crm_value, answer_value,
--               answer_display, crm_display, status: 'applied'|'pending' }]
-- p_values / p_notes: the 'applied' ones, already merged (repeat groups whole).
create or replace function application_record_return(
  p_application uuid,
  p_changes     jsonb,
  p_values      jsonb,
  p_notes       jsonb,
  p_via         text,
  p_actor       uuid,
  p_expected_updated_at timestamptz
)
returns table (applied int, pending int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a         record;
  v_applied uuid[];
  v_pending int;
begin
  select ap.id, ap.number, ap.record_id, ap.status into a from applications ap where ap.id = p_application for update;
  if a.id is null then raise exception 'That application no longer exists.'; end if;
  if a.status = 'voided' then raise exception 'This application was voided.'; end if;
  if p_via not in ('online', 'pdf', 'manual') then raise exception 'bad source'; end if;

  -- A second return (a re-upload, or a manual entry after an unreadable PDF)
  -- replaces what was still waiting; decided rows stay as history.
  delete from application_changes where application_id = p_application and status = 'pending';

  with ins as (
    insert into application_changes (application_id, record_id, target, field_key, question, crm_value,
                                     answer_value, answer_display, crm_display, via, status)
    select p_application, a.record_id, c ->> 'target', c ->> 'field_key', c ->> 'question', c -> 'crm_value',
           c -> 'answer_value', c ->> 'answer_display', c ->> 'crm_display', p_via, c ->> 'status'
      from jsonb_array_elements(coalesce(p_changes, '[]'::jsonb)) c
     where c ->> 'status' in ('applied', 'pending')
    returning id, status
  )
  select array_agg(id) filter (where status = 'applied'), count(*) filter (where status = 'pending')
    into v_applied, v_pending
    from ins;

  update applications
     set status = case p_via when 'online' then 'submitted' else 'pdf_uploaded' end::application_status,
         submitted_at = coalesce(submitted_at, now()),
         returned_via = case p_via when 'online' then 'online' else 'pdf' end
   where id = p_application;

  perform application_log(
    p_application, p_actor,
    application_label(a.number) || case p_via when 'online' then ' submitted online' when 'pdf' then ' returned as a PDF' else ' entered from the returned PDF' end
      || ' — ' || coalesce(cardinality(v_applied), 0) || ' filled automatically, ' || coalesce(v_pending, 0) || ' to review');

  -- Values + history for the empty CRM fields; also moves to Reviewed when
  -- nothing is pending.
  perform application_write_values(p_application, p_values, p_notes, v_applied, 'applied', null, p_actor, p_via, p_expected_updated_at);

  return query select coalesce(cardinality(v_applied), 0), coalesce(v_pending, 0);
end;
$$;
revoke execute on function application_record_return(uuid, jsonb, jsonb, jsonb, text, uuid, timestamptz) from public, anon, authenticated;
