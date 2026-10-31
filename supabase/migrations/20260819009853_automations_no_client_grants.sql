-- =============================================================================
-- New tables here pick up Supabase's default grants to `anon` and `authenticated`.
-- RLS with no policies already refuses them, but a signed-in session has no
-- business holding write access to these at all: the service role and the
-- SECURITY DEFINER functions are the only way in.
-- =============================================================================

revoke all on table automations, automation_versions, automation_triggers, automation_queue,
                    automation_runs, automation_run_steps, automation_rotations, automation_files,
                    record_contact_emails, mail_record_links
  from public, anon, authenticated;
