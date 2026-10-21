/**
 * Outlook rules (Graph `messageRule`) as the CRM edits them. Pure; tested.
 *
 * Every predicate and action Graph documents is catalogued here with the
 * control that edits it. A rule is edited as rows — one per predicate or
 * action in use — and turned back into Graph's object on save. Anything in a
 * rule that the catalogue does not know (a newer Graph property, an Outlook
 * desktop extra) is carried through untouched, never dropped: `extra` holds
 * it and `toGraph` writes it back.
 */
import type { Addr } from '../viewTypes';

export type ValueKind = 'words' | 'people' | 'flag' | 'importance' | 'sensitivity' | 'actionFlag' | 'size' | 'folder';

type Entry = { key: string; label: string; kind: ValueKind; hint?: string };

/** "When a message arrives and…" / "Except if…" — Graph's messageRulePredicates. */
export const PREDICATES: readonly Entry[] = [
  { key: 'fromAddresses', label: 'From', kind: 'people' },
  { key: 'sentToAddresses', label: 'Sent to', kind: 'people' },
  { key: 'subjectContains', label: 'Subject includes', kind: 'words' },
  { key: 'bodyContains', label: 'Message body includes', kind: 'words' },
  { key: 'bodyOrSubjectContains', label: 'Subject or body includes', kind: 'words' },
  { key: 'senderContains', label: 'Sender address includes', kind: 'words' },
  { key: 'recipientContains', label: 'Recipient address includes', kind: 'words' },
  { key: 'headerContains', label: 'Message header includes', kind: 'words' },
  { key: 'categories', label: 'Has category', kind: 'words' },
  { key: 'hasAttachments', label: 'Has an attachment', kind: 'flag' },
  { key: 'importance', label: 'Importance is', kind: 'importance' },
  { key: 'sensitivity', label: 'Sensitivity is', kind: 'sensitivity' },
  { key: 'withinSizeRange', label: 'Size is between', kind: 'size', hint: 'KB' },
  { key: 'sentToMe', label: 'I’m on the To line', kind: 'flag' },
  { key: 'sentOnlyToMe', label: 'I’m the only recipient', kind: 'flag' },
  { key: 'sentCcMe', label: 'I’m on the Cc line', kind: 'flag' },
  { key: 'sentToOrCcMe', label: 'I’m on the To or Cc line', kind: 'flag' },
  { key: 'notSentToMe', label: 'I’m not on the To line', kind: 'flag' },
  { key: 'messageActionFlag', label: 'Flagged for action', kind: 'actionFlag' },
  { key: 'isMeetingRequest', label: 'Is a meeting invitation', kind: 'flag' },
  { key: 'isMeetingResponse', label: 'Is a meeting response', kind: 'flag' },
  { key: 'isAutomaticReply', label: 'Is an automatic reply', kind: 'flag' },
  { key: 'isAutomaticForward', label: 'Is automatically forwarded', kind: 'flag' },
  { key: 'isReadReceipt', label: 'Is a read receipt', kind: 'flag' },
  { key: 'isNonDeliveryReport', label: 'Is a non-delivery report', kind: 'flag' },
  { key: 'isEncrypted', label: 'Is encrypted', kind: 'flag' },
  { key: 'isSigned', label: 'Is digitally signed', kind: 'flag' },
  { key: 'isPermissionControlled', label: 'Is permission-controlled', kind: 'flag' },
  { key: 'isApprovalRequest', label: 'Is an approval request', kind: 'flag' },
  { key: 'isVoicemail', label: 'Is a voicemail', kind: 'flag' },
];

/** "Do the following" — Graph's messageRuleActions. */
export const ACTIONS: readonly Entry[] = [
  { key: 'moveToFolder', label: 'Move to folder', kind: 'folder' },
  { key: 'copyToFolder', label: 'Copy to folder', kind: 'folder' },
  { key: 'markAsRead', label: 'Mark as read', kind: 'flag' },
  { key: 'markImportance', label: 'Mark importance', kind: 'importance' },
  { key: 'assignCategories', label: 'Assign categories', kind: 'words' },
  { key: 'forwardTo', label: 'Forward to', kind: 'people' },
  { key: 'forwardAsAttachmentTo', label: 'Forward as attachment to', kind: 'people' },
  { key: 'redirectTo', label: 'Redirect to', kind: 'people' },
  { key: 'delete', label: 'Move to Deleted Items', kind: 'flag' },
  { key: 'permanentDelete', label: 'Delete permanently', kind: 'flag' },
  { key: 'stopProcessingRules', label: 'Stop processing more rules', kind: 'flag' },
];

