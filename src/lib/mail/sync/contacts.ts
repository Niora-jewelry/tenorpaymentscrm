/**
 * Outlook contacts → `mail_contacts`, for To/Cc/Bcc suggestions.
 *
 * A contacts delta per personal mailbox, every 15 minutes (mail_schedule_due).
 * Only names and addresses are kept. Shared mailboxes are skipped: reading
 * another mailbox's contacts needs Contacts.Read.Shared, which the app does
 * not ask for — their suggestions come from the mail itself.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { GraphError } from '../graph/transport';
import type { MailboxCtx } from './ingest';

const MAX_PAGES = 20;

type GraphContact = {
  id: string;
  '@removed'?: unknown;
  displayName?: string | null;
  emailAddresses?: Array<{ name?: string | null; address?: string | null }> | null;
};
type Page = { value?: GraphContact[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string };

/** One contact → its stored shape (pure). */
export function contactRow(mailboxId: string, c: GraphContact) {
  const addresses = [
    ...new Set(
      (c.emailAddresses ?? [])
        .map((e) => (e?.address ?? '').trim().toLowerCase())
        .filter((a) => a.includes('@') && a.length <= 254),
    ),
  ].slice(0, 10);
  const name = (c.displayName ?? '').trim().slice(0, 200) || null;
  return {
    mailbox_id: mailboxId,
    graph_id: c.id,
    display_name: name,
    addresses,
    search_text: [name ?? '', ...addresses].join(' ').toLowerCase().slice(0, 2000),
    synced_at: new Date().toISOString(),
    deleted_at: null,
  };
}

export type ContactsOutcome = { changed: number; complete: boolean };

export async function syncContacts(mb: MailboxCtx, kind: 'personal' | 'shared', deadline: number): Promise<ContactsOutcome> {
  const admin = supabaseAdmin();
  const stamp = () => new Date().toISOString();
  if (kind === 'shared') {
    await admin.from('mail_mailboxes').update({ contacts_synced_at: stamp() }).eq('id', mb.id);
    return { changed: 0, complete: true };
  }
  const { data: row } = await admin.from('mail_mailboxes').select('contacts_delta_link').eq('id', mb.id).maybeSingle();
  let req: { path: string; query?: Record<string, string> } = row?.contacts_delta_link
    ? { path: row.contacts_delta_link as string }
    : { path: `${mb.root}/contacts/delta`, query: { $select: 'displayName,emailAddresses' } };

  let changed = 0;
  for (let page = 0; page < MAX_PAGES && Date.now() < deadline; page += 1) {
    let res: Page;
    try {
      res = (await mb.graph.request<Page>(req)) ?? {};
    } catch (e) {
      // An expired cursor: start over from scratch next time.
      if (e instanceof GraphError && (e.status === 410 || e.graphCode === 'SyncStateNotFound' || e.graphCode === 'SyncStateInvalid')) {
        await admin.from('mail_mailboxes').update({ contacts_delta_link: null }).eq('id', mb.id);
        return { changed, complete: false };
      }
      throw e;
    }
    const items = res.value ?? [];
    const gone = items.filter((c) => c['@removed']).map((c) => c.id);
    const live = items.filter((c) => !c['@removed'] && c.id).map((c) => contactRow(mb.id, c));
    if (live.length) {
      const { error } = await admin.from('mail_contacts').upsert(live, { onConflict: 'mailbox_id,graph_id' });
      if (error) throw new Error(`mail_contacts upsert failed: ${error.code ?? 'db'}`);
      changed += live.length;
    }
    if (gone.length) {
      await admin.from('mail_contacts').update({ deleted_at: stamp() }).eq('mailbox_id', mb.id).in('graph_id', gone);
      changed += gone.length;
    }
    if (res['@odata.deltaLink']) {
      await admin.from('mail_mailboxes').update({ contacts_delta_link: res['@odata.deltaLink'], contacts_synced_at: stamp() }).eq('id', mb.id);
      return { changed, complete: true };
    }
    if (!res['@odata.nextLink']) {
      await admin.from('mail_mailboxes').update({ contacts_delta_link: null, contacts_synced_at: stamp() }).eq('id', mb.id);
      return { changed, complete: true };
    }
    await admin.from('mail_mailboxes').update({ contacts_delta_link: res['@odata.nextLink'] }).eq('id', mb.id);
    req = { path: res['@odata.nextLink'] };
  }
  return { changed, complete: false };
}
