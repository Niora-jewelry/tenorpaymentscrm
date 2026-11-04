-- Calendar and Chat: the two "hide mine" switches are for Admins and Super admins only
-- (spec, Permissions). The RPC added in 9901 let any signed-in user call it straight
-- from the browser, which would let a member hide their own Calendar or Chat from the
-- admins the spec gives All users. The switch is now written by the server, after the
-- role check in the settings action, so the function goes.
drop function if exists set_my_teams_privacy(boolean, boolean);
