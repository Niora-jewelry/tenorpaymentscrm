'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { SETTING_KEYS } from '@/lib/integrations/catalog';
import {
  connectSignwell,
  IntegrationError,
  removeIntegrationSetting,
  saveIntegrationGroup,
  sendTestAlert,
  testIntegrationGroup,
} from '@/lib/integrations/service';
import type { ProbeResult } from '@/lib/integrations/probe';
import { authorize } from '@/lib/records/permissions';

const Group = z.enum(['twilio', 'microsoft', 'signwell', 'alerts']);
const Key = z.string().refine((k) => SETTING_KEYS.includes(k));
const Save = z.object({ group: Group, values: z.record(Key, z.string().max(2000)) });

export type IntegrationOutcome = { ok: true; saved?: boolean; note: string; warning?: string } | { ok: false; message: string };

/** Only our own messages reach the browser: a thrown error could quote a key. */
async function run(work: () => Promise<IntegrationOutcome>): Promise<IntegrationOutcome> {
  try {
    const out = await work();
    revalidatePath('/admin/integrations');
    return out;
  } catch (e) {
    if (e instanceof IntegrationError) return { ok: false, message: e.message };
    console.error('[integrations] action failed', { name: e instanceof Error ? e.name : 'unknown' });
    return { ok: false, message: 'That did not work. Try again.' };
  }
}

const outcome = (r: ProbeResult): IntegrationOutcome => (r.ok ? { ok: true, note: r.note, warning: r.warning } : { ok: false, message: r.note });

export async function saveIntegrationAction(input: z.input<typeof Save>): Promise<IntegrationOutcome> {
  const parsed = Save.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'That setting is not valid.' };
  return run(async () => {
    const r = await saveIntegrationGroup(await authorize(), parsed.data.group, parsed.data.values);
    if (!r.saved) return { ok: false, message: `${r.result.note} Nothing was saved.` };
    return { ok: true, saved: true, note: `Saved. ${r.result.note}`, warning: r.result.warning };
  });
}

export async function removeIntegrationAction(key: string): Promise<IntegrationOutcome> {
  const parsed = Key.safeParse(key);
  if (!parsed.success) return { ok: false, message: 'That setting is not valid.' };
  return run(async () => {
    await removeIntegrationSetting(await authorize(), parsed.data);
    return { ok: true, note: 'Removed.' };
  });
}

export async function testIntegrationAction(group: string): Promise<IntegrationOutcome> {
  const parsed = Group.safeParse(group);
  if (!parsed.success) return { ok: false, message: 'That service is not valid.' };
  return run(async () => outcome(await testIntegrationGroup(await authorize(), parsed.data)));
}

export async function connectSignwellAction(): Promise<IntegrationOutcome> {
  return run(async () => outcome(await connectSignwell(await authorize())));
}

export async function sendTestAlertAction(): Promise<IntegrationOutcome> {
  return run(async () => {
    const { to } = await sendTestAlert(await authorize());
    return { ok: true, note: `Test alert sent to ${to}.` };
  });
}
