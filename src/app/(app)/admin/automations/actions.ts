'use server';

/**
 * Automations — parse, then hand to the service, which asks the gate first.
 * The parsed step list is the only way into a save.
 */
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { authorize } from '@/lib/records/permissions';
import { AutomationError } from '@/lib/automations/access';
import {
  addAutomationFile,
  deleteAutomation,
  dismissAlert,
  removeAutomationFile,
  saveAutomation,
  searchRecords,
  setAutomationStatus,
  switchOffForRecord,
  type AutomationFile,
} from '@/lib/automations/service';
import { stepsSchema } from '@/lib/automations/steps';

type Result<T> = { ok: true; data: T } | { ok: false; message: string };

const uuid = z.uuid();
const MAX_FILE = 25 * 1024 * 1024;
const BLOCKED = /\.(exe|bat|cmd|com|scr|js|vbs|msi|ps1|jar)$/i;

async function run<T>(fn: () => Promise<T>, fallback: string): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof AutomationError) return { ok: false, message: e.message };
    console.error('[automations]', fallback, e instanceof Error ? e.message.slice(0, 300) : e);
    return { ok: false, message: fallback };
  }
}

const refresh = () => revalidatePath('/admin/automations', 'layout');

const saveSchema = z.object({
  id: uuid.nullable(),
  name: z.string().trim().min(1, 'Give the automation a name.').max(120),
  steps: stepsSchema,
  stopTeamIds: z.array(uuid).max(20),
  stopUserIds: z.array(uuid).max(200),
  waiting: z.enum(['old', 'new']).nullable(),
});

export async function saveAutomationAction(input: unknown): Promise<Result<{ id: string } | { needsChoice: number }>> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'That automation is not valid.' };
  const ctx = await authorize();
  const r = await run(() => saveAutomation(ctx, parsed.data), 'Could not save the automation.');
  if (r.ok) refresh();
  return r;
}

const statusSchema = z.object({ id: uuid, status: z.enum(['draft', 'test', 'on', 'off']), testRecordId: uuid.nullable() });

export async function setStatusAction(input: unknown): Promise<Result<{ ended: number }>> {
  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'That status is not valid.' };
  const ctx = await authorize();
  const r = await run(() => setAutomationStatus(ctx, parsed.data.id, parsed.data.status, parsed.data.testRecordId), 'Could not change the status.');
  if (r.ok) refresh();
  return r;
}

export async function deleteAutomationAction(id: string): Promise<Result<null>> {
  const parsed = uuid.safeParse(id);
  if (!parsed.success) return { ok: false, message: 'That automation is not valid.' };
  const ctx = await authorize();
  const r = await run(async () => {
    await deleteAutomation(ctx, parsed.data);
    return null;
  }, 'Could not delete the automation.');
  if (r.ok) refresh();
  return r;
}

export async function searchRecordsAction(q: string): Promise<Result<{ id: string; label: string }[]>> {
  const parsed = z.string().max(120).safeParse(q);
  if (!parsed.success) return { ok: false, message: 'Search is too long.' };
  const ctx = await authorize();
  return run(() => searchRecords(ctx, parsed.data), 'Could not search records.');
}

export async function uploadFileAction(formData: FormData): Promise<Result<AutomationFile>> {
  const id = uuid.safeParse(formData.get('automationId'));
  const file = formData.get('file');
  if (!id.success || !(file instanceof File)) return { ok: false, message: 'Choose a file.' };
  if (file.size === 0 || file.size > MAX_FILE) return { ok: false, message: 'A file can be up to 25 MB.' };
  if (BLOCKED.test(file.name)) return { ok: false, message: 'That type of file can’t be attached.' };
  const ctx = await authorize();
  return run(async () => addAutomationFile(ctx, id.data, { name: file.name, type: file.type, bytes: Buffer.from(await file.arrayBuffer()) }), 'Could not upload the file.');
}

export async function removeFileAction(fileId: string): Promise<Result<null>> {
  const parsed = uuid.safeParse(fileId);
  if (!parsed.success) return { ok: false, message: 'That file is not valid.' };
  const ctx = await authorize();
  return run(async () => {
    await removeAutomationFile(ctx, parsed.data);
    return null;
  }, 'Could not remove the file.');
}

export async function dismissAlertAction(runId: string): Promise<Result<null>> {
  const parsed = uuid.safeParse(runId);
  if (!parsed.success) return { ok: false, message: 'That alert is not valid.' };
  const ctx = await authorize();
  const r = await run(async () => {
    await dismissAlert(ctx, parsed.data);
    return null;
  }, 'Could not dismiss the alert.');
  if (r.ok) refresh();
  return r;
}

/** From the drawer: stop one record's remaining steps. */
export async function switchOffRunAction(runId: string): Promise<Result<null>> {
  const parsed = uuid.safeParse(runId);
  if (!parsed.success) return { ok: false, message: 'That automation is not valid.' };
  const ctx = await authorize();
  const r = await run(async () => {
    await switchOffForRecord(ctx, parsed.data);
    return null;
  }, 'Could not switch it off.');
  if (r.ok) revalidatePath('/[module]', 'page');
  return r;
}
