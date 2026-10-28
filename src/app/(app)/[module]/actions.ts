'use server';

/**
 * Server actions for a display module's dashboard + drawer.
 *
 * Each is a thin shell: authorize, call the data layer, revalidate. All rules
 * live in `lib/records/*` — this file's only job is translating a form
 * submission into a call and a redirect/revalidate, the same shape
 * `(auth)/actions.ts` already established.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { z } from 'zod';
import {
  mentionCandidates,
  myRecentFieldChange,
  mentionOnField,
  recordMentions,
  isMuted,
  setMuted,
  type Candidate,
  type RecentChange,
  type NotificationView,
} from '@/lib/records/notifications';
import { deliverMentionEmails, notificationIdsFor } from '@/lib/notifications/email';
import { authorize, fieldGrant } from '@/lib/records/permissions';
import { loadConfig, fieldByKey, fieldsInRepeatGroup, moduleBySlug, columnsForModule, type Field } from '@/lib/records/config';
// Plain values, deliberately NOT declared in this file — see the header of
// `fieldValueCodec.ts`: a 'use server' module may export only async
// functions, and breaking that rule 500s every action on the page.
import { decodeFieldValue } from './fieldValueCodec';
import { createRecordSchema } from '@/lib/records/recordSchemas';
import { firstIssueMessage } from '@/lib/records/adminSchemas';
import { createRecord, setValue, setValues, getRecord, deleteRecord, restoreRecord, bulkSetValue, describeDuplicate, type SkipReport, type ValueChange } from '@/lib/records/records';
import { addRepeatInstance, removeRepeatInstance, type RepeatMutationResult } from '@/lib/records/repeatGroups';
import { setMemberships, membershipsFor, toggleMembership } from '@/lib/records/memberships';
import { setPipelineStep, clearPipeline } from '@/lib/records/pipelines';
import { addNote, editNote, deleteNote } from '@/lib/records/notes';
import { createCase, addReply, setCaseState, setCaseSolution, setCaseHandlingNote, deleteCase, closeOpenCases } from '@/lib/records/cases';
import { addUpdate, editUpdate, deleteUpdate } from '@/lib/records/updates';
import { grantItemAccess, revokeItemAccess, setReplyHidden } from '@/lib/records/itemAccess';
import { uploadFile, uploadFieldFile, deleteFile, addFileRow, ensureApplicationRows, signedUrlFor } from '@/lib/records/files';
import { attachToCase } from '@/lib/records/caseAttachments';
import { addLogin, setPassword, revealPassword } from '@/lib/records/logins';
import { uploadStatement, deleteStatement, signedStatementUrlFor } from '@/lib/records/statements';
import {
  setColumnOrder, resetColumnOrder, setFieldOrder, resetFieldOrder,
  setColumnVisibility, resetColumnVisibility,
  setFilters as saveFilters, clearFilters as clearSavedFilters,
} from '@/lib/records/preferences';
import type { ListFilter } from '@/lib/records/records';

export type ActionState = {
  ok: boolean;
  message?: string;
  /** Set only on a duplicate Deal Name, and only when this user is allowed to
   *  be told WHICH record is blocking (Modules Amendment 2). The dialog turns
   *  it into a link; its absence is the disclosure gate, not a missing lookup. */
  blockedBy?: { id: string; dealName: string };
};

/**
 * `setValueAction`'s own result, deliberately NOT the shared `ActionState`.
 *
 * A successful value write MUST hand back the row's new `updated_at`, because
 * that timestamp is the optimistic-concurrency token the caller has to send
 * with its next edit. Returning a bare `{ ok: true }` left the client
 * fabricating one from its own clock, which never matches the server's `now()`
 * — so the second edit of any field was rejected as a phantom conflict. Typing
 * it as a union rather than an optional field means a future caller cannot
 * quietly ignore it again.
 */
export type SetValueState =
  | { ok: true; updatedAt: string }
  /** `conflict` is present only for a lost compare-and-swap, and carries the
   *  token the row holds now. `RealFieldGrid` uses it to retry ONCE when the
   *  conflicting token is one of its own (a write it made itself, whose token
   *  it had not caught up to) — see `recordVersion.ts`. A refusal has no
   *  `conflict`, because re-submitting a refused value cannot help. */
  | { ok: false; message: string; conflict?: { currentUpdatedAt: string } };

/**
 * Create a record and land directly in its drawer. Duplicate-blocked on Deal
 * Name — the database is the actual gate, this just turns the resulting
 * `{ error: 'duplicate' }` into a message.
 */
export async function createRecordAction(moduleSlug: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await authorize();

  // `getAll` rather than one JSON string: the picker submits a real checkbox
  // group, so the browser's own encoding is already the right shape and there is
  // nothing to hand-parse. Zod rejects anything that is not a uuid before it
  // reaches the team-member check below it.
  const parsed = createRecordSchema.safeParse({
    dealName: formData.get('dealName'),
    memberIds: formData.getAll('memberIds'),
  });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const config = await loadConfig();
  const target = config.modules.find((m) => m.slug === moduleSlug);
  if (!target) return { ok: false, message: 'Unknown module.' };

  const result = await createRecord(ctx, parsed.data.dealName, [target.id], parsed.data.memberIds);
  if ('error' in result) {
    if (result.error !== 'duplicate') return { ok: false, message: result.message };

    /*
     * Modules Amendment 2 — the block is system-wide, the DISCLOSURE is not.
     * "A record with this Deal Name already exists" told the user nothing they
     * could act on, and the client asked for better in both directions: name
     * and link the blocker when the user may see it, and say only "contact an
     * administrator" when they may not. `describeDuplicate` decides which.
     */
    const block = await describeDuplicate(ctx, parsed.data.dealName);
    return { ok: false, message: block.message, blockedBy: block.record ?? undefined };
  }

  revalidatePath(`/${moduleSlug}`);
  redirect(`/${moduleSlug}?record=${result.id}`);
}

