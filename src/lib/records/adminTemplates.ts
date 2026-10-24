/**
 * Admin → Templates, Phase 6a: permission templates themselves. No grants.
 *
 * A template is a named set of Hidden/View/Edit grants that users attach to
 * (`CLIENT-SPEC-BY-MODULE.md` §8). This module creates and renames the named
 * set; editing what it GRANTS is 6b (read-only matrix) and 6c (writes), and
 * nothing here touches `template_grants`.
 *
 * ── THE ONE THING TO UNDERSTAND BEFORE READING THE SCREEN ────────────────
 * A template with no grants restricts nothing. `effective_grant()` resolves
 * user override → template → **'edit'** (migration 7), so a scope with no
 * `template_grants` row defaults to Edit — not Hidden. Every template this
 * module can currently produce has zero grants, which means attaching one
 * changes a user's access by exactly nothing.
 *
 * That is not a bug to fix here; it is what 6a is. But it must be SAID, on the
 * screen, in those words — an admin who creates "Read only", assigns it, and
 * assumes it restricts anything has been misled by a control that appeared to
 * work. `TemplatesSection.tsx` prints it per row and once at the top, and
 * `remaining-plan.md` § 6b carries the same warning for the matrix, where the
 * cost of getting it wrong is a field someone should not see.
 *
 * ── NO DELETE, DELIBERATELY ──────────────────────────────────────────────
 * Same posture as choices (migration 36) and steps (migration 37), and for a
 * sharper reason here. `template_grants` cascades from `permission_templates`;
 * `user_templates.template_id` does not. So removing a template that users are
 * attached to fails as a 23503, and removing an unattached one silently
 * discards its entire grant set — a whole permission configuration, gone with
 * no recovery path, at a moment when 6c has only just made building one
 * expensive. Retiring a template belongs with the other deferred deletion work.
 *
 * ── UPDATE, 23 Oct 2026: A GUARDED DELETE ────────────────────────────────
 * The client asked for a Delete button, then (24 Oct) for Delete to work on a
 * template people are on, moving them to another template. `deleteTemplate`
 * keeps both protections above: nobody is ever left on a template that is
 * gone or moved to no template (the database function refuses both, in one
 * transaction), and the dialog names the people and the grants before the
 * admin agrees.
 *
 * ── WHERE `listTemplates` WENT ───────────────────────────────────────────
 * It used to live in `adminUsers.ts` (the assign dropdown's only reader).
 * `remaining-plan.md` § Phase 6 asks for it to be moved rather than copied —
 * two functions of that name reading the same table is the quiet divergence
 * this build has been bitten by before — so it is here, and `Admin → Users`
 * imports it from this module.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { invalidateGrants, type AuthContext } from './permissions';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { assertAdmin, UNIQUE_VIOLATION, type Result } from './adminConfig';
import type { CreateTemplateInput, RenameTemplateInput, DeleteTemplateInput } from './adminSchemas';


/** The assign dropdown's shape — id and label, nothing more. */
export type TemplateOption = { id: string; label: string };

export type AdminTemplateRow = {
  id: string;
  label: string;
  createdAt: string;
  /** How many users resolve their permissions through this template. Editing
   * it in 6c changes every one of them on their next request, with no push
   * step — the live-linked property the client relies on (§8) — so the count
   * is the blast radius of an edit, shown before the edit exists. */
  attachedUsers: number;
  /** Rows in `template_grants`. Zero means "restricts nothing"; see the header.
   * Always zero until 6c ships, and shown anyway so it stops being zero
   * visibly rather than silently. */
  grantCount: number;
};

export async function listTemplates(ctx: AuthContext): Promise<TemplateOption[]> {
  assertAdmin(ctx);
  const { data, error } = await supabaseAdmin().from('permission_templates').select('id, label').order('label');
  if (error) throw error;
  return data ?? [];
}

/**
 * Every template with its two counts.
 *
 * The counts are aggregated in TypeScript from two full-column reads rather
 * than by a grouped query: PostgREST cannot GROUP BY, and the alternative is an
 * RPC for arithmetic over rows that number in the tens (three users and zero
 * templates in the live database today). If either table ever grows past what a
 * single read should carry, this becomes one `SECURITY DEFINER` function
 * returning both counts — not a per-row count query in a loop.
 */
