/**
 * Everything the builder offers: read from the configuration, so a new module,
 * field or pipeline shows up here with no code. Automations ignore permissions
 * (spec), so this lists the whole configuration, for someone the gate let in.
 */
import 'server-only';
import { fieldsInTab, loadConfig, pipelineStatusFields, stepsForPipeline, subtabsForModule, type Field } from '@/lib/records/config';
import { APPLICATION_ROWS } from '@/lib/records/files';
import type { AuthContext } from '@/lib/records/permissions';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { assertAutomationsView } from './access';

export type Option = { value: string; label: string; hint?: string };
export type CatalogField = { key: string; label: string; where: string; type: string; choices: Option[] };
export type CatalogPipeline = { id: string; label: string; moduleId: string; moduleLabel: string; steps: Option[] };
export type CatalogTeam = { id: string; label: string; members: Option[] };

export type Catalog = {
  /** Display modules, for triggers and the Only in module condition. */
  modules: Option[];
  /** Those an automation may add a record to or remove one from: a rule looks after the others. */
  movableModules: Option[];
  statuses: Option[];
  pipelines: CatalogPipeline[];
  teams: CatalogTeam[];
  users: Option[];
  /** Every drawer field, with the members of repeat groups. */
  fields: CatalogField[];
  /** Fields whose value an email may print: never a sensitive one. */
  variables: CatalogField[];
  tabs: Option[];
  fileRows: string[];
  inboxes: Option[];
};

const NOT_A_VARIABLE = new Set(['file', 'repeat_group', 'grid', 'percent_split']);

export async function automationCatalog(ctx: AuthContext): Promise<Catalog> {
  await assertAutomationsView(ctx);
  const config = await loadConfig();
  const admin = supabaseAdmin();

  const display = config.modules.filter((m) => m.kind === 'display').sort((a, b) => a.position - b.position);
  const modules = display.map((m) => ({ value: m.id, label: m.label }));
  const movableModules = display.filter((m) => !m.showsOpenCases).map((m) => ({ value: m.id, label: m.label }));

  const statusField = config.fields.find((f) => f.key === 'current_status');
  const seenStatus = new Map<string, Option>();
  for (const c of config.choices.filter((x) => x.fieldId === statusField?.id).sort((a, b) => a.position - b.position)) {
    if (!seenStatus.has(c.key)) seenStatus.set(c.key, { value: c.key, label: c.value });
  }

  const pipelines = config.pipelines
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((p) => ({
      id: p.id,
      label: p.label,
      moduleId: p.moduleId,
      moduleLabel: config.modules.find((m) => m.id === p.moduleId)?.label ?? '',
      steps: stepsForPipeline(config, p.id).map((s) => ({ value: s.id, label: s.label })),
    }));

  const synced = pipelineStatusFields(config);
  const choicesOf = (f: Field): Option[] => {
    const seen = new Map<string, Option>();
    for (const c of config.choices.filter((x) => x.fieldId === f.id).sort((a, b) => a.position - b.position)) {
      if (!seen.has(c.key)) seen.set(c.key, { value: c.key, label: c.value });
    }
    return [...seen.values()];
  };

  const fields: CatalogField[] = [];
  const variables: CatalogField[] = [];
  const tabs: Option[] = [];
  const firstDisplay = display[0]?.id;
  for (const t of config.tabs.filter((x) => x.kind === 'custom' && x.acceptsFields).sort((a, b) => a.position - b.position)) {
    const subs = firstDisplay ? subtabsForModule(config, firstDisplay, t.id) : [];
    tabs.push({ value: t.id, label: t.label, hint: subs.length ? 'Every sub-tab' : undefined });
    for (const s of subs) tabs.push({ value: `${t.id}/${s.id}`, label: `${t.label} › ${s.label}` });

    const places = [{ subtabId: null as string | null, where: t.label }, ...subs.map((s) => ({ subtabId: s.id as string | null, where: `${t.label} › ${s.label}` }))];
    for (const place of places) {
      for (const f of fieldsInTab(config, t.id, place.subtabId)) {
        if (f.archivedAt || synced.has(f.id)) continue;
        if (f.type === 'repeat_group') {
          fields.push({ key: f.key, label: f.label, where: place.where, type: f.type, choices: [] });
          for (const m of f.repeatSchema ?? []) {
            fields.push({ key: `${f.key}.${m.key}`, label: `${f.label} › ${m.label}`, where: place.where, type: m.type, choices: [] });
          }
          continue;
        }
        const entry = { key: f.key, label: f.label, where: place.where, type: f.type, choices: choicesOf(f) };
        fields.push(entry);
        if (!f.sensitive && !NOT_A_VARIABLE.has(f.type)) variables.push(entry);
      }
    }
  }

  const [{ data: templates }, { data: profiles }, { data: links }, { data: connections }] = await Promise.all([
    admin.from('permission_templates').select('id, label, team_label, user_type').not('user_type', 'is', null).order('position'),
    admin.from('profiles').select('id, full_name, email').eq('status', 'active').is('deleted_at', null),
    admin.from('user_templates').select('user_id, template_id'),
    admin
      .from('mail_connections')
      .select('mailbox:mail_mailboxes!inner (id, address, display_name, deleted_at, deactivated_at)')
      .is('disconnected_at', null)
      .in('status', ['ok', 'degraded']),
  ]);

  const nameOf = (p: { full_name: string | null; email: string }) => p.full_name?.trim() || p.email;
  const people = (profiles ?? []).map((p) => ({ value: p.id as string, label: nameOf(p as { full_name: string | null; email: string }) })).sort((a, b) => a.label.localeCompare(b.label));
  const templateOf = new Map((links ?? []).map((l) => [l.user_id as string, l.template_id as string]));
  const teams = (templates ?? []).map((t) => ({
    id: t.id as string,
    label: ((t.team_label as string | null) ?? (t.label as string)),
    members: people.filter((p) => templateOf.get(p.value) === t.id),
  }));

  const inboxes = new Map<string, Option>();
  for (const c of connections ?? []) {
    const m = c.mailbox as unknown as { id: string; address: string; display_name: string; deleted_at: string | null; deactivated_at: string | null };
    if (!m.deleted_at && !m.deactivated_at) inboxes.set(m.id, { value: m.id, label: m.address, hint: m.display_name || undefined });
  }

  return {
    modules,
    movableModules,
    statuses: [...seenStatus.values()],
    pipelines,
    teams,
    users: people,
    fields,
    variables,
    tabs,
    fileRows: [...APPLICATION_ROWS],
    inboxes: [...inboxes.values()].sort((a, b) => a.label.localeCompare(b.label)),
  };
}
