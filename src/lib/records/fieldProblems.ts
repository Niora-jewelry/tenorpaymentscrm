/**
 * "Can't send yet" lists: what is missing, grouped Tab › Sub-tab in the drawer's
 * own order, each item pointing at its field so the list can link straight to it.
 * Shared by the application, proposal and agreement checks (client, 4 Nov 2026:
 * "a list of the fields should appear that the user can click to take him
 * directly to the field").
 *
 * Pure: takes the configuration, returns data. No module or field is named here.
 */
import type { Config } from './config';

export type FieldProblem = { fieldKey: string; index?: number; member?: string; message: string };
export type ProblemItem = { fieldKey: string; index?: number; member?: string; label: string; message: string; tabKey: string | null; subtabKey: string | null };
export type ProblemGroup = { tabKey: string | null; tabLabel: string; subtabKey: string | null; subtabLabel: string | null; items: ProblemItem[] };

export function groupFieldProblems(config: Config, problems: FieldProblem[]): ProblemGroup[] {
  const groups = new Map<string, ProblemGroup>();
  const ordered = [...problems].sort((a, b) => {
    const fa = config.fields.find((f) => f.key === a.fieldKey);
    const fb = config.fields.find((f) => f.key === b.fieldKey);
    const ta = config.tabs.find((t) => t.id === fa?.tabId)?.position ?? 1e9;
    const tb = config.tabs.find((t) => t.id === fb?.tabId)?.position ?? 1e9;
    return ta - tb || (fa?.position ?? 0) - (fb?.position ?? 0);
  });
  for (const p of ordered) {
    const f = config.fields.find((x) => x.key === p.fieldKey);
    const tab = f ? config.tabs.find((t) => t.id === f.tabId) : undefined;
    const sub = f?.subtabId ? config.subtabs.find((s) => s.id === f.subtabId) : undefined;
    const key = `${tab?.key ?? ''}/${sub?.key ?? ''}`;
    const g = groups.get(key) ?? { tabKey: tab?.key ?? null, tabLabel: tab?.label ?? 'Record', subtabKey: sub?.key ?? null, subtabLabel: sub?.label ?? null, items: [] };
    g.items.push({ fieldKey: p.fieldKey, index: p.index, member: p.member, label: f?.label ?? p.fieldKey, message: p.message, tabKey: tab?.key ?? null, subtabKey: sub?.key ?? null });
    groups.set(key, g);
  }
  return [...groups.values()];
}

const filled = (v: unknown): boolean => {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).some(filled);
  return true;
};
export { filled as isFilled };

/**
 * Fields an admin marked Required in Presets, among the ones a document uses:
 * those join the document's own list. A field the sender cannot see is reported
 * without its value, so the list never discloses it.
 */
export function requiredFlagProblems(config: Config, values: Record<string, unknown>, usedKeys: readonly string[], hidden: Set<string>): FieldProblem[] {
  const out: FieldProblem[] = [];
  for (const key of usedKeys) {
    const f = config.fields.find((x) => x.key === key);
    if (!f?.required) continue;
    if (hidden.has(key)) out.push({ fieldKey: key, message: 'required, in a section you can’t see. Ask someone who can to fill it in.' });
    else if (!filled(values[key])) out.push({ fieldKey: key, message: 'required. Fill it in first.' });
  }
  return out;
}