/**
 * One field, one value — compare-and-swap. `expectedUpdatedAt` travels as a
 * hidden form field carrying the timestamp the page was rendered with, so a
 * stale submission is rejected rather than silently overwriting a change
 * made in between (SCHEMA-DECISIONS §5, MODULE-2-PLAN §13.4).
 */

export async function setValueAction(
  moduleSlug: string,
  recordId: string,
  fieldKey: string,
  formData: FormData,
): Promise<SetValueState> {
  const ctx = await authorize();
  const config = await loadConfig();
  const field = fieldByKey(config, fieldKey);
  if (!field) return { ok: false, message: 'Unknown field.' };

  const raw = formData.get('value');
  const expectedUpdatedAt = String(formData.get('expectedUpdatedAt') ?? '');
  let value: unknown = null;
  if (raw !== null && raw !== '') {
    const decoded = decodeFieldValue(field, String(raw));
    if (!decoded.ok) return { ok: false, message: `That is not a valid ${field.label}.` };
    value = decoded.value;
  }

  const result = await setValue(ctx, recordId, field, value, expectedUpdatedAt);

  // Deliberately no `revalidatePath` here. `RealFieldGrid.tsx`'s `handleChange`
  // already shows the new value optimistically and rolls back on failure —
  // this action's ONLY job the caller waits on is the CAS result itself. A
  // `revalidatePath` call forces Next to recompute this whole route (the
  // dashboard list AND, if a drawer is open, its full 14+-query fetch chain)
  // as part of THIS action's own response before it can resolve — measured
  // at ~1.9s in a production build, for a value that was already on screen.
  // It also delayed `updatedAt` advancing, so a second fast edit reused a
  // stale `expectedUpdatedAt` and could be spuriously rejected as a conflict
  // — a correctness cost, not just a perceived one. That is exactly why the
  // real `updated_at` is returned below instead: dropping the revalidate is
  // only safe if the caller is handed the new token directly. The trade-off: the tab's
  // field-completeness badge and a visible dashboard column showing this
  // field go a little stale until the next natural reload/navigation,
  // instead of staying live-synced — a deliberate, minor cosmetic cost for a
  // ~10x latency win on the single most frequent interaction in the drawer.
  if (!result.ok) {
    // Two different failures, worded differently on purpose. A REFUSAL is about
    // the value ("that is not someone here") and re-submitting will not help; a
    // lost compare-and-swap is about timing, and the message names what the
    // field holds now so the loser can decide (§13.4).
    if ('refused' in result) return { ok: false, message: result.refused };
    return {
      ok: false,
      message: `Someone else changed this a moment ago — current value: ${String(result.currentValue ?? '(empty)')}`,
      conflict: { currentUpdatedAt: result.currentUpdatedAt },
    };
  }
  return { ok: true, updatedAt: result.updatedAt };
}

/**
 * Several fields at once — ONE request, one compare-and-swap.
 *
 * The drawer coalesces edits made close together and sends them here instead of
 * calling `setValueAction` once per field. That call was already cheap on the
 * server; the cost was the REQUEST — the proxy's session check and
 * `authorize()`'s user validation are paid per call, and both are network round
 * trips to the auth server. Five fields meant five of them, serialised, which
 * measured over ten seconds end to end.
 *
 * `setValueAction` above is kept: it is the single-field path, and one edit
 * should not pay for a batching protocol it does not need.
 *
 * Deliberately no `revalidatePath`, for exactly the reasons spelled out on
 * `setValueAction` — the values are already on screen, and the caller is handed
 * the new compare-and-swap token directly.
 */
export async function setValuesAction(
  moduleSlug: string,
  recordId: string,
  input: { fieldKey: string; value: string | null }[],
  expectedUpdatedAt: string,
): Promise<SetValueState> {
  const ctx = await authorize();
  const config = await loadConfig();

  if (!input.length) return { ok: false, message: 'Nothing to save.' };

  const changes: ValueChange[] = [];
  for (const item of input) {
    const field = fieldByKey(config, item.fieldKey);
    if (!field) return { ok: false, message: 'Unknown field.' };
    // Same encoding contract as the single-field path: the client sends the
    // value as a string (or null for cleared), and the field's own type decides
    // how to read it back.
    let value: unknown = null;
    if (item.value !== null && item.value !== '') {
      const decoded = decodeFieldValue(field, item.value);
      if (!decoded.ok) return { ok: false, message: `That is not a valid ${field.label}.` };
      value = decoded.value;
    }
    changes.push({ field, value });
  }

  const result = await setValues(ctx, recordId, changes, expectedUpdatedAt);

  if (!result.ok) {
    if ('refused' in result) return { ok: false, message: result.refused };
    const names = Object.keys(result.currentValues)
      .map((k) => fieldByKey(config, k)?.label ?? k)
      .join(', ');
    return {
      ok: false,
      message: `Someone else changed this record a moment ago — ${names} were not saved.`,
      conflict: { currentUpdatedAt: result.currentUpdatedAt },
    };
  }
  return { ok: true, updatedAt: result.updatedAt };
}

