import { redirect } from 'next/navigation';
import { automationsAccess, authorize } from '@/lib/records/permissions';
import { automationCatalog } from '@/lib/automations/catalog';
import { Builder } from '../Builder';

export default async function NewAutomationPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const ctx = await authorize();
  const kind = (await searchParams).kind === 'ticket' ? 'ticket' : 'record';
  if ((await automationsAccess(ctx)) !== 'full') redirect(kind === 'ticket' ? '/admin/automations?kind=ticket' : '/admin/automations');
  return <Builder automation={null} kind={kind} catalog={await automationCatalog(ctx)} canEdit />;
}
