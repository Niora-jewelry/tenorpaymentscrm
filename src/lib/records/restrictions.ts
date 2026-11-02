/**
 * Automation locks and hides on one record, as the viewer meets them (Lock & Hide
 * spec). The database decides everything; this reads what it says and shapes it
 * for the drawer. See migration 9860 for the model.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';
import type { Field } from './config';
import { loadConfig } from './config';

export type RestrictionKind = 'lock' | 'hide';

/** What a viewer may be shown about one item. */
export type RestrictionMark = {
  item: string;
  kind: RestrictionKind;
  automationName: string;
  appliedAt: string;
  /** May lift it, or put it back. */
  canLift: boolean;
  /** Every item the same action covered, by name: what a lift takes off. */
  batchItems: string[];
  batchId: string;
  /** Lifted by hand, and can be put back. */
  lifted: boolean;
};

export type ViewerRestrictions = {
  /** What applies to this viewer, by item. Nothing for an item they're out of. */
  effects: Record<string, RestrictionKind>;
  /** For the icons and the Unlock / Re-lock controls: only what they may know. */
  marks: RestrictionMark[];
  /** Items whose files this viewer can see but not download. */
  noDownload: string[];
};

export const NO_RESTRICTIONS: ViewerRestrictions = { effects: {}, marks: [], noDownload: [] };

type Row = {
  item: string; kind: RestrictionKind; effect: RestrictionKind | null; automation_name: string | null;
  applied_at: string | null; can_lift: boolean; allow_download: boolean; batch_id: string | null;
  batch_items: string[] | null; lifted: boolean;
};

export async function restrictionsFor(ctx: AuthContext, recordId: string): Promise<ViewerRestrictions> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('viewer_restrictions', { rec: recordId });
  if (error) throw error;
  const rows = (data ?? []) as Row[];
  if (!rows.length) return NO_RESTRICTIONS;

  const effects: Record<string, RestrictionKind> = {};
  const noDownload = new Set<string>();
  const marks: RestrictionMark[] = [];
  for (const r of rows) {
    if (r.effect && !r.lifted) {
      // A hide outranks a lock on the same item.
      if (r.effect === 'hide' || !effects[r.item]) effects[r.item] = r.effect;
    }
    const blocked = !r.lifted && !r.can_lift && !ctx.isAdmin;
    if (blocked && (!r.allow_download || (r.kind === 'lock' && r.item === 'tab:statements'))) noDownload.add(r.item);
    if (r.automation_name && r.applied_at && r.batch_id) {
      marks.push({
        item: r.item, kind: r.kind, automationName: r.automation_name, appliedAt: r.applied_at,
        canLift: r.can_lift, batchItems: r.batch_items ?? [], batchId: r.batch_id, lifted: r.lifted,
      });
    }
  }
  return { effects, marks, noDownload: [...noDownload] };
}

/** The items a field is inside, most specific first. */
export function fieldItems(field: Pick<Field, 'key' | 'tabId' | 'subtabId'>, tabKeyById: Map<string, string>): string[] {
  const tab = tabKeyById.get(field.tabId);
  return [`field:${field.key}`, ...(field.subtabId ? [`subtab:${field.subtabId}`] : []), ...(tab ? [`tab:${tab}`] : [])];
}

export function effectOf(r: ViewerRestrictions, items: string[]): RestrictionKind | null {
  if (items.some((i) => r.effects[i] === 'hide')) return 'hide';
  return items.some((i) => r.effects[i] === 'lock') ? 'lock' : null;
}

/** The sentence for a save that a lock refused (spec, "User has the item open"). */
export async function lockedFieldMessage(ctx: AuthContext, recordId: string, fieldKey: string): Promise<string | null> {
  const config = await loadConfig();
  const field = config.fields.find((f) => f.key === fieldKey);
  if (!field) return null;
  const items = fieldItems(field, new Map(config.tabs.map((t) => [t.id, t.key])));
  const r = await restrictionsFor(ctx, recordId);
  if (effectOf(r, items) !== 'lock') return null;
  const mark = r.marks.find((m) => items.includes(m.item) && m.kind === 'lock' && !m.lifted);
  return mark ? `This field was just locked by Automation: ${mark.automationName}.` : null;
}

export async function liftRestriction(_ctx: AuthContext, recordId: string, item: string, kind: RestrictionKind): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('lift_restriction', { p_record: recordId, p_item: item, p_kind: kind });
  if (error) throw error;
}

export async function reapplyRestriction(_ctx: AuthContext, recordId: string, batchId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('reapply_restriction', { p_record: recordId, p_batch: batchId });
  if (error) throw error;
}

/** What a viewer holds on a tab before any lock or hide: whether they may add. */
export async function tabBaseGrant(_ctx: AuthContext, recordId: string, tabKey: string): Promise<string> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('record_tab_base_grant', { rec: recordId, p_tab_key: tabKey });
  if (error) throw error;
  return (data as string | null) ?? 'hidden';
}
