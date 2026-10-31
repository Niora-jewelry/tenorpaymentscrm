import { redirect } from 'next/navigation';
import { automationsAccess, authorize } from '@/lib/records/permissions';
import { automationCatalog } from '@/lib/automations/catalog';
import { Builder } from '../Builder';

export default async function NewAutomationPage() {
  const ctx = await authorize();
  if ((await automationsAccess(ctx)) !== 'full') redirect('/admin/automations');
  return <Builder automation={null} catalog={await automationCatalog(ctx)} canEdit />;
}
