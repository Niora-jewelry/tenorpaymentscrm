/** /chat: the person's Teams conversations, in the layout of the Teams chat screen. */
import { redirect } from 'next/navigation';
import { authorize } from '@/lib/records/permissions';
import { BrowserGate, ConnectScreen } from '../msteams-ui/shared';
import { modulePage, needsConnect } from '../msteams-ui/page-data';
import { ChatShell } from './ui/ChatShell';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ChatPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await authorize();
  const page = await modulePage(ctx, 'chat', await searchParams);
  if (!page.configured) redirect('/dashboard');
  return (
    <BrowserGate label="Chat">
      {needsConnect(page) ? (
        <ConnectScreen kind="chat" accounts={page.accounts} waiting={page.waiting} requestText={page.requestText} errorText={page.errorText} impersonating={page.impersonating} />
      ) : (
        <ChatShell key={page.ownerId} page={page} />
      )}
    </BrowserGate>
  );
}
