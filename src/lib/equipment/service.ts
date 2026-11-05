/**
 * Merchant Equipment Setup: rows on a record, read and written through the grant
 * chain. The sub-tab is found by its flag and its columns by `row_column`, so no module,
 * tab or sub-tab is named here.
 *
 * ── HIDDEN COLUMNS ARE NEVER FETCHED ──────────────────────────────────
 * The select names only the columns this viewer may see on this record. A hidden
 * column is absent from the query and from what reaches the browser, not blanked.
 * The tables are default-deny, so the read uses the service role, and that is why the
 * gate has to answer first and why the column list is built from its answer.
 *
 * ── THE RULES ──────────────────────────────────────────────────────────
 *   See the panel      the sub-tab is not Hidden, on a record they can open
 *   Add, remove a row  Edit on the sub-tab
 *   Change a column    Edit on that column (its own grant, else the sub-tab's)
 *   Add a provider     Edit on the provider column AND `equipment.add_providers`
 *
 * Every write is one database function, which changes the value and logs it in one
 * transaction. Clearing Billed by when the provider changes is there too, so no
 * caller can leave it pointing at the old provider.
 */
import 'server-only';
import { loadConfig, type Field } from '@/lib/records/config';
import { permissionsFor, type AuthContext, type Grant } from '@/lib/records/permissions';
import { fieldCapsFor, subtabCapsFor } from '@/lib/records/tabAccess';
import { rateLimit, userKey } from '@/lib/security/rate-limit';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  EQUIPMENT_COLUMNS,
  columnNamed,
  normalizeProviderName,
  parseColumnValue,
  providerNameTaken,
  type ColumnKind,
  type ColumnValue,
  type EquipmentColumn,
} from './columns';

export type EquipmentColumnView = { column: EquipmentColumn; label: string; kind: ColumnKind; canEdit: boolean };
export type EquipmentRowView = { id: string; rowNo: number; values: Partial<Record<EquipmentColumn, ColumnValue>> };
export type EquipmentProvider = { id: string; name: string };

export type EquipmentPanelData = {
  /** Only the columns this viewer may see. The rest are absent, not empty. */
  columns: EquipmentColumnView[];
  rows: EquipmentRowView[];
  /** Absent when the provider column is hidden: the list would only name what it hides. */
  providers: EquipmentProvider[];
  canManageRows: boolean;
  canAddProviders: boolean;
};

export type EquipmentResult<T = EquipmentPanelData> = { ok: true; data: T } | { ok: false; message: string };

const NOT_FOUND = 'That record could not be found.';
const NO_EDIT = 'You do not have permission to change this.';
const SLOW_DOWN = 'Too many changes at once. Wait a moment and try again.';
const FAILED = 'That could not be saved. Try again.';

const refuse = <T>(message: string): EquipmentResult<T> => ({ ok: false, message });

type Where = { subtabId: string; tabId: string; columns: { def: (typeof EQUIPMENT_COLUMNS)[number]; field: Field }[] };

async function flaggedSubtab(): Promise<Where | null> {
  const config = await loadConfig();
  const subtab = config.subtabs.find((s) => s.showsEquipmentSetup);
  if (!subtab) return null;
  const columns = EQUIPMENT_COLUMNS.flatMap((def) => {
    const field = config.rowColumns.find((f) => f.subtabId === subtab.id && f.key === def.fieldKey);
    return field ? [{ def, field }] : [];
  });
  return { subtabId: subtab.id, tabId: subtab.tabId, columns };
}

type Access = { where: Where; subtab: Grant; columns: { def: Where['columns'][number]['def']; field: Field; grant: Grant }[] };

/**
 * The viewer's level on the sub-tab and on each column, or null if they cannot open
 * this record. `record_visible` is the drawer's own question: a record can be a row in
 * their list without being one they may open (an open assignment before it is taken).
 */