export const IMPORTANCE = ['low', 'normal', 'high'] as const;
export const SENSITIVITY = ['normal', 'personal', 'private', 'confidential'] as const;
export const ACTION_FLAGS = ['any', 'call', 'doNotForward', 'followUp', 'fyi', 'forward', 'noResponseNecessary', 'read', 'reply', 'replyToAll', 'review'] as const;
export const ACTION_FLAG_LABEL: Record<(typeof ACTION_FLAGS)[number], string> = {
  any: 'Any flag', call: 'Call', doNotForward: 'Do not forward', followUp: 'Follow up', fyi: 'For your information', forward: 'Forward',
  noResponseNecessary: 'No response necessary', read: 'Read', reply: 'Reply', replyToAll: 'Reply to all', review: 'Review',
};

export type RowValue =
  | { kind: 'words'; words: string[] }
  | { kind: 'people'; people: Addr[] }
  | { kind: 'flag' }
  | { kind: 'importance'; value: (typeof IMPORTANCE)[number] }
  | { kind: 'sensitivity'; value: (typeof SENSITIVITY)[number] }
  | { kind: 'actionFlag'; value: (typeof ACTION_FLAGS)[number] }
  | { kind: 'size'; min: number | null; max: number | null }
  | { kind: 'folder'; folderId: string };

export type Row = { key: string; value: RowValue };

export type RuleForm = {
  name: string;
  enabled: boolean;
  conditions: Row[];
  exceptions: Row[];
  actions: Row[];
  /** Properties the catalogue doesn't know, per section — written back as they came. */
  extra: { conditions: Record<string, unknown>; exceptions: Record<string, unknown>; actions: Record<string, unknown> };
};

/** The rule as Graph returns / accepts it (the fields the CRM touches). */
export type GraphRule = {
  id?: string;
  displayName?: string;
  sequence?: number;
  isEnabled?: boolean;
  isReadOnly?: boolean;
  hasError?: boolean;
  conditions?: Record<string, unknown> | null;
  exceptions?: Record<string, unknown> | null;
  actions?: Record<string, unknown> | null;
};

const byKey = (list: readonly Entry[]) => new Map(list.map((e) => [e.key, e]));
const PRED = byKey(PREDICATES);
const ACT = byKey(ACTIONS);

export const entryFor = (section: 'conditions' | 'exceptions' | 'actions', key: string) => (section === 'actions' ? ACT : PRED).get(key);

const asWords = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []);
const asPeople = (v: unknown): Addr[] =>
  Array.isArray(v)
    ? v
        .map((r) => (r as { emailAddress?: { name?: unknown; address?: unknown } })?.emailAddress)
        .filter((e): e is { name?: unknown; address: string } => typeof e?.address === 'string' && e.address !== '')
        .map((e) => ({ name: typeof e.name === 'string' ? e.name : '', address: e.address.toLowerCase() }))
    : [];
const oneOf = <T extends readonly string[]>(list: T, v: unknown): T[number] | null => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T[number]) : null);

/** One Graph property → one editor row, or null when the value can't be shown (kept in `extra`). */
function toRow(entry: Entry, v: unknown): RowValue | null {
  switch (entry.kind) {
    case 'words': {
      const words = asWords(v);
      return words.length ? { kind: 'words', words } : null;
    }
    case 'people': {
      const people = asPeople(v);
      return people.length ? { kind: 'people', people } : null;
    }
    case 'flag':
      return v === true ? { kind: 'flag' } : null;
    case 'importance': {
      const value = oneOf(IMPORTANCE, v);
      return value ? { kind: 'importance', value } : null;
    }
    case 'sensitivity': {
      const value = oneOf(SENSITIVITY, v);
      return value ? { kind: 'sensitivity', value } : null;
    }
    case 'actionFlag': {
      const value = oneOf(ACTION_FLAGS, v);
      return value ? { kind: 'actionFlag', value } : null;
    }
    case 'size': {
      const r = v as { minimumSize?: unknown; maximumSize?: unknown } | null;
      const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.round(x) : null);
      const min = n(r?.minimumSize);
      const max = n(r?.maximumSize);
      return min === null && max === null ? null : { kind: 'size', min, max };
    }
    case 'folder':
      return typeof v === 'string' && v ? { kind: 'folder', folderId: v } : null;
  }
}

