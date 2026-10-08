begin;

-- ════════════════════════════════════════════════════════════════════════
-- Who each MID is, for the merchant dashboard
-- ════════════════════════════════════════════════════════════════════════
--
-- Tab 1 of the module — `residuals.md` §12 item 1, "Merchant dashboard — not
-- built" — is the one screen of the original four that was never started. It
-- answers one question per merchant: where does this month stand for them.
--
-- Everything it needs about PROGRESS and MONEY already exists:
-- `residual_merchant_states` gives the rung and the reason, and
-- `residual_synopsis` gives net income under the suppression rule that §12
-- calls the sharpest argument in the module — a partial month's figure has the
-- wrong SIGN, not merely the wrong magnitude, so it is withheld rather than
-- labelled "partial". Neither of those rules is restated here. This function
-- adds only the part neither has: WHO the MID is.
--
-- ── NAME CONFLICTS ARE REPORTED, NOT PICKED ─────────────────────────────
-- A MID can carry more than one merchant name, and it is not hypothetical:
-- the August 2026 Mastersheet lists 30119900929 twice, as "House Of Tacos Llc"
-- and "House Of Tacos II", with different volume rates. Choosing one with
-- max() would make that invisible on the very screen built to show where a
-- merchant stands.
--
-- So the most frequent name is returned for the label AND every distinct name
-- comes back in `name_variants` whenever there is more than one. One name is
-- an empty array, which lets the caller treat "has variants" as the signal.
--
-- ── NO MONEY IN HERE ────────────────────────────────────────────────────
-- Deliberately. The dashboard's figures come from `residual_synopsis` so there
-- is exactly one implementation of when a total may be shown. A second query
-- that also summed `residual_lines` would be a second answer to that question,
-- and the two would eventually disagree.

create or replace function public.residual_merchant_directory(
  p_period_id uuid
)
returns table (
  mid            text,
  merchant_name  text,
  -- Every distinct name when the MID carries more than one, else empty.
  name_variants  text[],
  -- The CRM record this MID is linked to, if the link has been made.
  record_id      uuid,
  thread_match   text,
  line_count     bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to read the residual merchant directory.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.residual_periods p
     where p.id = p_period_id and p.deleted_at is null
  ) then
    raise exception 'No live residual period with id %.', p_period_id
      using errcode = 'P0002';
  end if;

  return query
    with per_name as (
      select l.mid                                as m,
             nullif(btrim(l.merchant_name), '')    as nm,
             count(*)                              as n
        from public.residual_lines l
       where l.period_id = p_period_id
         and l.deleted_at is null
       group by l.mid, nullif(btrim(l.merchant_name), '')
    ),
    totals as (
      -- `sum()` over bigint returns numeric, and the declared column is
      -- bigint — without the cast Postgres refuses the whole function with
      -- "structure of query does not match function result type".
      select m, sum(n)::bigint as lines
        from per_name
       group by m
    ),
    -- The most frequent non-null name, and the tie broken alphabetically so
    -- the label does not change between two identical reads.
    label as (
      select distinct on (m) m, nm
        from per_name
       where nm is not null
       order by m, n desc, nm
    ),
    variants as (
      select m, array_agg(distinct nm order by nm) as names
        from per_name
       where nm is not null
       group by m
      having count(distinct nm) > 1
    ),
    -- The link, taken from the lines themselves. One MID's lines all carry the
    -- same record_id — the linking RPCs set them together — so max() here is
    -- a reduction over equal values rather than a choice between different
    -- ones, unlike the name above.
    linked as (
      select l.mid as m,
             max(l.record_id::text)::uuid as rec,
             max(l.thread_match)          as tm
        from public.residual_lines l
       where l.period_id = p_period_id
         and l.deleted_at is null
       group by l.mid
    )
    select t.m,
           lb.nm,
           coalesce(v.names, '{}'::text[]),
           lk.rec,
           lk.tm,
           t.lines
      from totals t
      left join label    lb on lb.m = t.m
      left join variants v  on v.m  = t.m
      left join linked   lk on lk.m = t.m
     order by t.m;
end;
$$;

comment on function public.residual_merchant_directory(uuid) is
  'Who each MID in a period is: its label, every name variant when it carries more than one, the CRM record it is linked to, and how many lines it has. Deliberately carries NO money — the dashboard''s figures come from residual_synopsis so that the rule about when a partial month''s total may be shown has exactly one implementation.';

revoke all on function public.residual_merchant_directory(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_merchant_directory(uuid)
  to authenticated;

commit;
