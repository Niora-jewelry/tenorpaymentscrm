/**
 * Tenor Payments' own details, printed on the documents the CRM produces: the
 * application, the proposal and the ACH Authorization page. Never on the Maverick
 * agreement itself, which is the processor's contract and is not changed (client,
 * 4 Nov 2026: "Please insert on all docs (not contract)").
 *
 * One place, so an address change is one edit.
 */
export const TENOR = {
  legalName: 'Tenor Payments LLC',
  company: 'Tenor Payments',
  address: '902 East County Line Road, STE 101, Lakewood, NJ 08701',
  phone: '(732) 479-3050',
  supportEmail: 'support@tenorpayments.com',
  salesEmail: 'sales@tenorpayments.com',
} as const;
