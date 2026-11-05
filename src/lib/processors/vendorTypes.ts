/** What every processor adapter answers with. No server code here, so an adapter can import it freely. */
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
