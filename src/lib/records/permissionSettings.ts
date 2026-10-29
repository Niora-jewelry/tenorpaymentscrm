/**
 * The Permissions spec's settings, for the admin screens: what each one is,
 * what values it takes, what a user type and a user hold, and their history.
 *
 * Writes go through `perm_set_setting` (migration 9818), which checks the
 * guardrails and logs before → after in the same transaction. Reads use the
 * service role behind the Permissions / Users page's own access check.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { loadConfig } from './config';
import { assertAdminPage } from './adminConfig';
import { invalidatePermissions, permissionsFor, type AuthContext } from './permissions';

export type SettingOption = { value: string; label: string };
export type SettingRow = {
  key: string;
  label: string;
  hint?: string;
  options: SettingOption[];
  /** Shown instead of a control (Tickets follows Cases). */
  fixed?: string;
};
export type SettingGroup = { id: string; title: string; blurb: string; rows: SettingRow[] };

const YES_NO: SettingOption[] = [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }];
const HIDDEN_FULL: SettingOption[] = [{ value: 'hidden', label: 'Hidden' }, { value: 'full', label: 'Full access' }];
const OWN_ALL: SettingOption[] = [{ value: 'own', label: 'Own only' }, { value: 'all', label: 'All users' }];
const MINE_ALL: SettingOption[] = [{ value: 'mine', label: 'Only mine' }, { value: 'all', label: 'See all + grant' }];

/** The groups, in the spec's order. Module rows come from configuration. */
export async function settingGroups(): Promise<SettingGroup[]> {
  const config = await loadConfig();
  const cases = config.modules.find((m) => m.showsOpenCases);
  return [
    {
      id: 'actions',
      title: 'Company-wide actions',
      blurb: 'One yes/no each, in every module the user can open.',
      rows: [
        { key: 'action.create', label: 'Create new records', hint: 'The creator is added as a team member.', options: YES_NO },
        { key: 'action.team', label: 'Add / remove team members', hint: 'Team member(s) assigned and Relationship manager.', options: YES_NO },
        { key: 'action.archive', label: 'Delete / archive records', options: YES_NO },
        { key: 'action.modules', label: 'Display / remove from modules', hint: 'The In modules chips.', options: YES_NO },
        { key: 'action.pipeline', label: 'Move records through pipeline stages', options: YES_NO },
      ],
    },
    {
      id: 'modules',
      title: 'Module access',
      blurb: 'Which records the user sees in each module. Only mine = records they are a team member or the relationship manager on.',
      rows: config.modules.map((m) =>
        m.showsOpenCases
          ? { key: `module:${m.id}`, label: m.label, options: [], fixed: 'Follows the Cases setting below' }
          : m.fullAccessOnly
            ? { key: `module:${m.id}`, label: m.label, options: [{ value: 'hidden', label: 'Hidden' }, { value: 'all', label: 'Full access' }] }
            : {
                key: `module:${m.id}`,
                label: m.label,
                options: [{ value: 'hidden', label: 'Hidden' }, { value: 'mine', label: 'Only mine' }, { value: 'all', label: 'All records' }],
              },
      ),
    },
    {
      id: 'inboxes',
      title: 'Notifications, Email and Phone',
      blurb: 'Own only = their own notifications, inbox and phone line. All users = everyone’s.',
      rows: [
        { key: 'notifications.scope', label: 'Notifications', options: OWN_ALL },
        { key: 'email.scope', label: 'Email', options: OWN_ALL },
        { key: 'phone.scope', label: 'Phone', options: OWN_ALL },
      ],
    },
    {
      id: 'admin',
      title: 'Admin pages',
      blurb: 'Each page set separately. Full access = anything on that page, within the guardrails.',
      rows: [
        { key: 'admin.users', label: 'Users', options: HIDDEN_FULL },
        { key: 'admin.permissions', label: 'Permissions', options: HIDDEN_FULL },
        { key: 'admin.presets', label: 'Presets', options: HIDDEN_FULL },
        { key: 'admin.numbers', label: 'Phone numbers', options: HIDDEN_FULL },
        { key: 'admin.residuals', label: 'Residuals admin', options: HIDDEN_FULL },
        { key: 'admin.integrations', label: 'Integrations', options: HIDDEN_FULL },
        { key: 'admin.automations', label: 'Automations', options: HIDDEN_FULL },
        { key: 'admin.recycle_bin', label: 'Recycle bin', options: HIDDEN_FULL },
      ],
    },
    {
      id: 'communication',
      title: 'Communication tab',
      blurb: 'In a record’s drawer: emails, calls, texts and call recordings. There is no Hidden.',
      rows: [
        {
          key: 'communication.scope',
          label: 'Communication',
          hint: 'Own only = what they sent or were copied on.',
          options: [{ value: 'own', label: 'Own only' }, { value: 'org', label: 'Whole org' }],
        },
      ],
    },
    {
      id: 'items',
      title: 'Updates, cases and tab notes',
      blurb: 'Only mine = items they created, were @’d on, or were given. See all + grant can give one item to someone.',
      rows: [
        {
          key: 'items.cases',
          label: cases ? `Cases (also the ${cases.label} module)` : 'Cases',
          options: [{ value: 'hidden', label: 'Hidden' }, ...MINE_ALL],
        },
        { key: 'items.updates', label: 'Updates', options: MINE_ALL },
        { key: 'items.notes', label: 'Tab notes', options: MINE_ALL },
      ],
    },
    {
      id: 'applications',
      title: 'Applications',
      blurb: 'Returned application PDFs contain Social Security numbers. Only these people can open or download one.',
      rows: [{ key: 'applications.pdfs', label: 'Returned application PDFs', options: HIDDEN_FULL }],
    },
  ];
}