export async function setMembershipsAction(moduleSlug: string, recordId: string, formData: FormData): Promise<void> {
  const ctx = await authorize();
  const moduleIds = formData.getAll('moduleId').map(String);
  await setMemberships(ctx, recordId, moduleIds);
  revalidatePath(`/${moduleSlug}`);
}

/** One click, one module — the "In modules" chip row toggles immediately,
 * no separate Update button, matching the drawer's actual designed
 * interaction. */
export async function toggleMembershipAction(
  moduleSlug: string,
  recordId: string,
  targetModuleId: string,
  on: boolean,
): Promise<void> {
  const ctx = await authorize();
  await toggleMembership(ctx, recordId, targetModuleId, on);
  revalidatePath(`/${moduleSlug}`);
}

export async function setPipelineStepAction(
  moduleSlug: string,
  recordId: string,
  moduleId: string,
  pipelineId: string,
  stepId: string,
): Promise<void> {
  const ctx = await authorize();
  await setPipelineStep(ctx, recordId, moduleId, pipelineId, stepId);
  revalidatePath(`/${moduleSlug}`);
}

export async function clearPipelineAction(moduleSlug: string, recordId: string, moduleId: string): Promise<void> {
  const ctx = await authorize();
  await clearPipeline(ctx, recordId, moduleId);
  revalidatePath(`/${moduleSlug}`);
}

/** Archive is "uncheck every module" — the same action as setMembershipsAction
 * with an empty list, exposed separately since the drawer's Archive button
 * needs a one-click confirmed path rather than a full checkbox form. */
export async function archiveRecordAction(moduleSlug: string, recordId: string): Promise<void> {
  const ctx = await authorize();
  await setMemberships(ctx, recordId, []);
  revalidatePath(`/${moduleSlug}`);
}

export async function deleteRecordAction(recordId: string): Promise<ActionState> {
  const ctx = await authorize();
  try {
    await deleteRecord(ctx, recordId);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not delete.' };
  }
  revalidatePath('/records');
  redirect('/records');
}

export async function restoreRecordAction(recordId: string): Promise<void> {
  const ctx = await authorize();
  await restoreRecord(ctx, recordId);
  revalidatePath('/admin/recycle-bin');
  revalidatePath('/records');
}

export async function addNoteAction(
  moduleSlug: string,
  recordId: string,
  scopeKind: 'field' | 'tab',
  scopeId: string,
  formData: FormData,
): Promise<void> {
  const ctx = await authorize();
  const body = String(formData.get('body') ?? '').trim();
  if (body) await addNote(ctx, recordId, scopeKind, scopeId, body);
  revalidatePath(`/${moduleSlug}`);
}

export async function editNoteAction(moduleSlug: string, noteId: string, body: string): Promise<ActionState> {
  const ctx = await authorize();
  try {
    await editNote(ctx, noteId, body);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save.' };
  }
  revalidatePath(`/${moduleSlug}`);
  return { ok: true };
}

export async function deleteNoteAction(moduleSlug: string, noteId: string): Promise<void> {
  const ctx = await authorize();
  await deleteNote(ctx, noteId);
  revalidatePath(`/${moduleSlug}`);
}

export async function createCaseAction(
  moduleSlug: string,
  recordId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await authorize();
  const title = String(formData.get('title') ?? '').trim();
  const issue = String(formData.get('issue') ?? '').trim();
  if (!title || !issue) return { ok: false, message: 'Title and Issue are both required.' };

  await createCase(ctx, recordId, title, issue, []);
  revalidatePath(`/${moduleSlug}`);
  return { ok: true };
}

/**
 * Returns an `ActionState`, like `setCaseStateAction` and
 * `setCaseSolutionAction` beside it.
 *
 * It used to return void and let a refusal throw. `addReply` goes through
 * `requireTabEdit`, so a viewer without Cases = Edit hits a real exception —
 * and with nothing catching it the reply simply did not send, the spinner
 * stopped, the draft stayed in the box and NOTHING said why. Its two siblings
 * already reported their failures; this one was the outlier.
 */
export async function addCaseReplyAction(
  moduleSlug: string,
  caseId: string,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await authorize();
  const body = String(formData.get('body') ?? '').trim();
  if (!body) return { ok: false, message: 'Write a reply first.' };

  let posted: { id: string; mentioned: string[] };
  try {
    posted = await addReply(ctx, caseId, body, mentionIdsFrom(formData.get('mentions')));
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not send that reply.' };
  }
  if (posted.mentioned.length) emailMentions({ caseReplyId: posted.id });

  revalidatePath(`/${moduleSlug}`);
  return { ok: true };
}

export async function setCaseStateAction(moduleSlug: string, caseId: string, close: boolean): Promise<ActionState> {
  const ctx = await authorize();
  try {
    await setCaseState(ctx, caseId, close);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not change state.' };
  }
  revalidatePath(`/${moduleSlug}`);
  return { ok: true };
}

/** Admin-only; the case and its replies move to the Recycle Bin. */
export async function deleteCaseAction(moduleSlug: string, caseId: string): Promise<ActionState> {
  const ctx = await authorize();
  try {
    await deleteCase(ctx, caseId);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not delete that case.' };
  }
  revalidatePath(`/${moduleSlug}`);
  return { ok: true };
}

