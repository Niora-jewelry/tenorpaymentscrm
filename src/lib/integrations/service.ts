/**
 * CRM Settings › Integrations: who may see and change provider keys.
 *
 * Any admin with the page sees whether each service is connected. Only a super
 * admin sees the details or changes anything, and not while borrowing another
 * account. A key is tested before it is saved, so a typing mistake cannot take a
 * working phone line down. No value ever leaves this file for the browser or a log.
 */
import 'server-only';
import { forgetGraphToken } from '@/lib/email/graphAlert';
import { clearSecretRefused } from '@/lib/mail/health';
import { currentImpersonation } from '@/lib/auth/impersonation';
import { sendAlertTest, verifySmtpLogin } from '@/lib/email/send';
import { appOrigin } from '@/lib/appOrigin';
import { canOpenAdminPage, permissionsFor, type AuthContext } from '@/lib/records/permissions';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { cleanValue, hintFor, isSwitchable, settingDef, SETTINGS, settingsIn, type IntegrationGroup, type SettingKind } from './catalog';
import { sealSetting } from './crypto';
import { connectSignwellHook, probeGroup, type ProbeResult } from './probe';
import { agreementsReadyFrom, forgetIntegrationValues, integrationSnapshot, mailReadyFrom, maverickReadyFrom, phoneReadyFrom, type IntegrationValues } from './resolve';

export class IntegrationError extends Error {}

export const siteOrigin = (): string => appOrigin();

export const GROUPS: { group: IntegrationGroup; title: string; powers: string }[] = [
  { group: 'twilio', title: 'Twilio', powers: 'Calls, call recordings, voicemail and text messages.' },
  { group: 'microsoft', title: 'Microsoft 365', powers: 'Connecting Outlook mailboxes to the Email module.' },
  { group: 'signwell', title: 'SignWell', powers: 'Sending agreements for e-signature.' },
  { group: 'alerts', title: 'Alert email', powers: 'Sign-in codes, voicemail alerts and other messages from the CRM.' },
  { group: 'maverick', title: 'Maverick Payments', powers: 'Sending applications to Maverick, their status, reporting, statements and support tickets.' },
];

export type SettingView = {
  key: string;
  label: string;
  kind: SettingKind;
  required: boolean;
  placeholder: string | null;
  help: string | null;
  /** 'crm' = saved on this screen, 'server' = from the hosting environment. */
  source: 'crm' | 'server' | null;
  hint: string | null;
  unreadable: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
};

export type GroupView = {
  group: IntegrationGroup;
  title: string;
  powers: string;
  ready: boolean;
  /** Has an on/off switch (alert email does not: sign-in codes depend on it). */
  switchable: boolean;
  /** Off: the keys are kept but nothing uses them. */
  enabled: boolean;
  switchedBy: { by: string | null; at: string } | null;
  /** Labels of what is still needed. */
  missing: string[];
  lastTest: { ok: boolean; note: string; at: string; by: string | null } | null;
  /** Empty unless the viewer is a super admin. */
  settings: SettingView[];
};

export type ChangeView = { id: string; label: string; group: string; grp: IntegrationGroup | null; action: 'set' | 'removed' | 'turned_on' | 'turned_off'; hint: string | null; by: string; at: string };

export type IntegrationsScreen = {
  canEdit: boolean;
  origin: string;
  groups: GroupView[];
  changes: ChangeView[];
  /** When each service was first connected or switched on (its Activity tab). Super admins only. */
  firstOn: Partial<Record<IntegrationGroup, string>>;
};

/** Microsoft 365 › Individual connectors: who has connected their own account. */
export type MicrosoftPerson = { id: string; person: string; mailbox: string; shared: boolean; status: string; connectedAt: string };

const readyFor = (group: IntegrationGroup, v: IntegrationValues): boolean => {
  switch (group) {
    case 'twilio':
      return phoneReadyFrom(v);
    case 'microsoft':
      return mailReadyFrom(v);
    case 'signwell':
      return agreementsReadyFrom(v);
    case 'maverick':
      return maverickReadyFrom(v);
    case 'alerts':
      return Boolean(v.SMTP_HOST || (v.ALERT_MAIL_TENANT_ID && (v.ALERT_MAIL_CLIENT_ID ?? v.MAIL_CLIENT_ID) && (v.ALERT_MAIL_CLIENT_SECRET ?? v.MAIL_CLIENT_SECRET)));
  }
};

