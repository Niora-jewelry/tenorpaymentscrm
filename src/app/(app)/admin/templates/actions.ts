'use server';

/**
 * Admin → Templates server actions (Phase 6a).
 *
 * Same Zod-at-the-boundary rule as every other admin action (CLAUDE.md §6),
 * enforced for this route by `adminConfig.test.ts` — a Server Action is a
 * public HTTP endpoint whatever the form in front of it looks like.
 *
 * ── WHY THERE IS NO `revalidateConfig()` HERE, AND MUST NOT BE ───────────
 * Every Presets action calls it, so its absence looks like the omission that
 * area's guard test exists to catch. It is the opposite:
 *
 *   1. `revalidateConfig()` invalidates `loadConfig()`'s cache — tabs,
 *      subtabs, fields, columns, choices, pipelines. `permission_templates` is
 *      not in `loadConfig()` at all, so there is nothing of it to invalidate.
 *   2. More importantly, permissions must NOT become cached. Editing a
 *      template changes every attached user's effective grant on their **next
 *      request**, with no push step — the live-linked property the client
 *      relies on (`CLIENT-SPEC-BY-MODULE.md` §8). `effective_grant()` reads
 *      `template_grants` at call time, and per-user resolution is deliberately
 *      outside the cached config. Adding caching to this path would break that
 *      property, and would break it silently: stale permissions look exactly
 *      like correct ones.
 *
 * `adminConfig.test.ts` pins both halves — these actions must parse, and must
 * not reach for the config invalidator — so the reflex cannot be copied here by
 * a later hand. `remaining-plan.md` § 6c says the same thing about the grant
 * writers that land next.
 *
 * `revalidatePath` IS still needed: it refreshes the two rendered lists (this
 * screen, and the assign dropdown on Users), which is a rendering concern, not
 * a permission-resolution one.
 */
import { revalidatePath } from 'next/cache';
import { authorize } from '@/lib/records/permissions';
import { createTemplate, renameTemplate } from '@/lib/records/adminTemplates';
import {
  clearTemplateGrant,
  setTemplateGrant,
  setTemplateGrants,
  type GrantResult,
  type GrantBatchResult,
} from '@/lib/records/adminGrants';
import {
  createTemplateSchema,
  renameTemplateSchema,
  setTemplateGrantSchema,
  setTemplateGrantsSchema,
  clearTemplateGrantSchema,
  firstIssueMessage,
} from '@/lib/records/adminSchemas';
import type { Grant, GrantScope } from '@/lib/records/grantRules';

export type TemplateFormState = { ok: boolean; message?: string };

/** Both screens that name a template re-render: this one, and `Admin → Users`,
 * whose badge and assign dropdown read the same rows. */
function revalidateTemplateScreens(): void {
  revalidatePath('/admin/templates');
  revalidatePath('/admin/users');
}

export async function createTemplateAction(
  _prev: TemplateFormState,
  formData: FormData,
): Promise<TemplateFormState> {
  const ctx = await authorize();

  const parsed = createTemplateSchema.safeParse({ label: formData.get('label') });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await createTemplate(ctx, parsed.data);
  if (!result.ok) return result;

  revalidateTemplateScreens();
  return { ok: true };
}

/** Called directly from a client component rather than submitted as a form,
 * which makes parsing more important, not less: the arguments are whatever
 * arrived over the wire. */
export async function renameTemplateAction(templateId: string, label: string): Promise<TemplateFormState> {
  const ctx = await authorize();

  const parsed = renameTemplateSchema.safeParse({ templateId, label });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await renameTemplate(ctx, parsed.data);
  if (!result.ok) return result;

  revalidateTemplateScreens();
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Grants — Phase 6c                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The grant matrix's own route, plus the list that counts its grants.
 *
 * Read the file header before adding anything else to this: `revalidatePath` is
 * a RENDERING concern (it refreshes the RSC payload behind the client router's
 * cache, which is what makes the cell the admin just clicked agree with the
 * server on the next navigation). `revalidateConfig()` would be a PERMISSION
 * one, and there must never be one of those anywhere near this path.
 *
 * A user's permissions screen is not revalidated from here and does not need to
 * be: it is a dynamic route that resolves grants at request time, which is the
 * same property the client depends on for the no-push-step rule.
 */
function revalidateTemplateGrants(templateId: string): void {
  revalidatePath(`/admin/templates/${templateId}`);
  revalidatePath('/admin/templates');
}

export async function setTemplateGrantAction(
  templateId: string,
  scopeKind: GrantScope,
  scopeId: string,
  level: Grant,
  /** Null/omitted writes the grant that applies in EVERY module; a module id
   *  writes an override for that module alone — §2.2's per-module granularity. */
  moduleId?: string | null,
): Promise<GrantResult> {
  const ctx = await authorize();

  const parsed = setTemplateGrantSchema.safeParse({ templateId, scopeKind, scopeId, level, moduleId });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await setTemplateGrant(ctx, parsed.data);
  if (!result.ok) return result;

  revalidateTemplateGrants(parsed.data.templateId);
  return { ok: true };
}

/**
 * Several cells of one template at once — the client's Addition 4. Each item
 * goes through the same writer as a single click, so nothing a click would
 * refuse is stored by a batch; the result names every item that did not land.
 */
export async function setTemplateGrantsAction(
  templateId: string,
  items: { scopeKind: GrantScope; scopeId: string; level: Grant | null }[],
  moduleId?: string | null,
): Promise<GrantBatchResult> {
  const ctx = await authorize();

  const parsed = setTemplateGrantsSchema.safeParse({ templateId, moduleId, items });
  if (!parsed.success) {
    return { ok: false, failed: items.map((i) => ({ ...i, message: firstIssueMessage(parsed.error) })) };
  }

  const result = await setTemplateGrants(ctx, parsed.data);
  revalidateTemplateGrants(parsed.data.templateId);
  return result;
}

/** Back to inherited — which for a template means `GRANT_DEFAULT`, i.e. Edit.
 * Not the same as setting Hidden, and the matrix draws it as its own state for
 * exactly that reason. */
export async function clearTemplateGrantAction(
  templateId: string,
  scopeKind: GrantScope,
  scopeId: string,
  moduleId?: string | null,
): Promise<GrantResult> {
  const ctx = await authorize();

  const parsed = clearTemplateGrantSchema.safeParse({ templateId, scopeKind, scopeId, moduleId });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await clearTemplateGrant(ctx, parsed.data);
  if (!result.ok) return result;

  revalidateTemplateGrants(parsed.data.templateId);
  return { ok: true };
}
