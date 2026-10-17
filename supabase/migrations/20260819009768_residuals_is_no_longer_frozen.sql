-- =============================================================================
-- Residuals is no longer "frozen".
--
-- The seed (20260819001000) set `modules.frozen = true` on Residuals for the
-- client's August instruction: "The structure of the residual tab will be
-- different than the others — So do not work on it yet. I have someone else
-- designing it." The module has since been built (29 Sep – 13 Oct 2026; see
-- handoff/residuals/), so the flag was stale and the Presets screens kept
-- showing a "Frozen" chip and an "on hold" warning against it. Removed at
-- brimesh's request, 17 Oct 2026.
--
-- The flag is display-only — `adminPresets.ts`: "It gates nothing here" — so
-- this changes no permission, rule or behaviour: three Presets screens stop
-- drawing a chip. The column stays for any future module that needs it.
-- =============================================================================

update modules set frozen = false where slug = 'residuals' and frozen;