const valueOf = (v: IntegrationValues, key: string): string | undefined => v[key as keyof IntegrationValues];

async function requireEditor(ctx: AuthContext): Promise<void> {
  const perms = await permissionsFor(ctx);
  if (!perms.superAdmin) throw new IntegrationError('Only a super admin can change integrations.');
  if (await currentImpersonation()) throw new IntegrationError('Stop viewing as someone else first.');
}

export async function integrationsScreen(ctx: AuthContext): Promise<IntegrationsScreen> {
  if (!(await canOpenAdminPage(ctx, 'integrations'))) throw new IntegrationError('You do not have access to this page.');
  const perms = await permissionsFor(ctx);
  const canEdit = perms.superAdmin;
  const db = supabaseAdmin();
  const [snap, { data: tests }, { data: rows }, { data: changes }, { data: switches }] = await Promise.all([
    integrationSnapshot(),
    db.from('integration_tests').select('grp, ok, note, tested_at, tested_by'),
    db.from('integration_settings').select('key, hint, updated_by, updated_at'),
    canEdit ? db.from('integration_changes').select('id, key, grp, action, hint, actor_name, changed_at').order('changed_at', { ascending: false }).limit(300) : Promise.resolve({ data: [] }),
    db.from('integration_switches').select('grp, enabled, updated_by, updated_at'),
  ]);
  const { data: firsts } = canEdit
    ? await db.from('integration_changes').select('grp, changed_at').in('action', ['set', 'turned_on']).order('changed_at', { ascending: true }).limit(1000)
    : { data: [] };
  const firstOn: Partial<Record<IntegrationGroup, string>> = {};
  for (const r of firsts ?? []) {
    const g = GROUPS.find((x) => x.group === r.grp)?.group;
    if (g && !firstOn[g]) firstOn[g] = r.changed_at as string;
  }

  const saved = new Map((rows ?? []).map((r) => [r.key as string, r]));
  const people = new Set<string>();
  for (const r of rows ?? []) if (r.updated_by) people.add(r.updated_by as string);
  for (const t of tests ?? []) if (t.tested_by) people.add(t.tested_by as string);
  for (const w of switches ?? []) if (w.updated_by) people.add(w.updated_by as string);
  const { data: names } = people.size ? await db.from('profiles').select('id, full_name, email').in('id', [...people]) : { data: [] };
  const nameOf = (id: unknown): string | null => {
    const p = (names ?? []).find((n) => n.id === id);
    return p ? ((p.full_name as string | null)?.trim() || (p.email as string | null)) : null;
  };

  const groups: GroupView[] = GROUPS.map((g) => {
    const defs = settingsIn(g.group);
    const test = (tests ?? []).find((t) => t.grp === g.group);
    const sw = (switches ?? []).find((w) => w.grp === g.group);
    const enabled = !snap.off.has(g.group);
    return {
      ...g,
      // The screen reads every value, a switched-off service's included, so its keys still show.
      ready: enabled && readyFor(g.group, snap.all),
      switchable: isSwitchable(g.group),
      enabled,
      switchedBy: sw ? { by: nameOf(sw.updated_by), at: sw.updated_at as string } : null,
      missing: defs.filter((d) => d.required && !valueOf(snap.all, d.key)).map((d) => d.label),
      lastTest: canEdit && test ? { ok: test.ok as boolean, note: test.note as string, at: test.tested_at as string, by: nameOf(test.tested_by) } : null,
      settings: canEdit
        ? defs.map((d) => {
            const value = valueOf(snap.all, d.key);
            const row = saved.get(d.key);
            const fromCrm = snap.fromCrm.has(d.key);
            return {
              key: d.key,
              label: d.label,
              kind: d.kind,
              required: d.required,
              placeholder: d.placeholder ?? null,
              help: d.help ?? null,
              source: fromCrm ? 'crm' : value ? 'server' : null,
              hint: fromCrm ? ((row?.hint as string | undefined) ?? null) : value ? hintFor(d, value) : null,
              unreadable: snap.unreadable.includes(d.key),
              updatedBy: fromCrm ? nameOf(row?.updated_by) : null,
              updatedAt: fromCrm ? ((row?.updated_at as string | undefined) ?? null) : null,
            };
          })
        : [],
    };
  });

  return {
    canEdit,
    origin: siteOrigin(),
    groups,
    firstOn,
    changes: (changes ?? []).map((c) => ({
      id: c.id as string,
      label: c.key === '(service)' ? '' : (settingDef(c.key as string)?.label ?? (c.key as string)),
      group: GROUPS.find((g) => g.group === c.grp)?.title ?? (c.grp as string),
      grp: GROUPS.find((g) => g.group === c.grp)?.group ?? null,
      action: c.action as ChangeView['action'],
      hint: c.hint as string | null,
      by: c.actor_name as string,
      at: c.changed_at as string,
    })),
  };
}

