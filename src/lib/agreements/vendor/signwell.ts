/**
 * SignWell (https://developers.signwell.com) — the e-sign service behind
 * agreements (the client, 30 Oct 2026: "Let's start with SignWell").
 *
 *   POST  /api/v1/documents                  send (files, recipients, fields)
 *   GET   /api/v1/documents/{id}             status and recipients
 *   DELETE /api/v1/documents/{id}            cancel signing in progress
 *   POST  /api/v1/documents/{id}/send_reminder
 *   PATCH /api/v1/documents/{id}/recipients  a bounced signer's new email
 *   GET   /api/v1/documents/{id}/completed_pdf?audit_page=true
 *
 * Webhooks carry `event.hash = HMAC-SHA256(key = the webhook id,
 * message = "<type>@<time>")`. Only type and time are signed, so the route
 * re-reads terminal documents from the API before trusting their body.
 * SignWell can register several hooks on one URL (a workspace one and one
 * per API app), each signing with its own id — SIGNWELL_WEBHOOK_ID holds
 * them comma-separated and an event verifies against any of them.
 *
 * Coordinates: SignWell places a field by `x`/`y` from the page's TOP-left,
 * in CSS PIXELS at 96 dpi (1 pt = 4/3 px); the template's rectangles are
 * PDF points from the bottom-left, so `y = (pageHeight - (y + h)) * 4/3`.
 * Pinned on 30 Oct 2026 with a draft test-mode document: in points the boxes
 * landed ~150 pt high and 7 pt left; in pixels they sit on the lines (see
 * README.md in this folder).
 *
 * Nothing here logs a request body: the PDF holds SSNs and bank details.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { ESignVendor, SendRequest, SentDocument, VendorDocument, VerifiedEvent } from './types';
import { VendorError } from './types';

const BASE = 'https://www.signwell.com/api/v1';
const TIMEOUT_MS = 45_000;
/** SignWell field geometry is CSS pixels at 96 dpi; the template's is PDF points. */
const PX_PER_PT = 96 / 72;

const Recipient = z.object({ id: z.string(), email: z.string().default(''), name: z.string().default(''), status: z.string().nullish(), bounced: z.boolean().nullish() });
const Document = z.object({
  id: z.string(),
  status: z.string().default(''),
  decline_message: z.string().nullish(),
  metadata: z.record(z.string(), z.string().nullable()).nullish(),
  recipients: z.array(Recipient).default([]),
});
const Event = z.object({
  event: z.object({
    type: z.string(),
    time: z.union([z.number(), z.string()]),
    hash: z.string(),
    related_signer: z.object({ email: z.string().default(''), name: z.string().default('') }).nullish(),
  }),
  data: z.object({ object: Document.partial({ status: true }).passthrough().nullish() }).passthrough(),
});

