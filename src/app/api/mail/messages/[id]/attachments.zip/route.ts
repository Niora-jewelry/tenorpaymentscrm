/**
 * GET /api/mail/messages/<id>/attachments.zip — every file attached to one
 * message, as a single zip ("Download all").
 *
 * Visibility is the RLS read of the message and its attachment rows. Files
 * are streamed from Microsoft into the zip (stored, not recompressed — most
 * attachments are compressed already) and PULLED: the next piece is read
 * from Microsoft only when the browser has taken the last one, so memory
 * stays flat whatever the size and however slow the download. A file Outlook
 * can no longer give us does not fail the whole download: it is listed in a
 * short note inside the zip instead. Links to OneDrive/SharePoint files are
 * not files here and are skipped.
 */
import { type NextRequest } from 'next/server';
import { Zip, ZipPassThrough } from 'fflate';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { RATE_LIMITS } from '@/lib/security/rate-limit';
import { routeGate, notFound, untrustedHeaders, contentDisposition, UUID } from '@/lib/mail/routeGate';
import { actingFor } from '@/lib/mail/acting';
import { MAIL_MESSAGES } from '@/lib/mail/messages';
import { mailLog } from '@/lib/mail/log';
import { zipNames } from '@/lib/mail/zipNames';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Exchange's own ceiling is far below this; it stops a runaway stream. */
const MAX_TOTAL = 1024 * 1024 * 1024;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await routeGate('mail_attachment', RATE_LIMITS.mailAttachmentPerUser);
  if ('response' in gate) return gate.response;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();

  const supabase = await createSupabaseServerClient();
  const { data: msg } = await supabase.from('mail_messages').select('id, graph_id, mailbox_id, subject').eq('id', id).maybeSingle();
  if (!msg) return notFound();
  const { data: rows } = await supabase
    .from('mail_attachments')
    .select('id, name, graph_id, kind')
    .eq('message_id', id)
    .eq('is_inline', false)
    .neq('kind', 'reference')
    .order('name');
  const atts = (rows ?? []) as Array<{ id: string; name: string; graph_id: string; kind: string }>;
  if (atts.length === 0) return notFound();

  const acting = await actingFor(gate.ctx, msg.mailbox_id as string);
  if (!acting) return new Response(MAIL_MESSAGES.providerDown, { status: 503 });

  const names = zipNames(atts.map((a) => (a.kind === 'item' && !/\.eml$/i.test(a.name) ? `${a.name}.eml` : a.name)));
  const base = `${acting.root}/messages/${encodeURIComponent(msg.graph_id as string)}/attachments`;

  // fflate hands finished zip bytes to this queue; the stream drains it.
  const queue: Uint8Array[] = [];
  let finished = false;
  let zipError: unknown = null;
  const zip = new Zip((err, chunk, final) => {
    if (err) zipError = err;
    else {
      queue.push(chunk);
      if (final) finished = true;
    }
  });

  /** Feeds the zip one upstream chunk per step. */
  async function* produce(): AsyncGenerator<void> {
    const missing: string[] = [];
    let total = 0;
    for (const [i, a] of atts.entries()) {
      let upstream: Response;
      try {
        upstream = await acting!.graph.raw({ path: `${base}/${encodeURIComponent(a.graph_id)}/$value` });
      } catch {
        missing.push(names[i]);
        continue;
      }
      const file = new ZipPassThrough(names[i]);
      zip.add(file);
      const reader = upstream.body?.getReader();
      try {
        for (;;) {
          const step = reader ? await reader.read() : { done: true as const, value: undefined };
          if (step.done) break;
          total += step.value.length;
          if (total > MAX_TOTAL) throw new Error('too_large');
          file.push(step.value);
          yield;
        }
      } finally {
        reader?.releaseLock();
      }
      file.push(new Uint8Array(0), true);
      yield;
    }
    if (missing.length) {
      const note = new ZipPassThrough('Files Outlook could not provide.txt');
      zip.add(note);
      note.push(
        new TextEncoder().encode(
          `These attachments could not be downloaded from Outlook when this zip was made:\r\n\r\n${missing.map((m) => `  - ${m}`).join('\r\n')}\r\n\r\nOpen the message in Outlook to get them.\r\n`,
        ),
        true,
      );
      mailLog('warn', 'attachments', 'zip_partial', { missing: missing.length, of: atts.length });
    }
    zip.end();
  }
  const steps = produce();

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (queue.length === 0 && !finished && !zipError) {
          const r = await steps.next();
          if (r.done) break;
        }
      } catch (e) {
        // Mid-file failure: the entry can't be completed, so the zip can't either.
        mailLog('warn', 'attachments', 'zip_stream_failed', { message: e instanceof Error ? e.message.slice(0, 80) : 'unknown' });
        controller.error(e);
        return;
      }
      if (zipError) return controller.error(zipError);
      const chunk = queue.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    async cancel() {
      await steps.return(undefined);
    },
  });

  const subject = String(msg.subject ?? '').trim().slice(0, 80) || 'message';
  return new Response(body, {
    status: 200,
    headers: untrustedHeaders({
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(`Attachments - ${subject}.zip`),
      'Cache-Control': 'private, no-store',
    }),
  });
}