export async function setCaseSolutionAction(moduleSlug: string, caseId: string, solution: string): Promise<ActionState> {
  const ctx = await authorize();
  try {
    await setCaseSolution(ctx, caseId, solution);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save.' };
  }
  revalidatePath(`/${moduleSlug}`);
  return { ok: true };
}

/* -----------------------------------------------------------------------
 * Personalization — 19 Aug amendment. Called directly from client code
 * (not bound to a <form>), so the caller does `await action(); router.
 * refresh()` — the standard imperative-server-action shape for state that
 * isn't itself a form submission.
 * --------------------------------------------------------------------- */

/**
 * `orderedFieldKeys` are the prototype's own `Field.id` — which, per
 * `adaptFieldForDashboard`'s deliberate identity choice, IS the field's
 * `key` (citext), not its real database `uuid`. `user_column_order.field_id`
 * is a `uuid references fields(id)` column (migration 8), so writing a key
 * straight through (e.g. "current_status") fails at the database with
 * Postgres 22P02 `invalid_text_representation` — the column-drag-reorder
 * crash. This resolves each key back to its real field id before the write;
 * an unknown key (a stale/removed field) is dropped rather than crashing.
 */
export async function reorderColumnsAction(moduleSlug: string, orderedFieldKeys: string[]): Promise<void> {
  const ctx = await authorize();
  const config = await loadConfig();
  const mod = moduleBySlug(config, moduleSlug);
  if (!mod) return;
  const idByKey = new Map(config.fields.map((f) => [f.key, f.id]));
  const orderedFieldIds = orderedFieldKeys.map((k) => idByKey.get(k)).filter((id): id is string => Boolean(id));
  await setColumnOrder(ctx, mod.id, orderedFieldIds);
  revalidatePath(`/${moduleSlug}`);
}

export async function resetColumnOrderAction(moduleSlug: string): Promise<void> {
  const ctx = await authorize();
  const config = await loadConfig();
  const mod = moduleBySlug(config, moduleSlug);
  if (!mod) return;
  await resetColumnOrder(ctx, mod.id);
  revalidatePath(`/${moduleSlug}`);
}

/** Show or hide one list column for this user only (UI/UX spec §6). The key
 *  must be one of the module's configured columns — anything else is ignored. */
export async function setColumnVisibilityAction(moduleSlug: string, fieldKey: string, visible: boolean): Promise<void> {
  const ctx = await authorize();
  const config = await loadConfig();
  const mod = moduleBySlug(config, moduleSlug);
  if (!mod) return;
  const field = columnsForModule(config, mod.id).find((f) => f.key === fieldKey);
  if (!field || typeof visible !== 'boolean') return;
  await setColumnVisibility(ctx, mod.id, field.id, visible);
  revalidatePath(`/${moduleSlug}`);
}

export async function resetColumnVisibilityAction(moduleSlug: string): Promise<void> {
  const ctx = await authorize();
  const config = await loadConfig();
  const mod = moduleBySlug(config, moduleSlug);
  if (!mod) return;
  await resetColumnVisibility(ctx, mod.id);
  revalidatePath(`/${moduleSlug}`);
}

/** Same key→id translation as `reorderColumnsAction` above, and for the same
 * reason: `user_field_order.field_id` is also `uuid references fields(id)`,
 * and the drawer's field grid hands this the prototype's key-shaped ids. */
export async function reorderFieldsAction(moduleSlug: string, tabId: string, subtabId: string | null, orderedFieldKeys: string[]): Promise<void> {
  const ctx = await authorize();
  const config = await loadConfig();
  const idByKey = new Map(config.fields.map((f) => [f.key, f.id]));
  const orderedFieldIds = orderedFieldKeys.map((k) => idByKey.get(k)).filter((id): id is string => Boolean(id));
  await setFieldOrder(ctx, tabId, subtabId, orderedFieldIds);
  revalidatePath(`/${moduleSlug}`);
}

export async function resetFieldOrderAction(moduleSlug: string, tabId: string, subtabId: string | null): Promise<void> {
  const ctx = await authorize();
  await resetFieldOrder(ctx, tabId, subtabId);
  revalidatePath(`/${moduleSlug}`);
}

export async function setFiltersAction(moduleSlug: string, filters: Record<string, ListFilter>): Promise<void> {
  const ctx = await authorize();
  const config = await loadConfig();
  const mod = moduleBySlug(config, moduleSlug);
  if (!mod) return;
  await saveFilters(ctx, mod.id, filters);
  revalidatePath(`/${moduleSlug}`);
}

export async function clearFiltersAction(moduleSlug: string): Promise<void> {
  const ctx = await authorize();
  const config = await loadConfig();
  const mod = moduleBySlug(config, moduleSlug);
  if (!mod) return;
  await clearSavedFilters(ctx, mod.id);
  revalidatePath(`/${moduleSlug}`);
}

/* -----------------------------------------------------------------------
 * Bulk edit / archive / delete — always skip-and-report (MODULE-2-PLAN
 * §5.1: "the type has no shape in which skipped work is silently dropped").
 * --------------------------------------------------------------------- */

export async function bulkEditAction(
  moduleSlug: string,
  recordIds: string[],
  fieldKey: string,
  value: unknown,
): Promise<SkipReport> {
  const ctx = await authorize();
  const config = await loadConfig();
  const field = fieldByKey(config, fieldKey);
  if (!field) return { applied: [], skipped: recordIds.map((id) => ({ id, reason: 'Unknown field' })) };

  const grant = await fieldGrant(ctx, field);
  if (grant !== 'edit') {
    return { applied: [], skipped: recordIds.map((id) => ({ id, reason: `No edit access to ${field.label}` })) };
  }

  const report = await bulkSetValue(ctx, recordIds, field, value);
  revalidatePath(`/${moduleSlug}`);
  return report;
}