function toDoc(d: z.infer<typeof Document>): VendorDocument {
  return {
    documentId: d.id,
    status: d.status.toLowerCase(),
    declineMessage: d.decline_message ?? null,
    recipients: d.recipients.map((r) => ({ vendorId: r.id, email: r.email, name: r.name, status: r.status?.toLowerCase() ?? null, bounced: r.bounced === true })),
    metadata: Object.fromEntries(Object.entries(d.metadata ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string')),
  };
}

export function signwellHash(webhookId: string, type: string, time: number | string): string {
  return createHmac('sha256', webhookId).update(`${type}@${time}`).digest('hex');
}

export class SignWell implements ESignVendor {
  readonly name = 'signwell';
  private readonly webhookIds: string[];
  constructor(
    private readonly apiKey: string,
    webhookIds: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.webhookIds = webhookIds.split(',').map((x) => x.trim()).filter(Boolean);
  }

  private async call<T>(method: string, path: string, body?: unknown, parse?: (json: unknown) => T): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE}${path}`, {
        method,
        headers: { 'X-Api-Key': this.apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
    } catch {
      throw new VendorError('unreachable', 'Could not reach the signing service.');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) throw new VendorError('auth', 'The signing service refused the API key.');
    if (res.status === 404) throw new VendorError('not_found', 'The signing service has no such document.');
    if (res.status === 409) throw new VendorError('conflict', 'The document is no longer open at the signing service.');
    if (res.status >= 500 || res.status === 429) throw new VendorError('unreachable', 'The signing service is busy.');
    if (!res.ok) throw new VendorError('rejected', 'The signing service refused the document.');
    if (!parse) return undefined as T;
    return parse(await res.json());
  }

  async send(req: SendRequest): Promise<SentDocument> {
    const recipients = req.signers.map((s) => ({ id: `principal-${s.slot}`, name: s.name, email: s.email }));
    const fields = req.spots.map((spot) => ({
      type: spot.kind === 'signature' ? 'signature' : 'date',
      api_id: `${spot.kind}-${spot.slot}-p${spot.page}-${Math.round(spot.x)}-${Math.round(spot.y)}`,
      page: spot.page,
      x: Math.round(spot.x * PX_PER_PT),
      y: Math.round((spot.pageHeight - (spot.y + spot.h)) * PX_PER_PT),
      width: Math.round(spot.w * PX_PER_PT),
      height: Math.round(spot.h * PX_PER_PT),
      required: true,
      recipient_id: `principal-${spot.slot}`,
      ...(spot.kind === 'date' ? { lock_sign_date: true } : {}),
    }));
    const body = {
      test_mode: req.testMode,
      draft: false,
      name: req.name,
      subject: req.subject,
      message: req.message,
      files: [{ name: req.fileName, file_base64: Buffer.from(req.pdf).toString('base64') }],
      recipients,
      fields: [fields],
      expires_in: req.expiresDays,
      reminders: req.reminders,
      allow_decline: true,
      allow_reassign: false,
      apply_signing_order: false,
      custom_requester_name: req.requesterName,
      ...(req.requesterEmail ? { custom_requester_email: req.requesterEmail } : {}),
      metadata: { agreement_id: req.agreementId, record_id: req.recordId },
    };
    const doc = await this.call('POST', '/documents', body, (j) => Document.parse(j));
    const out: SentDocument = { documentId: doc.id, recipients: [] };
    for (const s of req.signers) {
      const r = doc.recipients.find((x) => x.email.toLowerCase() === s.email.toLowerCase()) ?? doc.recipients.find((x) => x.id === `principal-${s.slot}`);
      if (!r) throw new VendorError('rejected', 'The signing service did not return every signer.');
      out.recipients.push({ slot: s.slot, vendorId: r.id });
    }
    return out;
  }

  async get(documentId: string): Promise<VendorDocument> {
    return this.call('GET', `/documents/${encodeURIComponent(documentId)}`, undefined, (j) => toDoc(Document.parse(j)));
  }

  async cancel(documentId: string): Promise<void> {
    await this.call('DELETE', `/documents/${encodeURIComponent(documentId)}`);
  }

  async remind(documentId: string): Promise<void> {
    await this.call('POST', `/documents/${encodeURIComponent(documentId)}/send_reminder`, {});
  }

  async updateRecipient(documentId: string, recipientVendorId: string, name: string, email: string): Promise<void> {
    await this.call('PATCH', `/documents/${encodeURIComponent(documentId)}/recipients`, { recipients: [{ id: recipientVendorId, name, email }] });
  }

  async downloadCompleted(documentId: string): Promise<Uint8Array> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${BASE}/documents/${encodeURIComponent(documentId)}/completed_pdf?audit_page=true`, {
        headers: { 'X-Api-Key': this.apiKey },
        signal: ctl.signal,
      });
      if (res.status === 404) throw new VendorError('not_found', 'The signing service has no such document.');
      if (!res.ok) throw new VendorError('unreachable', 'The signed PDF is not ready yet.');
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new VendorError('unreachable', 'The signing service returned something that is not a PDF.');
      return bytes;
    } catch (e) {
      if (e instanceof VendorError) throw e;
      throw new VendorError('unreachable', 'Could not reach the signing service.');
    } finally {
      clearTimeout(timer);
    }
  }

  verifyWebhook(rawBody: string): VerifiedEvent | null {
    let parsed: z.infer<typeof Event>;
    try {
      parsed = Event.parse(JSON.parse(rawBody));
    } catch {
      return null;
    }
    const { type, time, hash, related_signer } = parsed.event;
    const given = Buffer.from(hash, 'utf8');
    const verified = this.webhookIds.some((id) => {
      const expected = Buffer.from(signwellHash(id, type, time), 'utf8');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
    if (!verified) return null;
    const obj = parsed.data.object;
    const docId = obj?.id;
    if (!docId) return null;
    const document = obj && typeof obj.status === 'string' ? toDoc({ ...obj, status: obj.status, recipients: obj.recipients ?? [] }) : null;
    const metadata = (obj?.metadata ?? {}) as Record<string, unknown>;
    return {
      type,
      time: Number(time),
      hash,
      documentId: docId,
      agreementIdHint: typeof metadata.agreement_id === 'string' ? metadata.agreement_id : null,
      signer: related_signer ? { email: related_signer.email, name: related_signer.name } : null,
      document,
    };
  }
}
