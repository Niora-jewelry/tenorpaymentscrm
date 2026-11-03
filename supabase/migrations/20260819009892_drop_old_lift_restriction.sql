-- Unlocking by hand now names the items chosen (`lift_restrictions`, 9891). The old
-- one lifted a whole action. Apply after the code using the new one is deployed.
drop function if exists public.lift_restriction(uuid, text, text);