export async function bulkArchiveAction(moduleSlug: string, recordIds: string[]): Promise<SkipReport> {
  const ctx = await authorize();
  const applied: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of recordIds) {
    try {
      await setMemberships(ctx, id, []);
      applied.push(id);
    } catch (e) {
      skipped.push({ id, reason: e instanceof Error ? e.message : 'Could not archive' });
    }
  }
  revalidatePath(`/${moduleSlug}`);
  return { applied, skipped };
}

/** Records List only: adds a module back onto every selected already-archived
 * record — the bulk counterpart to the drawer's per-record "IN MODULES" pill
 * toggle, for records that lost every membership via bulk archive. */
export async function bulkRestoreToModuleAction(targetModuleId: string, recordIds: string[]): Promise<SkipReport> {
  const ctx = await authorize();
  const applied: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of recordIds) {
    try {
      const current = await membershipsFor(ctx, id);
      if (!current.includes(targetModuleId)) await setMemberships(ctx, id, [...current, targetModuleId]);
      applied.push(id);
    } catch (e) {
      skipped.push({ id, reason: e instanceof Error ? e.message : 'Could not restore' });
    }
  }
  revalidatePath('/records');
  return { applied, skipped };
}

export async function bulkRemoveFromModuleAction(
  moduleSlug: string,
  moduleId: string,
  recordIds: string[],
): Promise<SkipReport> {
  const ctx = await authorize();
  const applied: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of recordIds) {
    try {
      const current = await membershipsFor(ctx, id);
      await setMemberships(ctx, id, current.filter((m) => m !== moduleId));
      applied.push(id);
    } catch (e) {
      skipped.push({ id, reason: e instanceof Error ? e.message : 'Could not remove' });
    }
  }
  revalidatePath(`/${moduleSlug}`);
  return { applied, skipped };
}

const BulkCloseCases = z.object({
  recordIds: z.array(z.uuid()).min(1).max(200),
  solution: z.string().trim().min(1, 'Write what resolved the cases.').max(2000),
});

/**
 * A module that shows open cases has no Remove: a record is there exactly
 * while a case is open, so the way out is closing its cases. One solution
 * text is written to every open case that lacks one, then each is closed;
 * the trigger from migration 9764 takes the record out of the module.
 */
export async function bulkCloseCasesAction(moduleSlug: string, recordIds: string[], solution: string): Promise<SkipReport> {
  const ctx = await authorize();
  const parsed = BulkCloseCases.safeParse({ recordIds, solution });
  if (!parsed.success) {
    return { applied: [], skipped: recordIds.map((id) => ({ id, reason: parsed.error.issues[0]?.message ?? 'Invalid request' })) };
  }
  const result = await closeOpenCases(ctx, parsed.data.recordIds, parsed.data.solution);
  revalidatePath(`/${moduleSlug}`);
  return result;
}

export async function bulkDeleteAction(recordIds: string[]): Promise<SkipReport> {
  const ctx = await authorize();
  const applied: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of recordIds) {
    try {
      await deleteRecord(ctx, id);
      applied.push(id);
    } catch (e) {
      // "Archive this record before deleting it" — the database's own refusal.
      skipped.push({ id, reason: e instanceof Error ? e.message : 'Could not delete' });
    }
  }
  revalidatePath('/records');
  return { applied, skipped };
}

/** The ids the @ picker recorded, carried in the form as JSON. Anything
 *  malformed is simply no mentions — the body still posts. */
