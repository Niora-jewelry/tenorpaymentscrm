/**
 * GET /api/mail/inline/<messageId>?cid=<content-id> — an inline image a
 * message body references as `cid:…` (logos, pasted screenshots).
 *
 * Graph's attachment LIST does not carry contentId, so the first time a
 * message's inline images are asked for, each unresolved attachment is read
 * once and its contentId stored. Only raster images are ever served
 * (magic-byte sniffed): an "inline image" that is really HTML or SVG gets a
 * 415, never a document on our origin.
 */
import { type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { RATE_LIMITS } from '@/lib/security/rate-limit';
import { routeGate, notFound, untrustedHeaders, UUID } from '@/lib/mail/routeGate';
import { actingFor } from '@/lib/mail/acting';
import { sniffImage } from '@/lib/mail/ssrf';
import { mailLog } from '@/lib/mail/log';
import { GraphError } from '@/lib/mail/graph/transport';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 5 * 1024 * 1024;
const norm = (cid: string) => cid.trim().replace(/^<|>$/g, '').toLowerCase();

type Row = { id: string; graph_id: string; content_id: string | null };

export async function GET(req: NextRequest, { params }: { params: Promise<{ messageId: string }> }) {
  const gate = await routeGate('mail_image', RATE_LIMITS.mailImagePerUser);
  if ('response' in gate) return gate.response;
  const { messageId } = await params;
  const cid = norm(req.nextUrl.searchParams.get('cid') ?? '');
  if (!UUID.test(messageId) || !cid || cid.length > 500) return notFound();

  const supabase = await createSupabaseServerClient();
  const { data: msg } = await supabase.from('mail_messages').select('id, mailbox_id, graph_id').eq('id', messageId).maybeSingle();
  if (!msg) return notFound();
  const { data: rows } = await supabase
    .from('mail_attachments')
    .select('id, graph_id, content_id')
    .eq('message_id', messageId)
    .returns<Row[]>();
  if (!rows?.length) return notFound();

  const acting = await actingFor(gate.ctx, msg.mailbox_id as string);
  if (!acting) return notFound();
  const base = `${acting.root}/messages/${encodeURIComponent(msg.graph_id as string)}/attachments`;

  let bytes: Buffer | null = null;
  try {
    const known = rows.find((r) => r.content_id && norm(r.content_id) === cid);
    if (known) {
      const res = await acting.graph.raw({ path: `${base}/${encodeURIComponent(known.graph_id)}/$value` });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length <= MAX_BYTES) bytes = buf;
    } else {
      // Resolve contentIds never seen before, at most ten per message, once.
      for (const r of rows.filter((x) => x.content_id === null).slice(0, 10)) {
        const a = await acting.graph.request<{ contentId?: string; contentBytes?: string; size?: number }>({
          path: `${base}/${encodeURIComponent(r.graph_id)}`,
        });
        const found = a?.contentId ? norm(a.contentId) : '';
        await supabaseAdmin().from('mail_attachments').update({ content_id: found }).eq('id', r.id);
        if (found === cid && a?.contentBytes && (a.size ?? 0) <= MAX_BYTES) {
          bytes = Buffer.from(a.contentBytes, 'base64');
          break;
        }
      }
    }
  } catch (e) {
    mailLog('warn', 'inline', 'fetch_failed', { code: e instanceof GraphError ? e.classified.code : 'internal' });
    return notFound();
  }
  if (!bytes) return notFound();
  const type = sniffImage(bytes);
  if (!type) return new Response('Unsupported image.', { status: 415 });
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: untrustedHeaders({ 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' }),
  });
}