function section(obj: Record<string, unknown> | null | undefined, which: 'conditions' | 'exceptions' | 'actions'): { rows: Row[]; extra: Record<string, unknown> } {
  const rows: Row[] = [];
  const extra: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj ?? {})) {
    if (v === null || v === undefined || key.startsWith('@odata')) continue;
    const entry = entryFor(which, key);
    const value = entry ? toRow(entry, v) : null;
    if (entry && value) rows.push({ key, value });
    else if (!entry || (Array.isArray(v) ? v.length > 0 : v !== false)) extra[key] = v;
  }
  // Catalogue order, so the editor reads the same way every time.
  const order = (which === 'actions' ? ACTIONS : PREDICATES).map((e) => e.key);
  rows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  return { rows, extra };
}

export function fromGraph(r: GraphRule): RuleForm {
  const c = section(r.conditions, 'conditions');
  const e = section(r.exceptions, 'exceptions');
  const a = section(r.actions, 'actions');
  return {
    name: r.displayName ?? '',
    enabled: r.isEnabled !== false,
    conditions: c.rows,
    exceptions: e.rows,
    actions: a.rows,
    extra: { conditions: c.extra, exceptions: e.extra, actions: a.extra },
  };
}

const toRecipients = (people: Addr[]) => people.map((p) => ({ emailAddress: { address: p.address, ...(p.name ? { name: p.name } : {}) } }));

function rowToGraph(v: RowValue): unknown {
  switch (v.kind) {
    case 'words':
      return v.words;
    case 'people':
      return toRecipients(v.people);
    case 'flag':
      return true;
    case 'importance':
    case 'sensitivity':
    case 'actionFlag':
      return v.value;
    case 'size':
      return { ...(v.min !== null ? { minimumSize: v.min } : {}), ...(v.max !== null ? { maximumSize: v.max } : {}) };
    case 'folder':
      return v.folderId;
  }
}

/**
 * The Graph body for create/update. Each section is written whole — rows plus
 * the untouched extras — so a removed row really is removed in Outlook.
 * Removed keys are sent as null: Graph's PATCH leaves an absent key as it was.
 */
export function toGraph(form: RuleForm, previous?: GraphRule): GraphRule {
  const build = (rows: Row[], extra: Record<string, unknown>, prev: Record<string, unknown> | null | undefined) => {
    const out: Record<string, unknown> = { ...extra };
    for (const r of rows) out[r.key] = rowToGraph(r.value);
    for (const key of Object.keys(prev ?? {})) if (!(key in out) && !key.startsWith('@odata')) out[key] = null;
    return out;
  };
  return {
    displayName: form.name.trim(),
    isEnabled: form.enabled,
    conditions: build(form.conditions, form.extra.conditions, previous?.conditions),
    exceptions: build(form.exceptions, form.extra.exceptions, previous?.exceptions),
    actions: build(form.actions, form.extra.actions, previous?.actions),
  };
}

