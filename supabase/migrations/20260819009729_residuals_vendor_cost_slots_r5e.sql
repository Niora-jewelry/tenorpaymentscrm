-- Ported from Daniel Weissman's residuals branch, file
-- `20260906120000_residuals_vendor_cost_slots_r5e.sql`.
--
-- Mechanical changes only: their role vocabulary
-- (auth_role() in ('admin','super_admin')) becomes our auth_is_admin(),
-- and their service-role test (auth_role() is null) becomes
-- auth.uid() is null. Nothing else in this file was altered.
--
-- The reasoning in the comments below is his and is kept verbatim:
-- it explains why the schema is shaped this way, and rewriting it in
-- my own words would lose the parts I have not yet had to understand.
-- ---------------------------------------------------------------------

-- ============================================================
-- Residuals R5e — connecting a vendor card to a merchant's columns
-- ============================================================
--
-- THE REPORT: setting Accept.Blue as the gateway provider changed nothing.
--
-- THE DIAGNOSIS, and it is not where the prefill was built.
--
-- residual_merchant_vendor_costs has ZERO rows and has never been used. The
-- edit landed on residual_merchant_rates: MID 201100207241,
-- gateway_provider_mav = 'accept.Blue', updated 2026-09-10, gateway_monthly_mav
-- still NULL. That field is FREE TEXT on the merchant RATE editor, which has no
-- card lookup at all — so the immediate cause is (a): the provider input never
-- resolves to a schedule.
--
-- AND THAT SCREEN IS THE RIGHT ONE. The engine reads gateway_monthly_mav (rule
-- "Accept Blue Monthly") and terminal_monthly_mav (rule "iPOS Spin Fee") from
-- residual_merchant_rates. NO term reads residual_merchant_vendor_costs, and
-- the residual_formula_terms_merchant_ref_known CHECK forbids one from trying.
-- So the prefill was built on the surface that feeds nothing, and the surface
-- that feeds the calculation had none.
--
-- (c) IS ALSO REAL, AND IS THE DESIGN GAP. The card's items are named per
-- VENDOR (vendor_monthly_fee, vendor_auth_fee) while the merchant's columns are
-- named per ROLE (gateway_monthly_fee, gateway_auth_fee). Nothing connected
-- them except a hardcoded map in one React file — invisible to SQL, and
-- unavailable to the screen that actually needed it.
--
-- ============================================================
-- HOW THE MAPPING IS EXPRESSED, AND WHY NOT A MAPPING TABLE
-- ============================================================
--
-- The three candidates were a column on residual_fee_items, a mapping table,
-- and convention over fee_item_key.
--
-- The objection to a COLUMN looks fatal at first: the same item is on several
-- cards, so a single global role cannot be right — Accept.Blue's monthly fee is
-- a GATEWAY monthly, Richard's is not.
--
-- It dissolves once the target column is decomposed. Every vendor-cost column
-- is ROLE _ SLOT:
--
--   gateway_monthly_fee   = gateway  + monthly_fee
--   gateway_auth_fee      = gateway  + auth_fee
--   terminal_transaction_fee = terminal + transaction_fee
--   rewards_volume_cost   = rewards  + volume_cost
--
-- The ROLE is not a property of the vendor at all — it is chosen by the
-- MERCHANT, by which provider field they put the vendor in. What the fee item
-- contributes is only the SLOT, and the slot IS global: vendor_monthly_fee is a
-- monthly fee on every card it appears on.
--
-- So: role (from the merchant row) x slot (from the fee item) = the column.
-- A mapping table keyed by (vendor, item) would store that product redundantly
-- and let the two disagree. A column stores the half that is actually intrinsic.
--
-- CONVENTION OVER fee_item_key was rejected for the reason it usually is: it
-- makes a rename a silent behaviour change, and it cannot express "this item
-- fills no slot" other than by failing to match a pattern, which is
-- indistinguishable from a typo.
--
-- ITEMS THAT FILL NO SLOT ARE THE NORMAL CASE, NOT AN ERROR. Accept.Blue's
-- payment page and card-updater-monthly fill none of the four roles; so do all
-- five of Paya's. vendor_cost_slot is NULL for them, they prefill nothing, and
-- the screen SAYS SO rather than dropping them silently — a card whose items
-- mostly vanish without explanation is how somebody concludes the feature is
-- broken.
--
-- ============================================================
-- WHAT A PROVIDER IS
-- ============================================================
--
-- FREE TEXT, RESOLVED BY NAME — not a foreign key, and that is deliberate.
--
-- The loaded data already holds UsaEpay, IposPays and Valor, none of which has
-- a rate card. Making gateway_provider_mav a reference to a schedule would make
-- those three merchants unrepresentable, and a merchant may legitimately use a
-- vendor whose card nobody has transcribed.
--
-- So the text stays authoritative and the CARD is looked up from it, by a
-- normalization that is written down once here rather than guessed at per
-- caller: upper-case, and every run of non-alphanumerics becomes a single
-- underscore. 'accept.Blue' and 'Accept Blue' both resolve to ACCEPT_BLUE;
-- 'UsaEpay' resolves to USAEPAY and finds nothing, which is a real and
-- reportable answer rather than an error.
--
-- THE COST, STATED: the link is by name, so renaming a schedule silently
-- unlinks every merchant row that named it. That is the price of letting a
-- merchant use a vendor with no card, and the screen makes it visible by saying
-- when a typed provider resolves to no card.
--
-- Idempotent throughout.

