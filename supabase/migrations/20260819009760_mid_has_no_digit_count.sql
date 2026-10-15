-- =============================================================================
-- MID no longer has to be 8 or 9 digits.
--
-- Asked for by the client (QA, 14 Oct 2026): "Please remove amount of digits
-- restriction on the MID field in crm."
--
-- The rule came from the client's own field sheet ("Must be either 8 or 9
-- digits") and was seeded as `fields.digits = '{8,9}'` in migration 10. It is
-- enforced in exactly one place — the identifier input in `value.tsx`, which
-- reads `field.digits` and refuses to commit a value of any other length.
-- There is no CHECK constraint, trigger or server-side validator on it, so
-- clearing the column is the whole change: no code names the MID field.
--
-- ── WHAT STAYS ───────────────────────────────────────────────────────────
-- Digits only. The input still strips anything that is not 0-9, and the
-- residuals MID matching (migration R3 onward) normalises digits-only too, so
-- loosening the LENGTH does not loosen the CHARACTER rule both depend on.
--
-- MCC keeps its four-digit rule, and routing number and SSN keep nine — the
-- request was about MID alone, and those three are fixed by the card networks
-- and the IRS rather than by a processor.
--
-- ── THE HINT CHANGES WITH IT ─────────────────────────────────────────────
-- Leaving "Must be either 8 or 9 digits." under a field that now accepts any
-- length would tell people a rule that no longer exists — the kind of
-- confident wrong sentence this project has repeatedly had to take back.
-- =============================================================================

update fields
   set digits = null,
       hint   = 'Digits only. Length varies by processor.'
 where key = 'mid'
   and archived_at is null;

do $$
begin
  if exists (select 1 from fields where key = 'mid' and digits is not null) then
    raise exception 'MID still carries a digit-count rule after the update.';
  end if;
end;
$$;