/** Problems that block saving, in the words the editor shows. Empty = fine. */
export function validate(form: RuleForm): string[] {
  const out: string[] = [];
  if (!form.name.trim()) out.push('Give the rule a name.');
  if (form.name.trim().length > 256) out.push('Keep the name under 256 characters.');
  if (form.actions.length === 0 && Object.keys(form.extra.actions).length === 0) out.push('Add at least one action.');
  const check = (rows: Row[], where: string) => {
    for (const r of rows) {
      const label = (entryFor(where === 'action' ? 'actions' : 'conditions', r.key)?.label ?? r.key).toLowerCase();
      const v = r.value;
      if (v.kind === 'words' && v.words.length === 0) out.push(`Add at least one word for “${label}”.`);
      if (v.kind === 'people' && v.people.length === 0) out.push(`Add at least one address for “${label}”.`);
      if (v.kind === 'folder' && !v.folderId) out.push(`Choose a folder for “${label}”.`);
      if (v.kind === 'size' && v.min === null && v.max === null) out.push(`Give a size for “${label}”.`);
      if (v.kind === 'size' && v.min !== null && v.max !== null && v.min > v.max) out.push(`The smallest size can’t be more than the largest.`);
    }
  };
  check(form.conditions, 'condition');
  check(form.exceptions, 'exception');
  check(form.actions, 'action');
  const keys = new Set(form.actions.map((a) => a.key));
  if (keys.has('delete') && keys.has('permanentDelete')) out.push('Choose either “Move to Deleted Items” or “Delete permanently”, not both.');
  return out;
}

/** A blank value for a newly added row. */
export function blankValue(kind: ValueKind): RowValue {
  switch (kind) {
    case 'words':
      return { kind, words: [] };
    case 'people':
      return { kind, people: [] };
    case 'flag':
      return { kind };
    case 'importance':
      return { kind, value: 'high' };
    case 'sensitivity':
      return { kind, value: 'confidential' };
    case 'actionFlag':
      return { kind, value: 'any' };
    case 'size':
      return { kind, min: null, max: null };
    case 'folder':
      return { kind, folderId: '' };
  }
}

/** One line describing a rule, for the list ("From ann@… → Move to Clients"). */
export function summary(form: RuleForm, folderName: (id: string) => string): string {
  const describe = (r: Row, section: 'conditions' | 'actions') => {
    const label = entryFor(section, r.key)?.label ?? r.key;
    const v = r.value;
    switch (v.kind) {
      case 'words':
        return `${label} “${v.words.slice(0, 2).join('”, “')}”${v.words.length > 2 ? ` +${v.words.length - 2}` : ''}`;
      case 'people':
        return `${label} ${v.people.slice(0, 2).map((p) => p.name || p.address).join(', ')}${v.people.length > 2 ? ` +${v.people.length - 2}` : ''}`;
      case 'folder':
        return `${label.replace(' folder', '')} ${folderName(v.folderId)}`;
      case 'importance':
      case 'sensitivity':
        return `${label} ${v.value}`;
      case 'actionFlag':
        return `${label}: ${ACTION_FLAG_LABEL[v.value]}`;
      case 'size':
        return `${label} ${v.min ?? 0}–${v.max ?? '∞'} KB`;
      case 'flag':
        return label;
    }
  };
  const when = form.conditions.length ? form.conditions.map((r) => describe(r, 'conditions')).join(' and ') : 'Every message';
  const then = form.actions.map((r) => describe(r, 'actions')).join(', ') || 'No action TapDash can show';
  return `${when} → ${then}`;
}

/**
 * New `sequence` numbers for a reordered list (top first). Outlook won't let
 * the API change a read-only rule at all — its number included — so those
 * keep theirs and the others are fitted around them, renumbering only what
 * has to move. When a read-only rule leaves no room (the list asks for two
 * rules between 4 and 5), the answer names it instead.
 */
export function planSequences(
  order: string[],
  current: ReadonlyMap<string, { sequence: number; readOnly: boolean }>,
): { changes: Array<{ id: string; sequence: number }> } | { blockedBy: string } {
  const out: Array<{ id: string; sequence: number }> = [];
  let prev = 0;
  for (const [i, id] of order.entries()) {
    const r = current.get(id)!;
    if (r.readOnly) {
      if (r.sequence <= prev) return { blockedBy: id };
      prev = r.sequence;
      continue;
    }
    const nextFixed = order.slice(i + 1).find((x) => current.get(x)!.readOnly);
    const ceiling = nextFixed ? current.get(nextFixed)!.sequence : Infinity;
    // Keep its number when it already fits; otherwise the smallest that does.
    const want = r.sequence > prev && r.sequence < ceiling ? r.sequence : prev + 1;
    if (want >= ceiling) return { blockedBy: nextFixed! };
    if (want !== r.sequence) out.push({ id, sequence: want });
    prev = want;
  }
  return { changes: out };
}
