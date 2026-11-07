/**
 * Residuals: the monthly reconciliation workspace (Acquiring, ACH, Accept.blue, Final Tally).
 *
 * This static segment takes precedence over `[module]` for /residuals, so the Residuals module
 * opens this page instead of a record list. Everything shown is read from the database and run
 * through the TypeScript calculator on each load (src/lib/residuals/workspace.ts).
 */
import { redirect } from 'next/navigation';
import { authorize, canOpenAdminPage } from '@/lib/records/permissions';
import { loadWorkspace } from '@/lib/residuals/workspace';
import { ResidualsWorkspace, type WorkspaceTab } from './ResidualsWorkspace';

const TABS = ['dashboard', 'tally', 'acquiring', 'ach', 'acceptblue', 'buyrates', 'partners'] as const;


export default async function ResidualsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; tab?: string }>;
}) {
  const ctx = await authorize();
  if (!(await canOpenAdminPage(ctx, 'residuals'))) redirect('/dashboard');

  const { month, tab } = await searchParams;
  const data = await loadWorkspace(ctx, /^\d{4}-\d{2}$/.test(month ?? '') ? month! : null);
  const initialTab = (TABS as readonly string[]).includes(tab ?? '') ? (tab as WorkspaceTab) : 'dashboard';

  return <ResidualsWorkspace data={data} initialTab={initialTab} />;
}