const MentionIds = z.array(z.uuid()).max(50);
function mentionIdsFrom(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = MentionIds.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** One email per new mention, after the response has gone. */
function emailMentions(target: Parameters<typeof notificationIdsFor>[0]) {
  after(async () => {
    try {
      await deliverMentionEmails(await notificationIdsFor(target));
    } catch (e) {
      console.error('[mentions] email delivery failed', e instanceof Error ? e.message.slice(0, 200) : 'unknown');
    }
  });
}

export async function addUpdateAction(
  moduleSlug: string,
  recordId: string,
  parentId: string | null,
  formData: FormData,
): Promise<void> {
  const ctx = await authorize();
  const body = String(formData.get('body') ?? '').trim();
  if (body) {
    const { id, mentioned } = await addUpdate(ctx, recordId, body, parentId ?? undefined, mentionIdsFrom(formData.get('mentions')));
    if (mentioned.length) emailMentions({ updateId: id });
  }
  revalidatePath(`/${moduleSlug}`);
}

export async function editUpdateAction(
  moduleSlug: string,
  updateId: string,
  body: string,
  mentionedUserIds: string[] = [],
): Promise<ActionState> {
  const ctx = await authorize();
  const ids = MentionIds.safeParse(mentionedUserIds);
  try {
    await editUpdate(ctx, updateId, body, ids.success ? ids.data : []);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save.' };
  }
  emailMentions({ updateId });
  revalidatePath(`/${moduleSlug}`);
  return { ok: true };
}

export async function mentionCandidatesAction(input: { recordId: string; scope: string }): Promise<Candidate[]> {
  const parsed = z.object({ recordId: z.uuid(), scope: z.string().regex(/^(updates|cases|field:[a-z0-9_]{1,80})$/) }).safeParse(input);
  if (!parsed.success) return [];
  const ctx = await authorize();
  try {
    return await mentionCandidates(ctx, parsed.data.recordId, parsed.data.scope as Parameters<typeof mentionCandidates>[2]);
  } catch {
    return [];
  }
}

/** Everything the field's @ box needs when it opens. */
export async function fieldMentionContextAction(input: { recordId: string; fieldKey: string }): Promise<{ candidates: Candidate[]; recentChange: RecentChange }> {
  const parsed = z.object({ recordId: z.uuid(), fieldKey: z.string().regex(/^[a-z0-9_]{1,80}$/) }).safeParse(input);
  if (!parsed.success) return { candidates: [], recentChange: null };
  const ctx = await authorize();
  try {
    const [candidates, recentChange] = await Promise.all([
      mentionCandidates(ctx, parsed.data.recordId, `field:${parsed.data.fieldKey}`),
      myRecentFieldChange(ctx, parsed.data.recordId, parsed.data.fieldKey),
    ]);
    return { candidates, recentChange };
  } catch {
    return { candidates: [], recentChange: null };
  }
}

const FieldMention = z.object({
  recordId: z.uuid(),
  fieldKey: z.string().regex(/^[a-z0-9_]{1,80}$/),
  userIds: z.array(z.uuid()).min(1).max(50),
  note: z.string().max(500).nullable(),
  includePrevious: z.boolean(),
});

export async function fieldMentionAction(input: z.input<typeof FieldMention>): Promise<ActionState & { sent?: number }> {
  const parsed = FieldMention.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Choose at least one person; the note can be up to 500 characters.' };
  const ctx = await authorize();
  const since = new Date().toISOString();
  let sent = 0;
  try {
    sent = await mentionOnField(ctx, { ...parsed.data, note: parsed.data.note?.trim() || null });
  } catch (e) {
    return { ok: false, message: e instanceof Error && /not found/.test(e.message) ? 'That field is no longer available.' : 'Could not send that mention.' };
  }
  if (sent > 0) emailMentions({ recordId: parsed.data.recordId, fieldKey: parsed.data.fieldKey, since });
  return { ok: true, sent };
}

export async function recordMentionsAction(input: { recordId: string }): Promise<NotificationView[]> {
  const parsed = z.object({ recordId: z.uuid() }).safeParse(input);
  if (!parsed.success) return [];
  const ctx = await authorize();
  try {
    return await recordMentions(ctx, parsed.data.recordId);
  } catch {
    return [];
  }
}

export async function muteRecordAction(input: { recordId: string; muted: boolean }): Promise<ActionState & { muted?: boolean }> {
  const parsed = z.object({ recordId: z.uuid(), muted: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Could not change that.' };
  const ctx = await authorize();
  try {
    await setMuted(ctx, parsed.data.recordId, parsed.data.muted);
    return { ok: true, muted: await isMuted(ctx, parsed.data.recordId) };
  } catch {
    return { ok: false, message: 'Could not change that.' };
  }
}

export async function deleteUpdateAction(moduleSlug: string, updateId: string): Promise<void> {
  const ctx = await authorize();
  await deleteUpdate(ctx, updateId);
  revalidatePath(`/${moduleSlug}`);
}

/* -----------------------------------------------------------------------
 * Files
 * --------------------------------------------------------------------- */

export type UploadResult = { ok: boolean; message?: string };

export async function uploadFileAction(
  moduleSlug: string,
  recordId: string,
  fileRowId: string,
  fileRowKind: 'application' | 'other',
  formData: FormData,
): Promise<UploadResult> {
  const ctx = await authorize();
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: 'Choose a file first.' };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await uploadFile(ctx, recordId, { id: fileRowId, kind: fileRowKind }, {
    name: file.name,
    bytes,
    contentType: file.type || 'application/octet-stream',
  });

  revalidatePath(`/${moduleSlug}`);

  if (!result.ok) {
    return {
      ok: false,
      message: result.error === 'too_large' ? 'That file is over the 25MB limit.' : 'This row already holds 5 files.',
    };
  }
  return { ok: true };
}

/**
 * Attach a file to a Files FIELD (UI/UX spec §4). The field's own grant
 * decides, in the database — not the Files tab's.
 */
export async function uploadFieldFileAction(
  moduleSlug: string,
  recordId: string,
  fieldKey: string,
  formData: FormData,
): Promise<UploadResult> {
  const ctx = await authorize();
  const parsedKey = fieldKeySchema.safeParse(fieldKey);
  if (!parsedKey.success) return { ok: false, message: 'That field is not valid.' };
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: 'Choose a file first.' };

  const bytes = new Uint8Array(await file.arrayBuffer());
  let result;
  try {
    result = await uploadFieldFile(ctx, recordId, parsedKey.data, {
      name: file.name,
      bytes,
      contentType: file.type || 'application/octet-stream',
    });
  } catch {
    return { ok: false, message: 'You cannot attach files to this field.' };
  }

  revalidatePath(`/${moduleSlug}`);
  if (!result.ok) {
    return { ok: false, message: result.error === 'too_large' ? 'That file is over the 25MB limit.' : 'This field already holds 5 files.' };
  }
  return { ok: true };
}

/** A field key as it arrives from the browser: lower-case, digits, underscores. */
const fieldKeySchema = z.string().trim().regex(/^[a-z][a-z0-9_]{0,59}$/);

/**
 * Attach a file to a case's Issue, Solution or one reply — Modules §3.7.
 *
 * A separate action from `uploadFileAction` because the ATTACHMENT POINT is
 * addressed differently: the Files tab has a row id already, a case has a place
 * (issue / solution / this reply) and the row is created for it on demand. The
 * upload underneath is the same one, so the five-file cap, the 25MB ceiling,
 * versioning, the Recycle Bin and the activity-log entry are all inherited
 * rather than repeated here.
 *
 * `deleteFileAction` above already removes one of these — a case attachment is
 * an ordinary `files` row — so there is no matching delete action to add.
 */
export async function attachToCaseAction(
  moduleSlug: string,
  caseId: string,
  point: 'issue' | 'solution' | 'reply',
  replyId: string | null,
  formData: FormData,
): Promise<UploadResult> {
  const ctx = await authorize();

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: 'Choose a file first.' };

  // A reply attachment without its reply, or a non-reply attachment carrying
  // one, is a request that cannot be honoured — refused here rather than sent
  // to the database to be refused there with a less useful sentence.
  if ((point === 'reply') !== Boolean(replyId)) {
    return { ok: false, message: 'That attachment point is not valid.' };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await attachToCase(
    ctx,
    caseId,
    point === 'reply' ? { kind: 'reply', replyId: replyId! } : { kind: point },
    { name: file.name, bytes, contentType: file.type || 'application/octet-stream' },
  );

  revalidatePath(`/${moduleSlug}`);

  if (!result.ok) {
    return {
      ok: false,
      message:
        result.error === 'too_large'
          ? 'That file is over the 25MB limit.'
          : 'This attachment point already holds 5 files.',
    };
  }
  return { ok: true };
}

export async function deleteFileAction(moduleSlug: string, fileId: string): Promise<void> {
  const ctx = await authorize();
  await deleteFile(ctx, fileId);
  revalidatePath(`/${moduleSlug}`);
}

export async function addFileRowAction(moduleSlug: string, recordId: string, formData: FormData): Promise<void> {
  const ctx = await authorize();
  const name = String(formData.get('name') ?? '').trim();
  /* Anything that is not the Application section is the Other one — the union
     has two members, and defaulting keeps an unexpected value out of the
     insert rather than passing it through to the CHECK constraint. */
  const kind = formData.get('kind') === 'application' ? 'application' : 'other';
  if (name) await addFileRow(ctx, recordId, name, kind);
  revalidatePath(`/${moduleSlug}`);
}

export async function ensureApplicationRowsAction(recordId: string): Promise<void> {
  const ctx = await authorize();
  await ensureApplicationRows(ctx, recordId);
}

/**
 * Takes the FILE'S ID, not its storage path.
 *
 * The path used to come from the browser and was signed as given, so the
 * caller picked the file and the Files/Cases tab grant never entered into it.
 * `signedUrlFor` now resolves the path itself and checks the grant; this
 * signature is what makes that possible.
 */
export async function getFileUrlAction(fileId: string): Promise<string> {
  const ctx = await authorize();
  return signedUrlFor(ctx, fileId);
}

/**
 * The same file, signed to SAVE rather than to open.
 *
 * A separate action rather than a flag on the one above because the two are
 * reached differently in the browser: opening needs a tab held open across
 * the await, and saving needs no tab at all. Keeping them apart is what lets
 * the download path avoid the popup machinery entirely — and popups were the
 * reason files could not be opened in the first place.
 */
export async function getFileDownloadUrlAction(fileId: string): Promise<string> {
  const ctx = await authorize();
  return signedUrlFor(ctx, fileId, { download: true });
}

/* -----------------------------------------------------------------------
 * Logins
 * --------------------------------------------------------------------- */

export async function addLoginAction(
  moduleSlug: string,
  recordId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await authorize();
  const loginType = String(formData.get('loginType') ?? '').trim();
  if (!loginType) return { ok: false, message: 'Login type is required.' };
  const link = String(formData.get('link') ?? '').trim() || null;
  const username = String(formData.get('username') ?? '').trim() || null;
  const note = String(formData.get('note') ?? '').trim() || null;
  const password = String(formData.get('password') ?? '');

  const row = await addLogin(ctx, recordId, loginType, link, username, note);
  if (password) await setPassword(ctx, row.id, password);

  revalidatePath(`/${moduleSlug}`);
  return { ok: true };
}

export async function revealPasswordAction(loginId: string, kind: 'view' | 'copy' = 'view'): Promise<{ ok: boolean; password?: string }> {
  const ctx = await authorize();
  if (kind !== 'view' && kind !== 'copy') return { ok: false };
  try {
    const password = await revealPassword(ctx, loginId, kind);
    return { ok: true, password };
  } catch {
    return { ok: false };
  }
}

/* -----------------------------------------------------------------------
 * Statements
 * --------------------------------------------------------------------- */

export async function uploadStatementAction(
  moduleSlug: string,
  recordId: string,
  period: { id: string; year: number; month: number },
  formData: FormData,
): Promise<UploadResult> {
  const ctx = await authorize();
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: 'Choose a file first.' };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await uploadStatement(ctx, recordId, period, {
    name: file.name,
    bytes,
    contentType: file.type || 'application/octet-stream',
  });

  revalidatePath(`/${moduleSlug}`);
  if (!result.ok) return { ok: false, message: 'That file is over the 25MB limit.' };
  return { ok: true };
}

