/** /calendar: the person's Microsoft calendars, in the layout of the Teams calendar. */
import { redirect } from 'next/navigation';
import { authorize } from '@/lib/records/permissions';
import { BrowserGate, ConnectScreen } from '../msteams-ui/shared';
import { modulePage, needsConnect } from '../msteams-ui/page-data';
import { CalendarShell } from './ui/CalendarShell';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function CalendarPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await authorize();
  const page = await modulePage(ctx, 'calendar', await searchParams);
  if (!page.configured) redirect('/dashboard');
  return (
    <BrowserGate label="Calendar">
      {needsConnect(page) ? (
        <ConnectScreen kind="calendar" accounts={page.accounts} waiting={page.waiting} requestText={page.requestText} errorText={page.errorText} impersonating={page.impersonating} />
      ) : (
        <CalendarShell key={page.ownerId} page={page} />
      )}
    </BrowserGate>
  );
}
