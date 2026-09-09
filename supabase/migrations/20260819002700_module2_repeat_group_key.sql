-- =============================================================================
-- Module 2 — Part 27: repeat_group_key — the missing link for cross-location
-- sync.
--
-- 'owner' spans two locations (Private holds just the SSN member; Ownership
-- holds the other six) so it became two `fields` rows at seed time
-- (`owner_private`, `owner_ownership`, migration 10 / generate-seed-sql.ts) —
-- `fields.key` is unique, so the location-qualified key was the only option.
-- generate-seed-sql.ts's own comment flagged this: "Stage 2's data layer is
-- where the two arrays' lengths get kept in sync when 'Add owner' is clicked
-- from either subtab — a follow-up for that stage." That stage is now:
-- real-build repeat-group editing needs a way to find every `fields` row
-- that is the SAME semantic group ('owner') across locations, and `key`
-- alone can't do it (it's already been made location-unique). This column is
-- that semantic key, distinct from the location-qualified `key` column.
--
-- Single-location groups ('contact', 'affiliate') get repeat_group_key equal
-- to their own bare key — harmless, and it means every repeat_group row can
-- be looked up the same way regardless of whether it has siblings.
-- =============================================================================

alter table fields add column repeat_group_key text;

update fields set repeat_group_key = 'contact'   where key = 'contact';
update fields set repeat_group_key = 'affiliate' where key = 'affiliate';
update fields set repeat_group_key = 'owner'      where key in ('owner_ownership', 'owner_private');

alter table fields add constraint repeat_group_key_shape check (
  (type = 'repeat_group' and repeat_group_key is not null)
  or (type <> 'repeat_group' and repeat_group_key is null)
);

-- Every repeat_group row must have landed a repeat_group_key by now — this
-- would fail loudly if a future seed adds a repeat_group field and forgets
-- the backfill, instead of silently shipping a group that can't sync.
do $$
begin
  if exists (select 1 from fields where type = 'repeat_group' and repeat_group_key is null) then
    raise exception 'repeat_group row(s) missing repeat_group_key after backfill';
  end if;
end $$;

create index fields_repeat_group_key on fields (repeat_group_key) where repeat_group_key is not null;
