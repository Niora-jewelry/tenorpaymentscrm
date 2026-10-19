/**
 * GET /api/mail/attachments/<id> — downloads one attachment, streamed from
 * Microsoft straight to the browser (never stored, never held in memory).
 *
 * Visibility is the RLS read of the attachment row; the bytes are fetched
 * with the acting sign-in (`acting.ts`). Always served as a download with
 * octet-stream and nosniff: a file from someone's inbox must never render as
 * a page on our origin.
 */
import { type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { RATE_LIMITS } from '@/lib/security/rate-limit';
import { routeGate, notFound, untrustedHeaders, contentDisposition, UUID } from '@/lib/mail/routeGate';
import { actingFor } from '@/lib/mail/acting';
import { GraphError } from '@/lib/mail/graph/transport';
import { MAIL_MESSAGES } from '@/lib/mail/messages';
import { mailLog } from '@/lib/mail/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type Row = {
  id: string;
  name: string;
  graph_id: string;
  kind: string;
  mailbox_id: string;
  mail_messages: { graph_id: string } | null;
};

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await routeGate('mail_attachment', RATE_LIMITS.mailAttachmentPerUser);
  if ('response' in gate) return gate.response;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();

  const supabase = await createSupabaseServerClient();
  const { data: att } = await supabase
    .from('mail_attachments')
    .select('id, name, graph_id, kind, mailbox_id, mail_messages(graph_id)')
    .eq('id', id)
    .maybeSingle<Row>();
  if (!att?.mail_messages) return notFound();
  if (att.kind === 'reference') {
    return new Response('This attachment is a link to a file in OneDrive or SharePoint; open it from Outlook.', { status: 409 });
  }

  const acting = await actingFor(gate.ctx, att.mailbox_id);
  if (!acting) return new Response(MAIL_MESSAGES.providerDown, { status: 503 });

  try {
    const upstream = await acting.graph.raw({
      path: `${acting.root}/messages/${encodeURIComponent(att.mail_messages.graph_id)}/attachments/${encodeURIComponent(att.graph_id)}/$value`,
    });
    const name = att.kind === 'item' && !/\.eml$/i.test(att.name) ? `${att.name}.eml` : att.name;
    const length = upstream.headers.get('content-length');
    return new Response(upstream.body, {
      status: 200,
      headers: untrustedHeaders({
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': contentDisposition(name),
        'Cache-Control': 'private, no-store',
        ...(length ? { 'Content-Length': length } : {}),
      }),
    });
  } catch (e) {
    const c = e instanceof GraphError ? e.classified : null;
    mailLog('warn', 'attachments', 'download_failed', { code: c?.code ?? 'internal' });
    if (c?.code === 'not_found') return new Response(MAIL_MESSAGES.goneAttachment, { status: 404 });
    if (c?.code === 'throttled') return new Response(MAIL_MESSAGES.busy(c.retryAfterSeconds ?? 10), { status: 503 });
    return new Response(MAIL_MESSAGES.providerDown, { status: 502 });
  }
}
