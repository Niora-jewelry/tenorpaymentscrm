import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { automationsAccess, authorize } from '@/lib/records/permissions';
import { automationCatalog } from '@/lib/automations/catalog';
import { getAutomation } from '@/lib/automations/service';
import { Builder } from '../Builder';

export default async function AutomationPage({ params }: { params: Promise<{ automationId: string }> }) {
  const ctx = await authorize();
  const access = await automationsAccess(ctx);
  if (access === 'hidden') redirect('/dashboard');

  const { automationId } = await params;
  if (!z.uuid().safeParse(automationId).success) notFound();
  const [automation, catalog] = await Promise.all([getAutomation(ctx, automationId), automationCatalog(ctx)]);
  if (!automation) notFound();
  return <Builder key={automation.id} automation={automation} catalog={catalog} canEdit={access === 'full'} />;
}