export async function listTemplatesForAdmin(ctx: AuthContext): Promise<AdminTemplateRow[]> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();

  const [templatesRes, userTemplatesRes, grantsRes] = await Promise.all([
    supabase.from('permission_templates').select('id, label, created_at').order('label'),
    supabase.from('user_templates').select('template_id'),
    supabase.from('template_grants').select('template_id'),
  ]);
  for (const r of [templatesRes, userTemplatesRes, grantsRes]) if (r.error) throw r.error;

  const usersByTemplate = new Map<string, number>();
  for (const r of userTemplatesRes.data ?? []) {
    // `user_templates.template_id` is nullable — a row with NULL is "no
    // template", not a template with no name, and must not be counted against
    // one.
    if (!r.template_id) continue;
    usersByTemplate.set(r.template_id, (usersByTemplate.get(r.template_id) ?? 0) + 1);
  }

  const grantsByTemplate = new Map<string, number>();
  for (const r of grantsRes.data ?? []) {
    grantsByTemplate.set(r.template_id, (grantsByTemplate.get(r.template_id) ?? 0) + 1);
  }

  return (templatesRes.data ?? []).map((t) => ({
    id: t.id,
    label: t.label,
    createdAt: t.created_at,
    attachedUsers: usersByTemplate.get(t.id) ?? 0,
    grantCount: grantsByTemplate.get(t.id) ?? 0,
  }));
}

/** Migration 38's index, hit by two labels that differ only in case or in
 * surrounding whitespace. The message names the rule rather than the index,
 * because the admin's next action is to pick a different name. */
const duplicateLabel = (label: string): Result => ({
  ok: false,
  message: `A template called "${label}" already exists. Labels must be unique — the label is what identifies a template on the Users screen.`,
});

export async function createTemplate(ctx: AuthContext, input: CreateTemplateInput): Promise<Result> {
  assertAdmin(ctx);

  const label = input.label.trim();
  if (!label) return { ok: false, message: 'A label is required.' };

  const { data, error } = await supabaseAdmin()
    .from('permission_templates')
    .insert({ label })
    .select('id')
    .single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return duplicateLabel(label);
    return { ok: false, message: error.message };
  }

  return { ok: true, id: data.id };
}

/**
 * Renames a template. Free, in the sense that renaming a choice is free: users
 * attach to it by id (`user_templates.template_id`), so no attachment, grant or
 * resolved permission moves. The label is display only — which is exactly why
 * migration 38 requires it to stay unique.
 */
export async function renameTemplate(ctx: AuthContext, input: RenameTemplateInput): Promise<Result> {
  assertAdmin(ctx);

  const label = input.label.trim();
  if (!label) return { ok: false, message: 'A label is required.' };

  const { data, error } = await supabaseAdmin()
    .from('permission_templates')
    .update({ label })
    .eq('id', input.templateId)
    .select('id')
    .maybeSingle();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return duplicateLabel(label);
    return { ok: false, message: error.message };
  }
  // No row came back: the template was removed between this screen loading and
  // the save. An UPDATE matching nothing is not an error in Postgres, so
  // without this the form would report success for a write that did not happen.
  if (!data) return { ok: false, message: 'That template no longer exists — reload the page.' };

  return { ok: true, id: data.id };
}

/** One person on a template, for the delete dialog's list. */
export type TemplateMember = { id: string; name: string; email: string; removed: boolean };

/** The people resolving their permissions through this template. */
export async function templateMembers(ctx: AuthContext, templateId: string): Promise<TemplateMember[]> {
  assertAdmin(ctx);
  const { data, error } = await supabaseAdmin()
    .from('user_templates')
    .select('user_id, profiles!inner(email, full_name, deleted_at)')
    .eq('template_id', templateId)
    .returns<Array<{ user_id: string; profiles: { email: string; full_name: string | null; deleted_at: string | null } }>>();
  if (error) throw error;
  return (data ?? [])
    .map((r) => ({
      id: r.user_id,
      name: r.profiles.full_name?.trim() || r.profiles.email.split('@')[0],
      email: r.profiles.email,
      removed: Boolean(r.profiles.deleted_at),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Deletes a template. Anyone on it is moved to `moveToTemplateId` first, in
 * the same transaction (`delete_permission_template`, migration 9798): the
 * database refuses to leave a person on a template that is gone, and refuses
 * to move them to NO template, which would mean full access. Their own
 * overrides stay as they are. Runs as the signed-in admin — the function
 * checks `auth_is_admin()` itself.
 */
export async function deleteTemplate(ctx: AuthContext, input: DeleteTemplateInput): Promise<{ ok: true; moved: number } | { ok: false; message: string }> {
  assertAdmin(ctx);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('delete_permission_template', {
    p_template_id: input.templateId,
    p_move_to: input.moveToTemplateId,
  });
  if (error) return { ok: false, message: error.message };
  // The moved people resolve permissions differently from this request on.
  invalidateGrants();
  return { ok: true, moved: Number(data ?? 0) };
}