export type TemplateSettings = {
  values: Record<string, string>;
  /** The values the acting admin holds — nothing above these can be given. */
  ceiling: Record<string, string>;
  actorIsSuper: boolean;
  /** Why nothing can be changed here (guardrails 1 and 3), or null. */
  locked: string | null;
};

async function ceilingFor(ctx: AuthContext): Promise<Record<string, string>> {
  const p = await permissionsFor(ctx);
  const out: Record<string, string> = { ...p.settings };
  for (const [id, scope] of Object.entries(p.modules)) out[`module:${id}`] = scope;
  return out;
}

export async function templateSettings(ctx: AuthContext, templateId: string): Promise<TemplateSettings> {
  await assertAdminPage(ctx, 'permissions');
  const admin = supabaseAdmin();
  const [{ data, error }, tpl, mine] = await Promise.all([
    admin.from('permission_settings').select('key, value').eq('owner_kind', 'template').eq('owner_id', templateId),
    admin.from('permission_templates').select('user_type').eq('id', templateId).maybeSingle(),
    admin.from('user_templates').select('template_id').eq('user_id', ctx.userId).maybeSingle(),
  ]);
  if (error) throw error;
  const isSuperType = tpl.data?.user_type === 'super_admin';
  return {
    values: Object.fromEntries((data ?? []).map((r) => [r.key as string, r.value as string])),
    ceiling: await ceilingFor(ctx),
    actorIsSuper: ctx.isAdmin,
    locked: isSuperType
      ? 'A Super admin always has everything. These settings cannot lower it.'
      : !ctx.isAdmin && mine.data?.template_id === templateId
        ? 'You are on this user type, so changing it would change your own permissions.'
        : null,
  };
}

export type UserSettings = TemplateSettings & {
  /** The user's type's values — what applies where they have no override. */
  typeValues: Record<string, string>;
  typeLabel: string | null;
  typeId: string | null;
  targetIsSuper: boolean;
  /** Their tab / sub-tab / field overrides, in every module. */
  grantOverrides: number;
};