/**
 * Everyone who has connected their own Microsoft account, with the mailbox it
 * reaches. Names and addresses only: no tokens, no errors with provider detail.
 */
export async function microsoftPeople(ctx: AuthContext): Promise<MicrosoftPerson[]> {
  if (!(await canOpenAdminPage(ctx, 'integrations'))) throw new IntegrationError('You do not have access to this page.');
  const db = supabaseAdmin();
  const { data: conns } = await db
    .from('mail_connections')
    .select('id, user_id, mailbox_id, status, connected_at')
    .is('disconnected_at', null)
    .order('connected_at', { ascending: true })
    .limit(500);
  const list = conns ?? [];
  if (!list.length) return [];
  const [{ data: people }, { data: boxes }] = await Promise.all([
    db.from('profiles').select('id, full_name, email').in('id', [...new Set(list.map((c) => c.user_id as string))]),
    db.from('mail_mailboxes').select('id, address, kind').in('id', [...new Set(list.map((c) => c.mailbox_id as string))]),
  ]);
  return list.map((c) => {
    const p = (people ?? []).find((x) => x.id === c.user_id);
    const b = (boxes ?? []).find((x) => x.id === c.mailbox_id);
    return {
      id: c.id as string,
      person: ((p?.full_name as string | null)?.trim() || (p?.email as string | null)) ?? 'Unknown person',
      mailbox: (b?.address as string | undefined) ?? '',
      shared: b?.kind === 'shared',
      status: c.status as string,
      connectedAt: c.connected_at as string,
    };
  });
}

async function apply(ctx: AuthContext, group: IntegrationGroup, set: { key: string; value: string }[], remove: string[], test: ProbeResult | null): Promise<void> {
  const rows = set.map(({ key, value }) => {
    const def = settingDef(key);
    if (!def) throw new IntegrationError('That setting does not exist.');
    return { key, ...sealSetting(key, value), hint: hintFor(def, value) };
  });
  const { error } = await supabaseAdmin().rpc('integration_apply', {
    p_actor: ctx.userId,
    p_group: group,
    p_set: rows,
    p_remove: remove,
    p_test_ok: test ? test.ok : null,
    p_test_note: test ? test.note : null,
  });
  if (error) {
    console.error('[integrations] could not save', { group, code: error.code });
    throw new IntegrationError('The change was not saved. Try again.');
  }
  forgetIntegrationValues();
  forgetGraphToken();
}

const probe = (group: IntegrationGroup, v: IntegrationValues) => probeGroup(group, v, { origin: siteOrigin(), verifySmtp: verifySmtpLogin });

export type SaveResult = { saved: boolean; result: ProbeResult };

/**
 * Tests the new values together with what is already set, and saves only if the
 * provider accepts them. On a failure nothing changes.
 */
