/**
 * The one place the CRM talks to a processor. Maverick first; another processor
 * is another adapter behind the same interface (spec: "built so other processors
 * can be added later").
 *
 * The Maverick adapter is in place without its endpoints: Maverick's API
 * documentation is not in yet (client, 4 Nov 2026: "Build now, plug API later").
 * Until it is, every call answers `ProcessorNotReady`, which the screens and the
 * daily sync turn into a plain sentence. Wiring Maverick in means filling in the
 * methods below; nothing else in the CRM changes.
 */
import 'server-only';
import { integrationValues, maverickReadyFrom } from '@/lib/integrations/resolve';

export const PROCESSOR = 'maverick';

/**
 * False until Maverick's endpoints are filled in below. While false the daily
 * sync stays idle (no failed run, no alert every morning) and Send to Maverick
 * explains why nothing was sent.
 */
export const ADAPTER_READY = false;
export const PROCESSOR_LABEL = 'Maverick';

/** A processor merchant, as the processor names it. */
export type VendorMerchant = { externalId: string; mid: string | null; name: string | null };
export type VendorTransaction = {
  externalId: string; cardType: string | null; cardBrand: string | null;
  /** Only the last four digits ever leave the adapter. */
  cardLast4: string | null; amount: number | null; terminalId: string | null; transactionType: string | null;
  messageType: string | null; paymentType: string | null; authorizedAt: string | null; responseCode: string | null; status: string | null;
};
export type VendorBatch = { externalId: string; batchDate: string | null; amount: number | null; sales: number | null; credits: number | null; batchCount: number | null };
export type VendorPayout = {
  externalId: string; payoutDate: string | null; depositAmount: number | null; chargebackCount: number | null; chargebackAmount: number | null;
  nonSettledAmount: number | null; feeAmount: number | null; reserveAmount: number | null; releasedAmount: number | null;
};
export type VendorAch = { externalId: string; transactionType: string | null; amount: number | null; contactName: string | null; memo: string | null; status: string | null; transactionDate: string | null; createdOn: string | null };
export type VendorTicket = { externalId: string; mid: string | null; title: string | null; status: string | null; details: { label: string; value: string }[]; openedAt: string | null; changedAt: string | null };
export type VendorStatement = { externalId: string; month: string; name: string; bytes: Uint8Array };
export type VendorApplicationStatus = { externalId: string; status: string; label: string };
export type VendorDocument = { row: string; name: string; bytes: Uint8Array; contentType: string };

export interface ProcessorVendor {
  merchants(): Promise<VendorMerchant[]>;
  transactions(m: VendorMerchant, since: Date): Promise<VendorTransaction[]>;
  batches(m: VendorMerchant, since: Date): Promise<VendorBatch[]>;
  payouts(m: VendorMerchant, since: Date): Promise<VendorPayout[]>;
  ach(m: VendorMerchant, since: Date): Promise<VendorAch[]>;
  statements(m: VendorMerchant, since: Date): Promise<VendorStatement[]>;
  tickets(m: VendorMerchant, since: Date): Promise<VendorTicket[]>;
  applicationStatus(externalId: string): Promise<VendorApplicationStatus>;
  /** Creates the application, or updates it when `externalId` is given. Returns the processor's id. */
  sendApplication(input: { externalId: string | null; fields: Record<string, unknown>; documents: VendorDocument[] }): Promise<{ externalId: string }>;
}

/** Not connected, or not built yet: nothing was sent or read. */
export class ProcessorNotReady extends Error {}
/** The processor refused or failed. `message` is safe to show: written here, never the processor's raw text. */
export class ProcessorError extends Error {
  constructor(message: string, readonly kind: 'unreachable' | 'rejected' | 'auth' = 'rejected') {
    super(message);
  }
}

const notYet = (): never => {
  throw new ProcessorNotReady('The Maverick connection isn’t switched on yet: it is wired in once Maverick’s API documentation is in. Nothing was sent.');
};

/** Maverick. Each method is filled in from Maverick's API documentation. */
const maverick: ProcessorVendor = {
  merchants: async () => notYet(),
  transactions: async () => notYet(),
  batches: async () => notYet(),
  payouts: async () => notYet(),
  ach: async () => notYet(),
  statements: async () => notYet(),
  tickets: async () => notYet(),
  applicationStatus: async () => notYet(),
  sendApplication: async () => notYet(),
};

/** The adapter, when the key is entered and the service is switched on in Integrations. */
export async function processorVendor(): Promise<ProcessorVendor> {
  if (!maverickReadyFrom(await integrationValues())) {
    throw new ProcessorNotReady('Maverick is not connected. A super admin enters the Maverick API key in CRM Settings › Integrations.');
  }
  return maverick;
}

export async function processorConnected(): Promise<boolean> {
  return maverickReadyFrom(await integrationValues());
}