export async function deleteStatementAction(moduleSlug: string, fileId: string): Promise<void> {
  const ctx = await authorize();
  await deleteStatement(ctx, fileId);
  revalidatePath(`/${moduleSlug}`);
}

/** The statement half of the same fix — see `getFileUrlAction` above. */
export async function getStatementUrlAction(statementFileId: string): Promise<string> {
  const ctx = await authorize();
  return signedStatementUrlFor(ctx, statementFileId);
}

/* -----------------------------------------------------------------------
 * Repeat groups (Owners/Contacts/Affiliates) — "Add owner"/"Remove owner".
 * Re-fetches the record server-side rather than trusting client-held values,
 * since these mutations read every sibling's current array (migration 27)
 * before writing a new one back; a per-keystroke member-value edit is an
 * ordinary field write and goes through setValueAction unchanged.
 * --------------------------------------------------------------------- */

export async function addRepeatInstanceAction(moduleSlug: string, recordId: string, fieldKey: string): Promise<RepeatMutationResult> {
  const ctx = await authorize();
  const config = await loadConfig();
  const field = fieldByKey(config, fieldKey);
  if (!field || field.type !== 'repeat_group' || !field.repeatGroupKey || field.repeatMax == null) {
    return { ok: false, message: 'Unknown repeat group.' };
  }
  const record = await getRecord(ctx, recordId);
  if (!record) return { ok: false, message: 'Record not found.' };

  const siblings = fieldsInRepeatGroup(config, field.repeatGroupKey);
  const result = await addRepeatInstance(ctx, recordId, siblings, record.values, record.updatedAt, field.repeatMax);
  revalidatePath(`/${moduleSlug}`);
  return result;
}

