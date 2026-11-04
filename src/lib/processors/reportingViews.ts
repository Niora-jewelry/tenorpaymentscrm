/**
 * The Reporting tab's screens (Maverick Integration spec, Reporting tab): which
 * columns each one shows and which of them carry a filter on their header.
 *
 * Pure data, shared by the server (which filters) and the browser (which draws
 * the headers). Rules that hold for every screen:
 *  - read-only, no export, no download;
 *  - no totals or aggregate numbers anywhere;
 *  - card numbers: the last four digits only, never stored in full.
 */

export type ColumnKind = 'text' | 'money' | 'int' | 'date' | 'datetime' | 'last4';
/** values: an Excel-style checklist of what is in the column. date: a from/to range. last4: four digits. */
export type FilterKind = 'values' | 'date' | 'last4';

export type ReportColumn = { key: string; label: string; kind: ColumnKind; filter?: FilterKind; filterLabel?: string };

export type ReportViewKey = 'transactions' | 'batches' | 'payouts' | 'ach';
export type ReportSection = 'acquiring' | 'ach';

export type ReportView = {
  key: ReportViewKey;
  section: ReportSection;
  label: string;
  /** Server-only: the table it reads. */
  table: string;
  /** The column rows are ordered and date-filtered by. */
  dateColumn: string;
  columns: ReportColumn[];
  empty: string;
};

export const REPORT_VIEWS: readonly ReportView[] = [
  {
    key: 'transactions',
    section: 'acquiring',
    label: 'Acquiring transactions',
    table: 'processor_transactions',
    dateColumn: 'authorized_at',
    columns: [
      { key: 'card_type', label: 'Card type', kind: 'text', filter: 'values', filterLabel: 'Card brand' },
      { key: 'card_last4', label: 'Card number (last 4)', kind: 'last4', filter: 'last4', filterLabel: 'Card (last 4)' },
      { key: 'amount', label: 'Amount', kind: 'money' },
      { key: 'terminal_id', label: 'TID', kind: 'text', filter: 'values', filterLabel: 'Terminal' },
      { key: 'transaction_type', label: 'Transaction type', kind: 'text', filter: 'values' },
      { key: 'message_type', label: 'Message type', kind: 'text', filter: 'values' },
      { key: 'payment_type', label: 'Payment type', kind: 'text' },
      { key: 'authorized_at', label: 'Authorization date', kind: 'datetime', filter: 'date', filterLabel: 'Date' },
      { key: 'response_code', label: 'Response code', kind: 'text', filter: 'values' },
      { key: 'status', label: 'Status', kind: 'text' },
    ],
    empty: 'No transactions yet.',
  },
  {
    key: 'batches',
    section: 'acquiring',
    label: 'Batch reports',
    table: 'processor_batches',
    dateColumn: 'batch_date',
    columns: [
      { key: 'batch_date', label: 'Date', kind: 'date', filter: 'date' },
      { key: 'amount', label: 'Amount', kind: 'money' },
      { key: 'sales', label: 'Sales', kind: 'money' },
      { key: 'credits', label: 'Credits', kind: 'money' },
      { key: 'batch_count', label: 'Number of batches', kind: 'int' },
    ],
    empty: 'No batches yet.',
  },
  {
    key: 'payouts',
    section: 'acquiring',
    label: 'Payout reports',
    table: 'processor_payouts',
    dateColumn: 'payout_date',
    columns: [
      { key: 'payout_date', label: 'Payout date', kind: 'date', filter: 'date' },
      { key: 'deposit_amount', label: 'Deposit amount', kind: 'money' },
      { key: 'chargeback_count', label: 'Chargeback count', kind: 'int' },
      { key: 'chargeback_amount', label: 'Chargeback amount', kind: 'money' },
      { key: 'non_settled_amount', label: 'Non-settled amount', kind: 'money' },
      { key: 'fee_amount', label: 'Fee amount', kind: 'money' },
      { key: 'reserve_amount', label: 'Reserve amount', kind: 'money' },
      { key: 'released_amount', label: 'Released amount', kind: 'money' },
    ],
    empty: 'No payouts yet.',
  },
  {
    key: 'ach',
    section: 'ach',
    label: 'Transactions',
    table: 'processor_ach_transactions',
    dateColumn: 'transaction_date',
    columns: [
      { key: 'transaction_type', label: 'Transaction type', kind: 'text' },
      { key: 'amount', label: 'Amount', kind: 'money' },
      { key: 'contact_name', label: 'Contact name', kind: 'text' },
      { key: 'memo', label: 'Memo', kind: 'text' },
      { key: 'status', label: 'Status', kind: 'text' },
      { key: 'transaction_date', label: 'Transaction date', kind: 'date', filter: 'date' },
      { key: 'created_on', label: 'Created on', kind: 'datetime' },
    ],
    // Spec: "Many merchants have none, so an empty screen shows a simple 'No ACH activity' message."
    empty: 'No ACH activity.',
  },
];

export const SECTIONS: { key: ReportSection; label: string }[] = [
  { key: 'acquiring', label: 'Acquiring' },
  { key: 'ach', label: 'ACH' },
];

export const reportView = (key: string): ReportView | undefined => REPORT_VIEWS.find((v) => v.key === key);

/** What the browser sends: per column, the ticked values, a date range, or four digits. */
export type ReportFilters = Record<string, { values?: string[]; from?: string; to?: string; last4?: string }>;

export const PAGE_SIZE = 100;
