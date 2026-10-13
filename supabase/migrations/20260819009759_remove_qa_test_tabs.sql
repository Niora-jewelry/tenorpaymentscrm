begin;

-- Detach two test leftovers from the modules that show them. Matched by
-- label: all three carry the generic Presets key `new`. Membership rows only,
-- as in ...9750; the config rows stay and can be re-attached from Presets.
-- Neither holds data. Leads and Records keep 7 Applications subtabs each,
-- so the show-every-subtab fallback cannot trigger.

delete from public.module_subtab_order mso
 using public.subtabs s, public.tabs t
 where mso.subtab_id = s.id and s.tab_id = t.id
   and t.label = 'Applications' and s.label = 'QA1 Test';

delete from public.module_tab_order mto
 using public.tabs t
 where mto.tab_id = t.id and t.label = 'QA Tab L';

commit;