export async function userSettings(ctx: AuthContext, userId: string): Promise<UserSettings> {
  await assertAdminPage(ctx, 'permissions');
  const admin = supabaseAdmin();
  const [own, ut, prof, grants] = await Promise.all([
    admin.from('permission_settings').select('key, value').eq('owner_kind', 'user').eq('owner_id', userId),
    admin.from('user_templates').select('template_id, permission_templates(label)').eq('user_id', userId).maybeSingle(),
    admin.from('profiles').select('roles!inner(is_admin)').eq('id', userId).maybeSingle(),
    admin.from('user_grants').select('user_id', { count: 'exact', head: true }).eq('user_id', userId),
  ]);
  if (own.error) throw own.error;
  const typeId = (ut.data?.template_id as string | undefined) ?? null;
  const targetIsSuper = Boolean((prof.data as { roles?: { is_admin?: boolean } } | null)?.roles?.is_admin);
  const typeRows = typeId
    ? (await admin.from('permission_settings').select('key, value').eq('owner_kind', 'template').eq('owner_id', typeId)).data ?? []
    : [];
  return {
    values: Object.fromEntries((own.data ?? []).map((r) => [r.key as string, r.value as string])),
    typeValues: Object.fromEntries(typeRows.map((r) => [r.key as string, r.value as string])),
    typeLabel: ((ut.data as { permission_templates?: { label?: string } } | null)?.permission_templates?.label) ?? null,
    typeId,
    targetIsSuper,
    grantOverrides: grants.count ?? 0,
    ceiling: await ceilingFor(ctx),
    actorIsSuper: ctx.isAdmin,
    locked:
      userId === ctx.userId
        ? 'These are your own permissions. Another admin has to change them.'
        : targetIsSuper
          ? 'A Super admin always has everything. Change their user type to limit them.'
          : null,
  };
}

/** One setting on a user type or a user. `null` on a user = back to their type. */
export async function setPermissionSetting(
  ctx: AuthContext,
  input: { ownerKind: 'template' | 'user'; ownerId: string; key: string; value: string | null },
): Promise<{ ok: true } | { ok: false; message: string }> {
  await assertAdminPage(ctx, 'permissions');
  const { error } = await supabaseAdmin().rpc('perm_set_setting', {
    p_actor: ctx.userId,
    p_owner_kind: input.ownerKind,
    p_owner: input.ownerId,
    p_key: input.key,
    p_value: input.value,
  });
  if (error) return { ok: false, message: error.message };
  invalidatePermissions();
  return { ok: true };
}

export type AuditEntry = {
  id: string;
  at: string;
  actorName: string | null;
  what: string;
  before: string | null;
  after: string | null;
};

/** The change history for a user type or a user, newest first. */
export async function permissionHistory(
  ctx: AuthContext,
  targetKind: 'template' | 'user',
  targetId: string,
  limit = 50,
): Promise<AuditEntry[]> {
  await assertAdminPage(ctx, 'permissions');
  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from('permission_audit_log')
    .select('id, at, actor_id, what, before, after, module_id')
    .eq('target_kind', targetKind)
    .eq('target_id', targetId)
    .order('at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const actorIds = [...new Set((data ?? []).map((r) => r.actor_id as string).filter(Boolean))];
  const names = new Map<string, string>();
  if (actorIds.length) {
    const { data: ps } = await admin.from('profiles').select('id, full_name, email').in('id', actorIds);
    for (const p of ps ?? []) names.set(p.id as string, (p.full_name as string) || (p.email as string));
  }
  const config = await loadConfig();
  const tabById = new Map(config.tabs.map((t) => [t.id, t.label]));
  const subById = new Map(config.subtabs.map((s) => [s.id, s.label]));
  const fieldById = new Map(config.fields.map((f) => [f.id, f.label]));
  const modById = new Map(config.modules.map((m) => [m.id, m.label]));
  const groups = await settingGroups();
  const settingLabel = new Map(groups.flatMap((g) => g.rows.map((r) => [r.key, r.label] as const)));
  const describe = (what: string): string => {
    if (what === 'user_type') return 'User type';
    if (settingLabel.has(what)) return settingLabel.get(what)!;
    const [kind, id] = what.split(':');
    if (kind === 'tab') return `Tab: ${tabById.get(id!) ?? 'removed tab'}`;
    if (kind === 'subtab') return `Sub-tab: ${subById.get(id!) ?? 'removed sub-tab'}`;
    if (kind === 'field') return `Field: ${fieldById.get(id!) ?? 'removed field'}`;
    if (kind === 'module' || kind === 'membership') return `${kind === 'module' ? 'Module' : 'Add / remove'}: ${modById.get(id!) ?? ''}`;
    return what;
  };
  return (data ?? []).map((r) => ({
    id: r.id as string,
    at: r.at as string,
    actorName: names.get(r.actor_id as string) ?? null,
    what: describe(r.what as string) + (r.module_id ? ` (${modById.get(r.module_id as string) ?? 'one module'})` : ''),
    before: (r.before as string | null) ?? null,
    after: (r.after as string | null) ?? null,
  }));
}