async function accessTo(ctx: AuthContext, recordId: string): Promise<Access | null> {
  const where = await flaggedSubtab();
  if (!where) return null;
  const supabase = await createSupabaseServerClient();
  const listed = await supabase.from('records').select('id').eq('id', recordId).is('deleted_at', null).maybeSingle();
  if (listed.error) throw listed.error;
  if (!listed.data) return null;
  const opens = await supabase.rpc('record_visible', { rec: recordId });
  if (opens.error) throw opens.error;
  if (!opens.data) return null;

  const subtab = (await subtabCapsFor(ctx, [recordId], where.subtabId, where.tabId)).get(recordId) ?? 'hidden';
  if (subtab === 'hidden') return null;
  const columns = await Promise.all(
    where.columns.map(async ({ def, field }) => ({
      def,
      field,
      grant: (await fieldCapsFor(ctx, [recordId], field)).get(recordId) ?? ('hidden' as Grant),
    })),
  );
  return { where, subtab, columns };
}

const mayAddProviders = async (ctx: AuthContext) =>
  ctx.isAdmin || (await permissionsFor(ctx)).settings['equipment.add_providers'] === 'yes';

/** Null when the panel is not for this viewer. */
export async function equipmentFor(ctx: AuthContext, recordId: string): Promise<EquipmentPanelData | null> {
  const access = await accessTo(ctx, recordId);
  if (!access) return null;
  const visible = access.columns.filter((c) => c.grant !== 'hidden');

  // Built from the gate's answer, so a hidden column is not in this query at all.
  const select = ['id', 'row_no', ...visible.map((c) => c.def.column)].join(', ');
  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from('equipment_rows')
    .select(select)
    .eq('record_id', recordId)
    .is('deleted_at', null)
    .order('row_no');
  if (error) throw error;
  const rows = (data ?? []) as unknown as ({ id: string; row_no: number } & Record<string, ColumnValue>)[];

  const canManageRows = access.subtab === 'edit';
  const provider = visible.find((c) => c.def.kind === 'provider');
  let providers: EquipmentProvider[] = [];
  if (provider) {
    const list = await admin.from('equipment_providers').select('id, name').order('position').order('name');
    if (list.error) throw list.error;
    providers = (list.data ?? []) as EquipmentProvider[];
  }

  return {
    columns: visible.map((c) => ({ column: c.def.column, label: c.field.label, kind: c.def.kind, canEdit: c.grant === 'edit' })),
    rows: rows.map((r) => ({
      id: r.id,
      rowNo: r.row_no,
      values: Object.fromEntries(visible.map((c) => [c.def.column, r[c.def.column] ?? null])),
    })),
    providers,
    canManageRows,
    canAddProviders: provider?.grant === 'edit' && (await mayAddProviders(ctx)),
  };
}

const allowed = async (ctx: AuthContext) => (await rateLimit(userKey('equipment', ctx.userId), { limit: 120, windowSeconds: 60 })).allowed;

/** The panel as it now stands, after a write this viewer was allowed to make. */
async function fresh(ctx: AuthContext, recordId: string): Promise<EquipmentResult> {
  const data = await equipmentFor(ctx, recordId);
  return data ? { ok: true, data } : refuse(NOT_FOUND);
}