export async function removeRepeatInstanceAction(
  moduleSlug: string,
  recordId: string,
  fieldKey: string,
  index: number,
): Promise<RepeatMutationResult> {
  const ctx = await authorize();
  const config = await loadConfig();
  const field = fieldByKey(config, fieldKey);
  if (!field || field.type !== 'repeat_group' || !field.repeatGroupKey) {
    return { ok: false, message: 'Unknown repeat group.' };
  }
  const record = await getRecord(ctx, recordId);
  if (!record) return { ok: false, message: 'Record not found.' };

  const siblings = fieldsInRepeatGroup(config, field.repeatGroupKey);
  const result = await removeRepeatInstance(ctx, recordId, siblings, record.values, record.updatedAt, index);
  revalidatePath(`/${moduleSlug}`);
  return result;
}

/**
 * The standing instruction above the Cases list — "how to deal with this
 * merchant's tickets". Empty clears it; see `setCaseHandlingNote`.
 *
 * Revalidates, unlike the field writes: this is one deliberate save on a
 * paragraph of prose, not the per-keystroke path whose revalidation cost
 * `setValueAction` exists to avoid.
 */
export async function setCaseHandlingNoteAction(
  moduleSlug: string,
  recordId: string,
  body: string,
): Promise<ActionState> {
  const ctx = await authorize();
  /* Parsed at the boundary like every other action (CLAUDE.md §6). The cap
     matches the table's own check constraint, so the refusal is a sentence
     here rather than a constraint violation two layers down. */
  const trimmed = String(body ?? '');
  if (trimmed.length > 4000) return { ok: false, message: 'That note is too long.' };

  try {
    const result = await setCaseHandlingNote(ctx, recordId, trimmed);
    if (!result.ok) return { ok: false, message: result.message };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save that note.' };
  }
  revalidatePath(`/${moduleSlug}`);
  return { ok: true };
}

/* -----------------------------------------------------------------------
 * Sharing an update, case or tab note; hiding a reply (Permissions spec)
 * --------------------------------------------------------------------- */

const ItemKindSchema = z.enum(['case', 'update', 'note']);
const UserTypeSchema = z.enum(['super_admin', 'admin', 'underwriter', 'accounting', 'customer_service', 'sales_agent']);

export async function grantItemAccessAction(input: {
  kind: string;
  itemId: string;
  userId?: string | null;
  userType?: string | null;
}): Promise<{ ok: boolean; message?: string }> {
  const parsed = z
    .object({
      kind: ItemKindSchema,
      itemId: z.uuid(),
      userId: z.uuid().nullish().transform((v) => v ?? null),
      userType: UserTypeSchema.nullish().transform((v) => v ?? null),
    })
    .refine((v) => (v.userId === null) !== (v.userType === null), 'Choose one person or one user type.')
    .safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Choose one person or one user type.' };
  const ctx = await authorize();
  try {
    await grantItemAccess(ctx, parsed.data);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not share that.' };
  }
}

export async function revokeItemAccessAction(grantId: string): Promise<{ ok: boolean; message?: string }> {
  const parsed = z.uuid().safeParse(grantId);
  if (!parsed.success) return { ok: false, message: 'That access is not valid.' };
  const ctx = await authorize();
  try {
    await revokeItemAccess(ctx, parsed.data);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not remove that access.' };
  }
}

export async function setReplyHiddenAction(input: {
  kind: string;
  replyId: string;
  userIds: string[];
}): Promise<{ ok: boolean; message?: string }> {
  const parsed = z
    .object({ kind: z.enum(['update', 'case_reply']), replyId: z.uuid(), userIds: z.array(z.uuid()).max(200) })
    .safeParse(input);
  if (!parsed.success) return { ok: false, message: 'That list is not valid.' };
  const ctx = await authorize();
  try {
    await setReplyHidden(ctx, parsed.data);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not change who sees that reply.' };
  }
}