begin;

-- ============================================================
-- 1. The slot a fee item fills
-- ============================================================
alter table public.residual_fee_items
  add column if not exists vendor_cost_slot text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'residual_fee_items_vendor_cost_slot_check'
       and conrelid = 'public.residual_fee_items'::regclass
  ) then
    alter table public.residual_fee_items
      add constraint residual_fee_items_vendor_cost_slot_check
      check (vendor_cost_slot is null or vendor_cost_slot in (
        'monthly_fee', 'auth_fee', 'per_update', 'transaction_fee', 'volume_cost'));
  end if;
end$$;

comment on column public.residual_fee_items.vendor_cost_slot is
  'Which vendor-cost SLOT this item fills, or NULL for the common case of none. The merchant chooses the ROLE by which provider field they put the vendor in; role _ slot is the target column (gateway + monthly_fee = gateway_monthly_fee). The slot is intrinsic to the item — a monthly fee is a monthly fee on every card — which is why this is a column here rather than a (vendor, item) mapping table that would store the product redundantly and let the halves disagree.';

update public.residual_fee_items f
   set vendor_cost_slot = v.slot
  from (values
    ('vendor_monthly_fee',             'monthly_fee'),
    ('vendor_auth_fee',                'auth_fee'),
    ('vendor_card_updater_per_update', 'per_update'),
    ('vendor_transaction_fee',         'transaction_fee'),
    ('vendor_volume_fee',              'volume_cost')
  ) as v(key, slot)
 where f.fee_item_key = v.key
   and f.vendor_cost_slot is distinct from v.slot;

-- ============================================================
-- 2. Free text -> schedule key
-- ============================================================
create or replace function public.residual_vendor_provider_key(p_provider text)
returns text
language sql
immutable
as $$
  select nullif(
           btrim(
             regexp_replace(upper(btrim(coalesce(p_provider, ''))), '[^A-Z0-9]+', '_', 'g'),
             '_'),
           '');
$$;

comment on function public.residual_vendor_provider_key(text) is
  'Normalizes a free-text provider name to a residual_buy_rate_schedules.processor key: upper-case, runs of non-alphanumerics collapsed to one underscore, edges trimmed. ''accept.Blue'' and ''Accept Blue'' both give ACCEPT_BLUE. IMMUTABLE so it can be indexed if the merchant count ever makes that worth doing.';

revoke all on function public.residual_vendor_provider_key(text)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_vendor_provider_key(text)
  to authenticated;