async function liveRow(rowId: string) {
  const { data, error } = await supabaseAdmin()
    .from('equipment_rows')
    .select('id, record_id, provider_id')
    .eq('id', rowId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  return data as { id: string; record_id: string; provider_id: string | null } | null;
}

export async function addEquipmentRow(ctx: AuthContext, recordId: string): Promise<EquipmentResult> {
  const access = await accessTo(ctx, recordId);
  if (!access) return refuse(NOT_FOUND);
  if (access.subtab !== 'edit') return refuse(NO_EDIT);
  if (!(await allowed(ctx))) return refuse(SLOW_DOWN);
  const { error } = await supabaseAdmin().rpc('equipment_row_add', { p_record: recordId, p_actor: ctx.userId });
  if (error) return refuse(error.code === 'P0001' ? error.message : FAILED);
  return fresh(ctx, recordId);
}

export async function updateEquipmentRow(ctx: AuthContext, rowId: string, column: string, raw: unknown): Promise<EquipmentResult> {
  const def = columnNamed(column);
  if (!def) return refuse(NO_EDIT);
  const row = await liveRow(rowId);
  if (!row) return refuse('That row no longer exists.');
  const access = await accessTo(ctx, row.record_id);
  if (!access) return refuse(NOT_FOUND);
  // Not knowing the column and not being allowed it read the same: this is a yes or no.
  if (access.columns.find((c) => c.def.column === def.column)?.grant !== 'edit') return refuse(NO_EDIT);

  const parsed = parseColumnValue(def.kind, raw);
  if (!parsed.ok) return parsed;
  if (!(await allowed(ctx))) return refuse(SLOW_DOWN);

  const admin = supabaseAdmin();
  if (def.kind === 'provider' && parsed.value !== null) {
    const known = await admin.from('equipment_providers').select('id').eq('id', parsed.value as string).maybeSingle();
    if (known.error) throw known.error;
    if (!known.data) return refuse('Pick a provider from the list.');
  }
  if (def.kind === 'billed_by' && parsed.value === 'provider' && !row.provider_id) {
    return refuse('Pick a provider for this row first.');
  }

  const { error } = await admin.rpc('equipment_row_update', { p_row: rowId, p_actor: ctx.userId, p_changes: { [def.column]: parsed.value } });
  if (error) return refuse(error.code === 'P0002' ? error.message : FAILED);
  return fresh(ctx, row.record_id);
}

export async function deleteEquipmentRow(ctx: AuthContext, rowId: string): Promise<EquipmentResult> {
  const row = await liveRow(rowId);
  if (!row) return refuse('That row no longer exists.');
  const access = await accessTo(ctx, row.record_id);
  if (!access) return refuse(NOT_FOUND);
  if (access.subtab !== 'edit') return refuse(NO_EDIT);
  if (!(await allowed(ctx))) return refuse(SLOW_DOWN);
  const { error } = await supabaseAdmin().rpc('equipment_row_delete', { p_row: rowId, p_actor: ctx.userId });
  if (error) return refuse(error.code === 'P0002' ? error.message : FAILED);
  return fresh(ctx, row.record_id);
}

/** Adds to the list everyone shares. Picking it on a row is a separate, ordinary change. */
export async function addEquipmentProvider(ctx: AuthContext, recordId: string, rawName: string): Promise<EquipmentResult<{ panel: EquipmentPanelData; providerId: string }>> {
  const access = await accessTo(ctx, recordId);
  if (!access) return refuse(NOT_FOUND);
  if (access.columns.find((c) => c.def.kind === 'provider')?.grant !== 'edit' || !(await mayAddProviders(ctx))) return refuse(NO_EDIT);

  const name = normalizeProviderName(rawName);
  if (!name) return refuse('Enter the provider\'s name.');
  if (name.length > 80) return refuse('Keep the name under 80 characters.');
  if (!(await allowed(ctx))) return refuse(SLOW_DOWN);

  const admin = supabaseAdmin();
  const list = await admin.from('equipment_providers').select('id, name');
  if (list.error) throw list.error;
  const taken = 'That provider is already on the list.';
  if (providerNameTaken(name, (list.data ?? []) as EquipmentProvider[])) return refuse(taken);

  const { data, error } = await admin.rpc('equipment_provider_add', { p_name: name, p_record: recordId, p_actor: ctx.userId });
  // Two people adding one name at once: the database's index is the last word.
  if (error) return refuse(error.code === '23505' ? taken : FAILED);
  const panel = await fresh(ctx, recordId);
  return panel.ok ? { ok: true, data: { panel: panel.data, providerId: data as string } } : panel;
}