export async function saveIntegrationGroup(ctx: AuthContext, group: IntegrationGroup, input: Record<string, string>): Promise<SaveResult> {
  await requireEditor(ctx);
  const { all: current } = await integrationSnapshot();
  const set: { key: string; value: string }[] = [];
  const next: IntegrationValues = { ...current };
  for (const [key, raw] of Object.entries(input)) {
    const def = settingDef(key);
    if (!def || def.group !== group) throw new IntegrationError('That setting does not belong here.');
    const cleaned = cleanValue(def, raw);
    if (!cleaned.ok) throw new IntegrationError(cleaned.message);
    if (valueOf(current, key) === cleaned.value && (await integrationSnapshot()).fromCrm.has(key)) continue;
    set.push({ key, value: cleaned.value });
    next[key as keyof IntegrationValues] = cleaned.value;
  }
  if (set.length === 0) throw new IntegrationError('Nothing has changed.');

  const result = await probe(group, next);
  if (!result.ok) return { saved: false, result };
  await apply(ctx, group, set, [], result);
  // Microsoft has just accepted these keys. Nobody should wait for the next sign-in to hear so.
  if (group === 'microsoft') await clearSecretRefused();
  return { saved: true, result };
}

/** Takes the saved value away; the hosting environment's applies again, if it has one. */
export async function removeIntegrationSetting(ctx: AuthContext, key: string): Promise<void> {
  await requireEditor(ctx);
  const def = SETTINGS.find((s) => s.key === key);
  if (!def) throw new IntegrationError('That setting does not exist.');
  await apply(ctx, def.group, [], [key], null);
}

export async function testIntegrationGroup(ctx: AuthContext, group: IntegrationGroup): Promise<ProbeResult> {
  await requireEditor(ctx);
  const { all: values } = await integrationSnapshot();
  const result = await probe(group, values);
  await apply(ctx, group, [], [], result);
  return result;
}

/** Points SignWell's signing events at this site and keeps any webhook IDs already saved. */
export async function connectSignwell(ctx: AuthContext): Promise<ProbeResult> {
  await requireEditor(ctx);
  const { all: values } = await integrationSnapshot();
  if (!values.SIGNWELL_API_KEY) throw new IntegrationError('Save the SignWell API key first.');
  const hook = await connectSignwellHook(values.SIGNWELL_API_KEY, siteOrigin());
  if (!hook.ok) throw new IntegrationError(hook.message);
  const ids = new Set((values.SIGNWELL_WEBHOOK_ID ?? '').split(',').map((x) => x.trim()).filter(Boolean));
  ids.add(hook.id);
  const next: IntegrationValues = { ...values, SIGNWELL_WEBHOOK_ID: [...ids].join(',') };
  const result = await probe('signwell', next);
  await apply(ctx, 'signwell', [{ key: 'SIGNWELL_WEBHOOK_ID', value: next.SIGNWELL_WEBHOOK_ID! }], [], result);
  return result;
}

/**
 * Switches a service on or off. Its keys stay saved either way; Off makes the
 * CRM treat it as not connected, within seconds everywhere.
 */
export async function setIntegrationEnabled(ctx: AuthContext, group: IntegrationGroup, enabled: boolean): Promise<void> {
  await requireEditor(ctx);
  if (!isSwitchable(group)) throw new IntegrationError('Alert email can’t be switched off: sign-in codes are sent through it.');
  const { error } = await supabaseAdmin().rpc('integration_set_enabled', { p_actor: ctx.userId, p_group: group, p_enabled: enabled });
  if (error) {
    console.error('[integrations] could not switch', { group, code: error.code });
    throw new IntegrationError('The change was not saved. Try again.');
  }
  forgetIntegrationValues();
}

/** Sends one real alert to the person pressing the button, the only proof of Mail.Send. */
export async function sendTestAlert(ctx: AuthContext): Promise<{ to: string; microsoftRefused: string | null }> {
  await requireEditor(ctx);
  const { data } = await supabaseAdmin().from('profiles').select('email').eq('id', ctx.userId).maybeSingle();
  const to = data?.email as string | undefined;
  if (!to) throw new IntegrationError('Your account has no email address.');
  const sent = await sendAlertTest(to);
  if (!sent.ok) throw new IntegrationError(`The test alert could not be sent${sent.graphCode ? ` (Microsoft said ${sent.graphCode})` : ''}. Check the settings above and try again.`);
  return { to, microsoftRefused: sent.graphCode ?? null };
}