-- ============================================================
-- 3. The card a provider name resolves to, slotted
-- ============================================================
-- Returns one row per item on the resolved card, whether or not it fills a
-- slot — the caller needs the unslotted ones to be able to SAY that they exist
-- and prefill nothing.
create or replace function public.residual_vendor_card_lookup(
  p_provider text,
  p_month    date
)
returns table (
  matched_processor text,
  fee_item_key      text,
  fee_item_label    text,
  vendor_cost_slot  text,
  rate              numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_key text := public.residual_vendor_provider_key(p_provider);
begin
  if public.auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to read vendor rate cards.'
      using errcode = '42501';
  end if;

  if v_key is null then
    return;
  end if;

  -- Zero rows means the name resolved to no card in force for that month —
  -- UsaEpay, IposPays and Valor all do today. That is a real answer.
  return query
  select s.processor, b.fee_item_key, fi.label, fi.vendor_cost_slot, b.rate
    from public.residual_buy_rate_schedules s
    join public.residual_buy_rate_tiers t
      on t.schedule_id = s.id and t.deleted_at is null
    join public.residual_risk_tiers rt
      on rt.tier_key = t.risk_tier and rt.deleted_at is null and rt.is_risk_tier = false
    join public.residual_buy_rates b
      on b.schedule_id = s.id and b.risk_tier = t.risk_tier and b.deleted_at is null
    join public.residual_fee_items fi
      on fi.fee_item_key = b.fee_item_key and fi.deleted_at is null
   where s.deleted_at is null
     and s.processor = v_key
     and s.effective_from <= p_month
     and (s.effective_to is null or s.effective_to > p_month)
   order by fi.sort_order;
end;
$$;

comment on function public.residual_vendor_card_lookup(text, date) is
  'The vendor rate card a free-text provider name resolves to for a month, one row per item WITH its vendor_cost_slot — including items that fill no slot, so a caller can report that they exist and prefill nothing. Zero rows means the name matches no card in force, which is the honest state for a vendor nobody has transcribed. Restricted to non-risk (vendor) schedules: a merchant''s gateway is never Maverick.';

revoke all on function public.residual_vendor_card_lookup(text, date)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_vendor_card_lookup(text, date)
  to authenticated;

-- ============================================================
-- 4. The rate editor learns about vendor cards
-- ============================================================
-- Adds two keys and changes nothing else: 'vendor_providers' (every provider
-- name with a card in force, so the field can suggest without constraining) and
-- 'vendor' (what the merchant's own typed gateway and terminal names resolve
-- to, slotted, plus the items that fill no slot).
--
-- The MONTH used for the lookup is the chosen period's statement month, so the
-- card compared against is the one that was in force for the month being
-- reconciled rather than whatever is current.
create or replace function public.residual_merchant_rate_editor(
  p_mid       text,
  p_period_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_mid      text := regexp_replace(coalesce(p_mid, ''), '[^0-9]', '', 'g');
  v_period   record;
  v_standing public.residual_merchant_rates%rowtype;
  v_locked   boolean := false;
  v_versions int := 0;
  v_lines    int := 0;
  v_merchfail jsonb;
  v_fields   jsonb;
  v_month    date;
  v_vendor   jsonb := '{}'::jsonb;
begin
  if public.auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to read merchant rates.'
      using errcode = '42501';
  end if;

  if v_mid = '' then
    raise exception 'residual_merchant_rate_editor: p_mid must contain digits.'
      using errcode = '22004';
  end if;

  select p.id, p.statement_month, p.status, p.calculation_version
    into v_period
    from public.residual_periods p
   where p.deleted_at is null
     and (p_period_id is null or p.id = p_period_id)
   order by p.statement_month desc
   limit 1;

  select * into v_standing
    from public.residual_merchant_rates r
   where r.mid = v_mid and r.deleted_at is null and r.effective_to is null;

  if v_standing.id is not null then
    v_locked := public.residual_merchant_rate_is_locked(
      v_standing.mid, v_standing.effective_from, v_standing.effective_to);
  end if;

  select count(*)::int into v_versions
    from public.residual_merchant_rates r
   where r.mid = v_mid and r.deleted_at is null;

  if v_period.id is not null then
    select count(*)::int into v_lines
      from public.residual_lines l
     where l.period_id = v_period.id and l.deleted_at is null
       and regexp_replace(l.mid, '[^0-9]', '', 'g') = v_mid;

    select to_jsonb(f) - 'id' - 'created_by_id' into v_merchfail
      from public.residual_calc_failures f
     where f.period_id = v_period.id and f.mid = v_mid and f.scope = 'merchant'
     limit 1;

    select jsonb_object_agg(g.rate_ref, g.obj) into v_fields
      from (
        select f.rate_ref,
               jsonb_build_object(
                 'n',           count(*)::int,
                 'reason_code', min(f.reason_code),
                 'detail',      min(f.detail),
                 'fee_items',   jsonb_agg(distinct f.fee_item_name)
               ) as obj
          from public.residual_calc_failures f
         where f.period_id = v_period.id
           and f.mid = v_mid
           and f.rate_ref is not null
           and f.reason_code = 'missing_merchant_rate'
         group by f.rate_ref
      ) g;
  end if;

  -- ---- the vendor cards this merchant's typed providers resolve to ----
  v_month := coalesce(v_period.statement_month, date_trunc('month', current_date)::date);

  if v_standing.id is not null then
    select jsonb_object_agg(role, obj) into v_vendor
      from (
        select r.role,
               jsonb_build_object(
                 'typed',    r.typed,
                 'resolved', public.residual_vendor_provider_key(r.typed),
                 'matched',  (select max(c.matched_processor)
                                from public.residual_vendor_card_lookup(r.typed, v_month) c),
                 -- slot -> rate, only for items that fill one AND are priced.
                 'slots',    coalesce((
                                select jsonb_object_agg(c.vendor_cost_slot, c.rate)
                                  from public.residual_vendor_card_lookup(r.typed, v_month) c
                                 where c.vendor_cost_slot is not null and c.rate is not null), '{}'::jsonb),
                 -- the rest, named, so the screen can say they exist.
                 'unslotted', coalesce((
                                select jsonb_agg(c.fee_item_label order by c.fee_item_label)
                                  from public.residual_vendor_card_lookup(r.typed, v_month) c
                                 where c.vendor_cost_slot is null), '[]'::jsonb)
               ) as obj
          from (values
                 ('gateway',  v_standing.gateway_provider_mav),
                 ('terminal', v_standing.terminal_provider_mav)
               ) as r(role, typed)
         where r.typed is not null
      ) r;
  end if;

  return jsonb_build_object(
    'mid', v_mid,
    'period', case when v_period.id is null then null else jsonb_build_object(
        'id', v_period.id,
        'statement_month', to_char(v_period.statement_month, 'YYYY-MM-DD'),
        'status', v_period.status,
        'calculation_version', v_period.calculation_version) end,
    'line_count', v_lines,
    'version_count', v_versions,
    'standing', case when v_standing.id is null then null
                     else (to_jsonb(v_standing)
                           - 'created_by_id' - 'updated_by_id'
                           - 'deleted_at' - 'deleted_by_id') end,
    'is_locked', v_locked,
    'merchant_failure', v_merchfail,
    'field_failures', coalesce(v_fields, '{}'::jsonb),
    'vendor', coalesce(v_vendor, '{}'::jsonb),
    -- Every provider with a card in force, for suggestion only. The field stays
    -- free text: UsaEpay, IposPays and Valor have no card and must remain
    -- typeable.
    'vendor_providers', coalesce((
      select jsonb_agg(s.processor order by s.processor)
        from public.residual_buy_rate_schedules s
        join public.residual_buy_rate_tiers t
          on t.schedule_id = s.id and t.deleted_at is null
        join public.residual_risk_tiers rt
          on rt.tier_key = t.risk_tier and rt.deleted_at is null and rt.is_risk_tier = false
       where s.deleted_at is null
         and s.effective_from <= v_month
         and (s.effective_to is null or s.effective_to > v_month)), '[]'::jsonb)
  );
end;
$$;

comment on function public.residual_merchant_rate_editor(text, uuid) is
  'Everything the per-merchant rate editor needs in one call: the standing rate version, whether a computed period locks it, the version count, the last run''s merchant- and field-scoped failures keyed by rate_ref, and — new in R5e — what the merchant''s typed gateway and terminal provider names resolve to on the vendor rate cards in force for the period''s month, as slot -> rate plus the card items that fill no slot. The provider fields stay free text: several loaded merchants use vendors nobody has transcribed a card for.';

revoke all on function public.residual_merchant_rate_editor(text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_merchant_rate_editor(text, uuid)
  to authenticated;

-- ============================================================
-- 5. Prove the resolution and the slots
-- ============================================================
do $$
declare v_slots int; v_key text;
begin
  select count(*) into v_slots
    from public.residual_fee_items
   where deleted_at is null and vendor_cost_slot is not null;
  if v_slots <> 5 then
    raise exception 'Expected 5 slotted fee items, found %.', v_slots;
  end if;

  v_key := public.residual_vendor_provider_key('accept.Blue');
  if v_key <> 'ACCEPT_BLUE' then
    raise exception 'accept.Blue normalized to %, expected ACCEPT_BLUE.', v_key;
  end if;
  if public.residual_vendor_provider_key('Accept Blue') <> 'ACCEPT_BLUE' then
    raise exception 'Accept Blue did not normalize to ACCEPT_BLUE.';
  end if;
  if public.residual_vendor_provider_key('   ') is not null then
    raise exception 'Blank provider should normalize to NULL.';
  end if;

  raise notice 'Slots seeded; accept.Blue and Accept Blue both resolve to ACCEPT_BLUE.';
end$$;

commit;
