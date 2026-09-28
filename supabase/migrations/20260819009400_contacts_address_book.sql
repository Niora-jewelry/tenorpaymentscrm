-- ============================================================================
-- The dialer's address book.
--
-- Client note: "Contacts - Ability to add, edit, remove contacts", and
-- "Call recordings, call history, and texts should sync with contact".
--
-- ── WHY NOT A TABLE CALLED `contacts` ───────────────────────────────────────
-- `contacts` is already a MODULE (a row in `modules`, slug 'contacts'), and
-- CLAUDE.md binds that word: using it loosely "in code, UI copy, or a database
-- column is a defect". A table of that name would mean two different things
-- called Contacts in one system, which is exactly the confusion the vocabulary
-- section exists to prevent. These are `phone_contacts` throughout — the
-- dialer's own address book, a different thing from the Contacts module.
--
-- ── THE CLIENT'S RULE, EXACTLY ──────────────────────────────────────────────
-- Asked whether a contact is an address-book entry or a CRM record, the answer
-- was:
--
--   "OPTION A. BUT IF THE NUMBER EXISTS IN THE CRM THEN THE CONTACT IS
--    AUTOMATICALLY CREATED. BUT CREATING A NEW NUMBER FOR A CONTACT SHOULD NOT
--    AUTOMATICALLY CREATE A CRM RECORD"
--
-- So the link is deliberately ONE-WAY:
--   • a number that matches a record  → a contact appears by itself, linked
--   • a contact typed in by hand      → NO record is ever created
--
-- `record_id` is therefore nullable and is only ever set by the automatic
-- path. Nothing in this schema can create a `records` row.
--
-- ── PRIVATE, AND PRIVATE MEANS PRIVATE ──────────────────────────────────────
-- Asked whether contacts are personal or shared, the answer was "PRIVATE". So
-- `owner_id` is not a convenience column, it is the whole access rule: a
-- representative sees their own contacts and nobody else's, admins included.
-- That is a deliberate departure from the rest of this schema, where an admin
-- can see everything, and it is what the word private means.
--
-- Offboarding still works: `supabaseAdmin()` uses the service role, which
-- bypasses RLS, so an admin tool can reassign or purge a departed user's
-- contacts even though no admin can browse them through the app.
-- ============================================================================

