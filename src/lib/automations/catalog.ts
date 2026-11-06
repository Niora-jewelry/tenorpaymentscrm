/**
 * Everything the builder offers: read from the configuration, so a new module,
 * field or pipeline shows up here with no code. Automations ignore permissions
 * (spec), so this lists the whole configuration, for someone the gate let in.
 */
import 'server-only';
import { fieldsInTab, headerFieldsForModule, loadConfig, pipelineStatusFields, stepsForPipeline, subtabsForModule, type Field } from '@/lib/records/config';
import { APPLICATION_ROWS } from '@/lib/records/files';
import type { AuthContext } from '@/lib/records/permissions';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { assertAutomationsView } from './access';

/** `group`: a heading in the list, where a field's options differ by module. */
export type Option = { value: string; label: string; hint?: string; group?: string };
export type CatalogField = { key: string; label: string; where: string; type: string; choices: Option[] };
export type CatalogPipeline = { id: string; label: string; moduleId: string; moduleLabel: string; steps: Option[] };
/** `superAdmin`: always sees and lifts everything (Lock & Hide spec), so it isn't a choice in those groups. */
export type CatalogTeam = { id: string; label: string; members: Option[]; superAdmin: boolean };
export type RestrictableTab = {
  key: string;
  label: string;
  /** How far down it can be picked: fields, Files rows, or the tab only. */
  level: 'field' | 'row' | 'tab';
  subtabs: { id: string; label: string; fields: Option[] }[];
  /** Fields not in a sub-tab. */
  fields: Option[];
};

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
  /** What Lock and Hide can cover, as a tree (spec, "What can be locked or hidden"). */
  restrictable: RestrictableTab[];
  /** The Vital Info header's fields, picked one at a time. */
  vitalFields: Option[];
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
  /*
   * A field's options can differ by module, and a module with none of its own
   * uses the field's general list. Flattened, Current Status read as one list of
   * unrelated words with nothing to say where each belongs, so they are grouped:
   * modules sharing a list share a heading.
   */
  const everyModule = config.modules.slice().sort((a, b) => a.position - b.position);
  // Current Status is one field per module (migration 9922); a flow sees them as one.
  const statusIds = new Set(config.fields.filter((f) => f.moduleId).map((f) => f.id));
  const choicesOf = (f: Field): Option[] => {
    const own = config.choices.filter((x) => (statusIds.has(f.id) ? statusIds.has(x.fieldId) : x.fieldId === f.id)).sort((a, b) => a.position - b.position);
    const general = own.filter((c) => c.moduleId === null);
    if (own.length === general.length) return general.map((c) => ({ value: c.key, label: c.value }));
    const lists = new Map<string, { modules: string[]; choices: typeof own }>();
    for (const m of everyModule) {
      const mine = own.filter((c) => c.moduleId === m.id);
      const choices = mine.length ? mine : general;
      if (!choices.length) continue;
      const shape = choices.map((c) => `${c.key}=${c.value}`).join('|');
      const list = lists.get(shape) ?? { modules: [], choices };
      list.modules.push(m.label);
      lists.set(shape, list);
    }
    const seen = new Map<string, Option>();
    for (const { modules, choices } of lists.values()) {
      for (const c of choices) if (!seen.has(c.key)) seen.set(c.key, { value: c.key, label: c.value, group: modules.join(', ') });
    }
    return [...seen.values()];
  };
  const statusField = config.fields.find((f) => f.key === 'current_status');

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
        if (f.archivedAt || synced.has(f.id) || (f.moduleId && f.id !== statusField?.id)) continue;
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

  // A variable is written by its label, so two fields can't share one.
  const named = new Map<string, number>();
  for (const f of variables) named.set(f.label.toLowerCase(), (named.get(f.label.toLowerCase()) ?? 0) + 1);
  const uniqueVariables = variables.map((f) => (named.get(f.label.toLowerCase())! > 1 ? { ...f, label: `${f.label} (${f.where})` } : f));

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
    superAdmin: t.user_type === 'super_admin',
  }));

  const inboxes = new Map<string, Option>();
  for (const c of connections ?? []) {
    const m = c.mailbox as unknown as { id: string; address: string; display_name: string; deleted_at: string | null; deactivated_at: string | null };
    if (!m.deleted_at && !m.deactivated_at) inboxes.set(m.id, { value: m.id, label: m.address, hint: m.display_name || undefined });
  }

  // Deal Name is never hidden (permissions spec), so it isn't offered.
  const pickable = (f: Field) => !f.archivedAt && f.key !== 'deal_name' && !synced.has(f.id);
  const asOption = (f: Field): Option => ({ value: f.key, label: f.label });
  const { data: levels } = await admin.from('tabs').select('id, restriction_level');
  const levelOf = new Map((levels ?? []).map((t) => [t.id as string, t.restriction_level as string]));
  const restrictable: RestrictableTab[] = config.tabs
    .filter((t) => ['field', 'row', 'tab'].includes(levelOf.get(t.id) ?? 'none'))
    .sort((a, b) => a.position - b.position)
    .map((t) => {
      const level = levelOf.get(t.id) as RestrictableTab['level'];
      const subs = level === 'field' && firstDisplay ? subtabsForModule(config, firstDisplay, t.id) : [];
      return {
        key: t.key,
        label: t.label,
        level,
        subtabs: subs.map((s) => ({ id: s.id, label: s.label, fields: fieldsInTab(config, t.id, s.id).filter(pickable).map(asOption) })),
        fields: level === 'field' ? fieldsInTab(config, t.id, null).filter(pickable).map(asOption) : [],
      };
    });
  const vitalSeen = new Map<string, Option>();
  for (const m of display) for (const f of headerFieldsForModule(config, m.id)) if (pickable(f)) vitalSeen.set(f.key, asOption(f));

  return {
    modules,
    movableModules,
    restrictable,
    vitalFields: [...vitalSeen.values()],
    statuses: statusField ? choicesOf(statusField) : [],
    pipelines,
    teams,
    users: people,
    fields,
    variables: uniqueVariables,
    tabs,
    fileRows: [...APPLICATION_ROWS],
    inboxes: [...inboxes.values()].sort((a, b) => a.label.localeCompare(b.label)),
  };
}
