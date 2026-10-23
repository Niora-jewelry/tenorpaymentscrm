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
 * The client asked for a Delete button. `deleteTemplate` below keeps both
 * protections above: it refuses while any user is attached (and the FK
 * refuses again underneath it, so a race cannot slip through), and the
 * confirm dialog on the screen states how many grants go with the template
 * before the admin agrees. An unattached, confirmed delete is what remains.
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
import type { AuthContext } from './permissions';
import { assertAdmin, UNIQUE_VIOLATION, type Result } from './adminConfig';
import type { CreateTemplateInput, RenameTemplateInput, DeleteTemplateInput } from './adminSchemas';

/** Postgres foreign-key violation: a user attached between the check and the delete. */
const FK_VIOLATION = '23503';

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

/**
 * Deletes a template nobody is attached to. Its grants go with it
 * (`template_grants` cascades); the screen has said how many before this is
 * called. A template with users is refused by name of the count, and the
 * foreign key from `user_templates` refuses again if someone was attached in
 * between — so no user can ever be left pointing at a template that is gone.
 */
export async function deleteTemplate(ctx: AuthContext, input: DeleteTemplateInput): Promise<Result> {
  assertAdmin(ctx);
  const admin = supabaseAdmin();

  const { count, error: countErr } = await admin
    .from('user_templates')
    .select('user_id', { count: 'exact', head: true })
    .eq('template_id', input.templateId);
  if (countErr) return { ok: false, message: countErr.message };
  if (count && count > 0) {
    return { ok: false, message: `${count} user${count === 1 ? ' is' : 's are'} on this template. Move them to another template first.` };
  }

  const { data, error } = await admin
    .from('permission_templates')
    .delete()
    .eq('id', input.templateId)
    .select('id')
    .maybeSingle();
  if (error) {
    if (error.code === FK_VIOLATION) return { ok: false, message: 'A user was just attached to this template. Move them first, then try again.' };
    return { ok: false, message: error.message };
  }
  if (!data) return { ok: false, message: 'That template no longer exists — reload the page.' };

  return { ok: true, id: data.id };
}
