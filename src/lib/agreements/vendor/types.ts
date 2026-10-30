/**
 * What the CRM asks of an e-signature service — the whole of it. One
 * implementation today (SignWell); another is one more file that satisfies
 * this interface and a different `vendor()`.
 */
import type { SignatureSpot } from '../pdf';
import type { Signer } from '../signers';

export type SendRequest = {
  /** Our agreement id, echoed back in `metadata` so a webhook that beats the
   *  vendor-id write still finds its row. */
  agreementId: string;
  recordId: string;
  name: string;
  fileName: string;
  pdf: Uint8Array;
  signers: Signer[];
  spots: SignatureSpot[];
  subject: string;
  message: string;
  requesterName: string;
  requesterEmail: string | null;
  expiresDays: number;
  reminders: boolean;
  testMode: boolean;
};

export type SentDocument = {
  documentId: string;
  /** Vendor recipient id per principal slot. */
  recipients: { slot: Signer['slot']; vendorId: string }[];
};

export type VendorDocument = {
  documentId: string;
  /** The vendor's own status word, lower-cased: sent, viewed, pending, completed, declined, canceled, expired, bounced… */
  status: string;
  declineMessage: string | null;
  recipients: { vendorId: string; email: string; name: string; status: string | null; bounced: boolean }[];
  metadata: Record<string, string>;
};

/** A webhook, verified. `signer` names the recipient the event is about. */
export type VerifiedEvent = {
  type: string;
  /** Unix seconds. */
  time: number;
  hash: string;
  documentId: string;
  agreementIdHint: string | null;
  signer: { email: string; name: string } | null;
  document: VendorDocument | null;
};

export class VendorError extends Error {
  constructor(
    public readonly kind: 'unreachable' | 'rejected' | 'not_found' | 'auth' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'VendorError';
  }
}

export interface ESignVendor {
  readonly name: string;
  send(req: SendRequest): Promise<SentDocument>;
  get(documentId: string): Promise<VendorDocument>;
  /** Cancels an open document; the vendor tells the signers. */
  cancel(documentId: string): Promise<void>;
  remind(documentId: string): Promise<void>;
  /** A new address for one recipient who has not signed; the vendor re-emails them. */
  updateRecipient(documentId: string, recipientVendorId: string, name: string, email: string): Promise<void>;
  /** The signed PDF with the audit page appended. */
  downloadCompleted(documentId: string): Promise<Uint8Array>;
  /** Parses and verifies a webhook body; null when it does not verify. */
  verifyWebhook(rawBody: string): VerifiedEvent | null;
}