create table if not exists public.phone_contacts (
  id            uuid primary key default gen_random_uuid(),
  -- The owner IS the access rule. Cascade: a deleted profile's private address
  -- book has nobody left to belong to.
  owner_id      uuid not null references public.profiles(id) on delete cascade,
  display_name  text not null,
  company       text,
  email         text,
  notes         text,
  -- Set ONLY by the automatic path, when the number already matched a record.
  -- Null for a hand-typed contact, and nothing here ever writes `records`.
  record_id     uuid references public.records(id) on delete set null,
  -- 'auto' rows were created by a matching call or text; 'manual' by a person.
  -- Kept because the two behave differently on cleanup and because "where did
  -- this come from" is otherwise unanswerable.
  source        text not null default 'manual'
                  check (source in ('manual', 'auto')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,

  constraint phone_contacts_display_name_not_blank
    check (length(btrim(display_name)) > 0)
);

-- ── numbers ─────────────────────────────────────────────────────────────────
-- A child table rather than a column, because a merchant contact routinely has
-- a mobile and a desk line, and the sync requirement is by NUMBER: a call
-- arrives on one of them and has to find the same contact either way. One
-- column would have forced one person to become two contacts.
create table if not exists public.phone_contact_numbers (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid not null references public.phone_contacts(id) on delete cascade,
  /*
   * Denormalised from the parent so that "one contact per owner per number"
   * can be a UNIQUE INDEX rather than application logic. The automatic path
   * fires from webhooks on every matching call and text, so without a database
   * constraint a busy number would grow a new contact per message. Kept
   * correct by the trigger below, never by the caller.
   */
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  -- Always E.164. Matching is an exact string comparison, which is the whole
  -- reason `lib/phone/normalize.ts` exists.
  e164        text not null,
  label       text,
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now(),

  constraint phone_contact_numbers_e164_shape check (e164 ~ '^\+[1-9][0-9]{6,14}$')
);

-- The constraint that makes the automatic path safe to run on every webhook.
create unique index if not exists phone_contact_numbers_one_per_owner
  on public.phone_contact_numbers (owner_id, e164);

create index if not exists phone_contact_numbers_contact_idx
  on public.phone_contact_numbers (contact_id);

create index if not exists phone_contacts_owner_idx
  on public.phone_contacts (owner_id)
  where deleted_at is null;

create index if not exists phone_contacts_record_idx
  on public.phone_contacts (record_id)
  where record_id is not null;

-- ── keep the denormalised owner honest ──────────────────────────────────────
create or replace function public.phone_contact_number_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Read from the parent rather than trusting the caller. A number whose
  -- owner_id disagreed with its contact's would be invisible to its owner and
  -- would defeat the uniqueness rule at the same time.
  select c.owner_id into new.owner_id
    from public.phone_contacts c
   where c.id = new.contact_id;

  if new.owner_id is null then
    raise exception 'phone_contact_numbers.contact_id % does not exist', new.contact_id;
  end if;

  return new;
end;
$$;

drop trigger if exists phone_contact_numbers_set_owner on public.phone_contact_numbers;
create trigger phone_contact_numbers_set_owner
  before insert or update of contact_id on public.phone_contact_numbers
  for each row execute function public.phone_contact_number_owner();

-- ── updated_at ──────────────────────────────────────────────────────────────
create or replace function public.phone_contacts_touch()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists phone_contacts_set_updated_at on public.phone_contacts;
create trigger phone_contacts_set_updated_at
  before update on public.phone_contacts
  for each row execute function public.phone_contacts_touch();

-- ============================================================================
-- RLS — default deny, then owner-only, granted back deliberately.
-- ============================================================================
alter table public.phone_contacts        enable row level security;
alter table public.phone_contacts        force  row level security;
alter table public.phone_contact_numbers enable row level security;
alter table public.phone_contact_numbers force  row level security;

-- `anon` gets nothing, matching migration 92.
revoke all on public.phone_contacts        from anon;
revoke all on public.phone_contact_numbers from anon;

grant select, insert, update, delete on public.phone_contacts        to authenticated;
grant select, insert, update, delete on public.phone_contact_numbers to authenticated;

-- ── phone_contacts ──────────────────────────────────────────────────────────
drop policy if exists phone_contacts_select on public.phone_contacts;
create policy phone_contacts_select on public.phone_contacts
  for select to authenticated
  using (owner_id = auth.uid() and deleted_at is null);

drop policy if exists phone_contacts_insert on public.phone_contacts;
create policy phone_contacts_insert on public.phone_contacts
  for insert to authenticated
  -- You may only create contacts for yourself. Without the check, one user
  -- could plant rows in another's address book.
  with check (owner_id = auth.uid());

drop policy if exists phone_contacts_update on public.phone_contacts;
create policy phone_contacts_update on public.phone_contacts
  for update to authenticated
  using (owner_id = auth.uid())
  -- USING alone would let a row be updated OUT of your ownership - handing
  -- your contact to someone else, after which you can no longer see it.
  with check (owner_id = auth.uid());

drop policy if exists phone_contacts_delete on public.phone_contacts;
create policy phone_contacts_delete on public.phone_contacts
  for delete to authenticated
  using (owner_id = auth.uid());

-- ── phone_contact_numbers ───────────────────────────────────────────────────
-- Written against the denormalised owner_id, not through a join to the parent:
-- the column is trigger-maintained, so it cannot drift, and this keeps the
-- policy a single index-backed comparison on a table read on every webhook.
drop policy if exists phone_contact_numbers_select on public.phone_contact_numbers;
create policy phone_contact_numbers_select on public.phone_contact_numbers
  for select to authenticated
  using (owner_id = auth.uid());

drop policy if exists phone_contact_numbers_insert on public.phone_contact_numbers;
create policy phone_contact_numbers_insert on public.phone_contact_numbers
  for insert to authenticated
  -- The trigger overwrites owner_id from the parent, so this checks what will
  -- actually be stored: you may only add a number to a contact you own.
  with check (
    exists (
      select 1 from public.phone_contacts c
       where c.id = contact_id and c.owner_id = auth.uid()
    )
  );

drop policy if exists phone_contact_numbers_update on public.phone_contact_numbers;
create policy phone_contact_numbers_update on public.phone_contact_numbers
  for update to authenticated
  using (owner_id = auth.uid())
  with check (
    exists (
      select 1 from public.phone_contacts c
       where c.id = contact_id and c.owner_id = auth.uid()
    )
  );

drop policy if exists phone_contact_numbers_delete on public.phone_contact_numbers;
create policy phone_contact_numbers_delete on public.phone_contact_numbers
  for delete to authenticated
  using (owner_id = auth.uid());

-- ============================================================================
-- The automatic path.
--
-- Called from the webhooks and the send/dial paths with the service role, for
-- every call and text whose number matched a record. Idempotent by the unique
-- index above, so firing it on every event is safe and cheap.
--
-- It creates a CONTACT. It never creates a RECORD — that is the client's rule,
-- and it is enforced by this function simply containing no insert into
-- `records`.
-- ============================================================================
create or replace function public.ensure_auto_contact(
  p_owner_id  uuid,
  p_e164      text,
  p_record_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_contact_id uuid;
  v_name       text;
begin
  /*
   * ⚠ THE OWNER IS AN ARGUMENT, AND THIS FUNCTION IS SECURITY DEFINER.
   *
   * That combination bypasses RLS, so without this check any signed-in user
   * could pass somebody else's id and write into their PRIVATE address book -
   * or probe whether a given number is already in it by watching what comes
   * back. The webhooks legitimately need to file a contact for another user,
   * so the parameter has to stay; what must not stay is trusting it when the
   * caller is a person.
   *
   * `auth.uid()` is null for the service role, which is how the webhooks get
   * through, and non-null for anyone acting through the app.
   */
  if auth.uid() is not null and p_owner_id is distinct from auth.uid() then
    raise exception 'ensure_auto_contact: cannot file a contact for another user';
  end if;

  -- No owner means nobody's address book to file it in (an inbound call to an
  -- unowned number). Not an error; there is simply nothing to do.
  if p_owner_id is null or p_e164 is null or p_e164 = '' then
    return null;
  end if;

  -- Already known to this user, under any name they may since have given it.
  select n.contact_id into v_contact_id
    from public.phone_contact_numbers n
   where n.owner_id = p_owner_id and n.e164 = p_e164
   limit 1;

  if v_contact_id is not null then
    -- Late-binding link: the contact may have been created by hand before the
    -- number ever matched a record. Fill the link in, but never overwrite one
    -- that is already set, and never touch a name the user has edited.
    if p_record_id is not null then
      update public.phone_contacts
         set record_id = p_record_id
       where id = v_contact_id and record_id is null;
    end if;
    return v_contact_id;
  end if;

  /*
   * ONLY the matched case auto-creates. The client's rule is "if the number
   * exists in the CRM then the contact is automatically created" - so a call
   * from a number belonging to nobody does NOT silently fill the address book
   * with strangers. Those live on the Phone page instead, which is the
   * "general area" the client asked for.
   */
  if p_record_id is null then
    return null;
  end if;

  select coalesce(nullif(btrim(r.values ->> 'deal_name'), ''), p_e164)
    into v_name
    from public.records r
   where r.id = p_record_id;

  insert into public.phone_contacts (owner_id, display_name, record_id, source)
  values (p_owner_id, coalesce(v_name, p_e164), p_record_id, 'auto')
  returning id into v_contact_id;

  insert into public.phone_contact_numbers (contact_id, owner_id, e164, is_primary)
  values (v_contact_id, p_owner_id, p_e164, true)
  -- Belt and braces against two webhooks racing for the same new number.
  on conflict (owner_id, e164) do nothing;

  return v_contact_id;
end;
$$;

-- Callable by the app as well as by the service role: the dialer resolves a
-- contact for the number being dialled, and that runs as the signed-in user.
-- SECURITY DEFINER bypasses RLS, so the function takes the owner explicitly
-- and the callers pass their own id.
revoke all on function public.ensure_auto_contact(uuid, text, uuid) from public;
grant execute on function public.ensure_auto_contact(uuid, text, uuid) to authenticated, service_role;
