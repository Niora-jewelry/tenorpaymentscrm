/**
 * PROTOTYPE — the field definitions.
 *
 * 138 fields as of 19 Aug 2026 (`CRM-19aug.xlsx`, up from 81 on the 18th),
 * transcribed exactly: names, types, choice lists, notes annotations and the
 * "Top of drawer" column. The Pricing tab, empty until this pass ("the fields
 * for pricing tab — this will hopefully be completed tomorrow"), is now the
 * single largest group in the file — 57 fields across its 4 restructured
 * subtabs, plus 7 more for the new Merchant Equipment List tab.
 *
 * Under the Global Amendment each field carries ONE `tab`, globally. There is
 * no per-module placement any more — that table is gone, and with it the most
 * complicated part of the field engine.
 *
 * Two properties still vary per module, because the sheet varies them:
 *   headerIn        — "Yes", "Yes - Leads only", "Yes - Leads and tickets
 *                      only", and now "Yes - contacts/residuals only" (19 Aug)
 *   choicesByModule — "This is different statuses per module"
 *
 * Identifier types are ours, not the sheet's. The sheet types MID, MCC, EIN,
 * SSN, account and routing as `Number`; a numeric column cannot hold a leading
 * zero (MCC 0742 becomes 742) nor enforce MCC's "four digits". They
 * are digit strings. Narrowing text to numeric later is possible; recovering a
 * dropped leading zero is not.
 */
import type { Field, FieldType, ModuleSlug, Choice } from './schema';

const ALL_MODULES: ModuleSlug[] = [
  'records', 'leads', 'deals', 'contacts', 'tickets', 'residuals',
];
const LEADS_ONLY: ModuleSlug[] = ['leads'];
const LEADS_TICKETS: ModuleSlug[] = ['leads', 'tickets'];
/** New 19 Aug scope, on Pricing Model and the new Risk Level. */
const CONTACTS_RESIDUALS: ModuleSlug[] = ['contacts', 'residuals'];

/** Terse constructor so 80-odd definitions stay readable. */
function f(
  id: string,
  label: string,
  type: FieldType,
  tab: string,
  extra: Partial<Field> = {},
): Field {
  return { id, label, type, tab, columnIn: [], ...extra };
}

const YES_NO: Choice[] = [{ value: 'Yes' }, { value: 'No' }];
const c = (...vals: string[]): Choice[] => vals.map((value) => ({ value }));

/* -------------------------------------------------------------------------- */

export const FIELDS: Field[] = [
  /* ====================================================================== */
  /* System fields — not on the Fields sheet, because they are structural    */
  /* ====================================================================== */
  f('deal_name', 'Deal Name', 'text', 'overview', {
    system: true,
    required: true,
    width: 250,
    hint: 'Frozen first column of every module, drawer title, and the duplicate-block key.',
  }),
  f('record_creator', 'Record creator', 'team_member', 'overview', {
    system: true,
    readOnly: true,
    columnIn: ['records'],
    columnOrder: 300,
    width: 170,
    hint: 'A team member or a marketing campaign. Set on creation, never editable, and grants no visibility.',
  }),

  /* ====================================================================== */
  /* Overview                                                                */
  /* ====================================================================== */
  f('legal_business_name', 'Legal business name', 'text', 'overview', {
    headerIn: ALL_MODULES,
    columnIn: ['records', 'leads', 'deals', 'contacts', 'tickets', 'residuals'],
    columnOrder: 20,
    width: 230,
  }),
  f('mid', 'MID', 'identifier', 'overview', {
    // No digit count: the client asked for the 8-or-9 rule to go (migration
    // …9760). Digits only still applies — that is the identifier type itself.
    hint: 'Digits only. Length varies by processor.',
    headerIn: ALL_MODULES,
    columnIn: ['records', 'deals', 'contacts', 'tickets', 'residuals'],
    columnOrder: 30,
    width: 130,
  }),
  /*
   * 19 Aug: the old standalone Risk level (No risk/Low/Medium/High) is gone
   * from the sheet entirely. Pricing Model takes its old column slot here;
   * a DIFFERENT, new Risk Level (different wording, different choices) lands
   * under Processor-TD Merchant Pricing below — see that field for why it is
   * treated as distinct rather than a rename.
   */
  f('pricing_model', 'Pricing Model', 'dropdown', 'overview', {
    choices: c('IC+', 'DP', 'FR'),
    headerIn: CONTACTS_RESIDUALS,
    columnIn: ['records', 'contacts', 'residuals'],
    columnOrder: 50,
    width: 110,
  }),
  f('team_members_assigned', 'Team member(s) assigned', 'team_member', 'overview', {
    hint: 'Choose from team members; ability to add & remove. The ONLY field that grants record visibility.',
    headerIn: ALL_MODULES,
    columnIn: ['records', 'leads', 'deals', 'contacts', 'tickets', 'residuals'],
    columnOrder: 40,
    width: 180,
  }),
  f('relationship_manager', 'Relationship manager', 'team_member', 'overview', {
    hint: 'Choose from team members. Informational — grants no record visibility.',
    headerIn: ALL_MODULES,
    columnIn: ['records', 'contacts'],
    columnOrder: 210,
    width: 180,
  }),
  f('last_merchant_response', 'Last merchant response', 'date', 'overview', {
    headerIn: LEADS_TICKETS,
    columnIn: ['records', 'leads', 'tickets'],
    columnOrder: 130,
    width: 170,
  }),
  f('last_outreach', 'Last outreach', 'date', 'overview', {
    headerIn: LEADS_TICKETS,
    columnIn: ['records', 'leads', 'tickets'],
    columnOrder: 120,
    width: 150,
  }),
  f('onboard_date', 'Onboard date', 'date', 'overview', {
    columnIn: ['records', 'deals', 'contacts'],
    columnOrder: 110,
    width: 150,
  }),
  f('mcc_code', 'MCC code', 'identifier', 'overview', {
    digits: [4],
    hint: 'Four digits. Leading zeros are significant — 0742 is veterinary services.',
    headerIn: ALL_MODULES,
    columnIn: ['records', 'deals'],
    columnOrder: 105,
    width: 120,
  }),
  f('merchant_industry', 'Merchant industry', 'text', 'overview', {
    columnIn: ['records', 'leads', 'deals', 'contacts'],
    columnOrder: 100,
    width: 190,
  }),
  f('merchant_website', 'Merchant website', 'url', 'overview', {
    columnIn: ['records'],
    columnOrder: 215,
    width: 210,
  }),
  /*
   * "This is different statuses per module" — the one field using the
   * per-module choice override. The base list is the sheet's own
   * Urgent/High/Mid/Low; each module may replace it.
   */
  f('current_status', 'Current Status', 'status', 'overview', {
    headerIn: ALL_MODULES,
    hint: 'Choices are configured per module.',
    choices: [
      { value: 'Urgent', swatch: 'red' },
      { value: 'High', swatch: 'orange' },
      { value: 'Mid', swatch: 'amber' },
      { value: 'Low', swatch: 'slate' },
    ],
    choicesByModule: {
      leads: [
        { value: 'New lead', swatch: 'slate' },
        { value: 'Working', swatch: 'blue' },
        { value: 'Qualified', swatch: 'indigo' },
        { value: 'Proposal sent', swatch: 'amber' },
        { value: 'Closed', swatch: 'teal' },
      ],
      deals: [
        { value: 'Application sent', swatch: 'slate' },
        { value: 'Underwriting', swatch: 'purple' },
        { value: 'Approved', swatch: 'green' },
        { value: 'Live', swatch: 'lime' },
        { value: 'Declined', swatch: 'red' },
      ],
      contacts: [
        { value: 'Onboarding', swatch: 'blue' },
        { value: 'Active', swatch: 'teal' },
        { value: 'At risk', swatch: 'amber' },
        { value: 'Churned', swatch: 'red' },
      ],
    },
    columnIn: ['records', 'leads', 'deals', 'contacts', 'tickets'],
    columnOrder: 10,
    width: 160,
  }),

  /* ====================================================================== */
  /* Contact                                                                 */
  /* ====================================================================== */
  f('affiliate_business_name', 'Affiliate business name', 'text', 'contact', {
    headerIn: ALL_MODULES,
    columnIn: ['records'],
    columnOrder: 200,
    width: 220,
  }),
  f('merchant_address', 'Merchant address', 'address', 'contact', {
    hint: 'City, State, Zip.',
    notes: true,
    wide: true,
    columnIn: ['records'],
    columnOrder: 220,
    width: 300,
  }),
  f('contact_name_1', 'Contact name 1', 'text', 'contact', {
    repeatGroup: { key: 'contact', max: 5 },
    columnIn: ['records', 'leads'],
    columnOrder: 160,
    width: 170,
  }),
  f('contact_email_1', 'Contact email 1', 'email', 'contact', {
    repeatGroup: { key: 'contact', max: 5 },
    sync: true,
    columnIn: ['records', 'leads'],
    columnOrder: 170,
    width: 230,
  }),
  f('contact_phone_1', 'Contact phone 1', 'phone', 'contact', {
    repeatGroup: { key: 'contact', max: 5 },
    sync: true,
    columnIn: ['records', 'leads'],
    columnOrder: 180,
    width: 160,
  }),
  f('affiliate_main_email', 'Affiliate main email', 'email', 'contact', { width: 230 }),
  f('affiliate_main_phone', 'Affiliate main phone', 'phone', 'contact', { width: 160 }),
  f('affiliate_name_1', 'Affiliate name 1', 'text', 'contact', {
    repeatGroup: { key: 'affiliate', max: 5 },
    width: 170,
  }),
  f('affiliate_email_1', 'Affiliate email 1', 'email', 'contact', {
    repeatGroup: { key: 'affiliate', max: 5 },
    width: 230,
  }),
  f('affiliate_phone_1', 'Affiliate phone 1', 'phone', 'contact', {
    repeatGroup: { key: 'affiliate', max: 5 },
    width: 160,
  }),

  /* ====================================================================== */
  /* Marketing                                                               */
  /* ====================================================================== */
  f('campaign', 'Campaign', 'dropdown', 'marketing', {
    hint: 'Tied to campaign types. Placeholder until the campaigns build.',
    placeholder: true,
    choices: c('Q3 Restaurant Push', 'Ecom Outbound', 'Referral Partner Drive', 'Renewal Winback'),
    columnIn: ['records', 'leads'],
    columnOrder: 140,
    width: 190,
  }),
  f('pitch', 'Pitch', 'dropdown', 'marketing', {
    hint: 'Tied to pitch types. Placeholder until the campaigns build.',
    placeholder: true,
    choices: c('Rate savings', 'Cash discount', 'Next-day funding', 'POS upgrade'),
    columnIn: ['records', 'leads'],
    columnOrder: 150,
    width: 170,
  }),
  f('ad_campaign', 'Ad campaign', 'dropdown', 'marketing', {
    hint: 'Choose from campaigns.',
    placeholder: true,
    headerIn: LEADS_ONLY,
    choices: c('Q3 Restaurant Push', 'Ecom Outbound', 'Referral Partner Drive'),
    columnIn: ['records'],
    columnOrder: 250,
    width: 190,
  }),
  f('date_lead_generated', 'Date lead generated', 'date', 'marketing', {
    headerIn: LEADS_ONLY,
    columnIn: ['records', 'leads'],
    columnOrder: 195,
    width: 170,
  }),

  /* ====================================================================== */
  /* Application → General                                                   */
  /* ====================================================================== */
  f('retail_address', 'Retail address', 'address', 'application/general', {
    hint: 'City, State, Zip. Can choose N/A.',
    wide: true,
    width: 300,
  }),
  f('dba', 'DBA', 'text', 'application/general', {
    columnIn: ['records'],
    columnOrder: 230,
    width: 200,
  }),
  f('entity_type', 'Entity type', 'dropdown', 'application/general', {
    choices: c('Sole prop', 'Partnership', 'Corp', 'Gov', 'LLC', 'NP', 'Public'),
    columnIn: ['records', 'deals'],
    columnOrder: 235,
    width: 150,
  }),
  f('describe_product_service', 'Describe product/service', 'long_text', 'application/general', {
    wide: true,
    width: 320,
  }),
  f('fax_number', 'Fax number', 'phone', 'application/general', { width: 160 }),
  f('business_founded_date', 'Business founded date', 'date', 'application/general', { width: 170 }),
  f('seasonal', 'Seasonal', 'months', 'application/general', {
    hint: 'Choose No, or the months the business is seasonal. Add a note if needed.',
    notes: true,
    wide: true,
    width: 260,
  }),
  f('charge_to_service', 'How long after charge is service/product received', 'dropdown', 'application/general', {
    choices: c('24 hours', '2 days', '3-10 days', '11-30 days', '31-90 days', '90+ days'),
    width: 200,
  }),
  f('order_to_service', 'How long after order is service/product received', 'dropdown', 'application/general', {
    choices: c('24 hours', '2-5 days', '6-10 days', '11+ days'),
    width: 200,
  }),
  f('building_type', 'Building type', 'dropdown', 'application/general', {
    choices: c('Shopping center', 'Office building', 'Industrial', 'Residence'),
    width: 180,
  }),
  f('building_ownership', 'Building ownership', 'dropdown', 'application/general', {
    choices: c('Owns', 'Rents'),
    width: 150,
  }),
  f('area_zoned', 'Area zoned', 'dropdown', 'application/general', {
    choices: c('Commercial', 'Industrial', 'Residential'),
    width: 150,
  }),
  f('square_footage', 'Square footage', 'dropdown', 'application/general', {
    choices: c('0-500', '501-2500', '2501-5000', '5001-10000', '10000+'),
    width: 150,
  }),
  f('inventory', 'Inventory', 'dropdown', 'application/general', {
    choices: c('On-site', 'Off-site', '3rd party', 'Service only'),
    hint: 'Notes section as well.',
    notes: true,
    width: 160,
  }),
  f('other_fulfillment', 'Other fulfillment companies', 'dropdown', 'application/general', {
    choices: YES_NO,
    width: 200,
  }),
  f('recurring_subscription', 'Recurring or subscription services', 'dropdown', 'application/general', {
    choices: YES_NO,
    width: 220,
  }),
  f('when_charged', 'When is customer charged', 'dropdown', 'application/general', {
    choices: c('Time of order', 'Upon shipment'),
    width: 190,
  }),
  f('advertising_method', 'Advertising method', 'text', 'application/general', { width: 200 }),
  f('third_party_shipping', 'Third party shipping/fulfillment', 'dropdown', 'application/general', {
    choices: YES_NO,
    width: 210,
  }),
  f('refund_policy', 'Refund policy', 'long_text', 'application/general', { wide: true, width: 300 }),
  f('bankruptcy', 'Bankruptcy', 'multi_select', 'application/general', {
    choices: c('Business', 'Personal', 'Never'),
    hint: 'Can choose more than one; with a notes section.',
    notes: true,
    width: 200,
  }),
  f('customer_type', 'Customer type', 'percent_split', 'application/general', {
    choices: c('Business', 'Gov', 'Individual'),
    hint: 'Must total 100%.',
    wide: true,
    width: 240,
  }),
  f('customer_profile', 'Customer profile', 'percent_split', 'application/general', {
    choices: c('Local', 'National', 'International'),
    hint: 'Must total 100%.',
    wide: true,
    width: 240,
  }),
  f('sales_method', 'Sales method', 'percent_split', 'application/general', {
    choices: c('In person', 'Mail/phone', 'Ecommerce'),
    hint: 'Must total 100%.',
    wide: true,
    width: 240,
  }),

  /* ====================================================================== */
  /* Application → Financial                                                 */
  /* ====================================================================== */
  f('monthly_acq_volume', 'Monthly ACQ volume', 'currency', 'application/financial', {
    headerIn: LEADS_ONLY,
    columnIn: ['records', 'leads', 'deals', 'contacts', 'residuals'],
    columnOrder: 80,
    width: 160,
  }),
  f('monthly_ach_volume', 'Monthly ACH volume', 'currency', 'application/financial', {
    columnIn: ['records', 'deals', 'residuals'],
    columnOrder: 90,
    width: 160,
  }),
  f('avg_transaction', 'Average transaction amount', 'currency', 'application/financial', {
    columnIn: ['records', 'deals'],
    columnOrder: 240,
    width: 180,
  }),
  f('max_transaction', 'Maximum transaction amount', 'currency', 'application/financial', { width: 190 }),
  f('amex_monthly_volume', 'Amex monthly volume', 'currency', 'application/financial', { width: 180 }),

  /* ====================================================================== */
  /* Application → ACQ                                                       */
  /* ====================================================================== */
  f('cc_termination', 'CC Termination', 'dropdown', 'application/acq', {
    choices: YES_NO,
    hint: 'With a notes section.',
    notes: true,
    width: 160,
  }),
  f('amex_esa', 'AMEX ESA #', 'identifier', 'application/acq', { width: 150 }),
  f('ebt_fns', 'EBT FNS', 'identifier', 'application/acq', { width: 140 }),

  /* ====================================================================== */
  /* Application → ACH                                                       */
  /* ====================================================================== */
  f('ach_monthly_returns', 'ACH monthly returns', 'number', 'application/ach', { width: 170 }),
  f('ach_credits_required', 'ACH credits required', 'dropdown', 'application/ach', {
    choices: YES_NO,
    hint: 'Notes section needed.',
    notes: true,
    width: 180,
  }),
  f('payment_codes', 'Payment codes', 'percent_split', 'application/ach', {
    choices: c('PPD', 'CCD', 'Web', 'Tel'),
    hint: 'Must total 100%.',
    wide: true,
    width: 260,
  }),
  f('ach_termination', 'ACH termination', 'dropdown', 'application/ach', {
    choices: YES_NO,
    hint: 'Notes section required.',
    notes: true,
    width: 170,
  }),

  /* ====================================================================== */
  /* Application → Private — the sensitive block                             */
  /* ====================================================================== */
  f('ein', 'EIN', 'identifier', 'application/private', {
    digits: [9],
    sensitive: true,
    width: 150,
  }),
  f('account_number', 'Account number', 'identifier', 'application/private', {
    sensitive: true,
    width: 170,
  }),
  f('routing_number', 'Routing number', 'identifier', 'application/private', {
    digits: [9],
    sensitive: true,
    hint: 'Nine digits. Identifies the bank, not the account — this one is public information.',
    width: 160,
  }),
  f('owner_1_ssn', 'Owner 1 SSN', 'identifier', 'application/private', {
    digits: [9],
    sensitive: true,
    repeatGroup: { key: 'owner', max: 5 },
    hint: 'Can add up to 5 owners.',
    width: 150,
  }),

  /* ====================================================================== */
  /* Application → Ownership — repeatable up to 5                            */
  /* ====================================================================== */
  f('owner_1_first', 'Owner 1 first name', 'text', 'application/ownership', {
    repeatGroup: { key: 'owner', max: 5 },
    width: 170,
  }),
  f('owner_1_last', 'Owner 1 last name', 'text', 'application/ownership', {
    repeatGroup: { key: 'owner', max: 5 },
    width: 170,
  }),
  f('owner_1_title', 'Owner 1 title', 'text', 'application/ownership', {
    repeatGroup: { key: 'owner', max: 5 },
    width: 160,
  }),
  f('owner_1_phone', 'Owner 1 phone', 'phone', 'application/ownership', {
    repeatGroup: { key: 'owner', max: 5 },
    sync: true,
    width: 160,
  }),
  f('owner_1_email', 'Owner 1 email', 'email', 'application/ownership', {
    repeatGroup: { key: 'owner', max: 5 },
    sync: true,
    width: 230,
  }),
  f('owner_1_percentage', 'Owner 1 percentage', 'percentage', 'application/ownership', {
    repeatGroup: { key: 'owner', max: 5 },
    hint: '1 – 100%.',
    width: 150,
  }),

  /* ====================================================================== */
  /* Application → Prior Processor                                           */
  /* ====================================================================== */
  f('prior_processor', 'Prior processor', 'text', 'application/prior', {
    columnIn: ['records', 'leads'],
    columnOrder: 190,
    width: 180,
  }),
  f('prior_gateway', 'Prior gateway', 'text', 'application/prior', { width: 170 }),
  f('prior_pos', 'Prior POS', 'text', 'application/prior', { width: 170 }),
  f('prior_pos_agnostic', 'Prior POS agnostic', 'checkbox', 'application/prior', {
    hint: 'From the sheet’s note on Prior POS: agnostic or not agnostic.',
    columnIn: ['records'],
    columnOrder: 192,
    width: 150,
  }),
  f('prior_acq_pricing_model', 'Prior ACQ pricing model', 'dropdown', 'application/prior', {
    choices: c('DP', 'Flat', 'IC+', 'Tiered'),
    width: 180,
  }),
  f('prior_ach_provider', 'Prior ACH provider', 'text', 'application/prior', { width: 180 }),
  f('prior_terminal_provider', 'Prior terminal provider', 'text', 'application/prior', { width: 190 }),

  /* ====================================================================== */
  /* Pricing → Processor-TD Merchant Pricing                                 */
  /* "the fees the merchant pays the processor/TapDash. TapDash participates */
  /* in these fees."                                                        */
  /* ====================================================================== */
  /*
   * Risk Level here is NEW and DISTINCT from the old Overview "Risk level"
   * that the 19 Aug sheet drops entirely — different wording (No risk/Low
   * risk/Moderate risk/High risk vs the old No risk/Low/Medium/High),
   * different tab, and nothing in the sheet says the two are the same field.
   * Treating a rename as a new field when uncertain costs a duplicate;
   * treating a genuinely new field as a rename loses the old data's meaning.
   * The duplicate is the recoverable mistake.
   */
  f('pricing_risk_level', 'Risk Level', 'status', 'pricing/td_merchant', { section: 'Acquirer/ACH merchant pricing',
    choices: [
      { value: 'No risk', swatch: 'slate' },
      { value: 'Low risk', swatch: 'teal' },
      { value: 'Moderate risk', swatch: 'amber' },
      { value: 'High risk', swatch: 'red' },
    ],
    headerIn: CONTACTS_RESIDUALS,
    columnIn: ['records', 'contacts', 'residuals'],
    columnOrder: 55,
    width: 130,
  }),
  f('td_amex_auth_fee', 'Amex Auth Fee', 'currency', 'pricing/td_merchant', { section: 'Acquirer/ACH merchant pricing', width: 140 }),
  f('td_vmd_auth_fee', 'VMD Auth Fee', 'currency', 'pricing/td_merchant', { section: 'Acquirer/ACH merchant pricing', width: 130 }),
  f('td_pin_debit_auth_fee', 'Pin Debit Auth Fee', 'currency', 'pricing/td_merchant', { section: 'Acquirer/ACH merchant pricing', width: 150 }),
  f('td_amex_volume', 'Amex Volume', 'percentage', 'pricing/td_merchant', { section: 'Acquirer/ACH merchant pricing', width: 130 }),
  f('td_vmd_volume', 'VMD Volume', 'percentage', 'pricing/td_merchant', { section: 'Acquirer/ACH merchant pricing', width: 120 }),
  f('td_pin_debit_volume', 'Pin Debit Volume', 'percentage', 'pricing/td_merchant', { section: 'Acquirer/ACH merchant pricing', width: 150 }),
  f('td_chargeback_fee', 'Chargeback Fee', 'currency', 'pricing/td_merchant', { section: 'Acquirer/ACH merchant pricing', width: 140 }),
  f('td_vmd_transaction_fee', 'VMD Transaction Fee', 'currency', 'pricing/td_merchant', { section: 'Acquirer/ACH merchant pricing', width: 160 }),
  f('td_avs_fee', 'AVS Fee', 'currency', 'pricing/td_merchant', { section: 'Acquirer/ACH merchant pricing', width: 120 }),
  f('td_batch_fee', 'Batch Fee', 'currency', 'pricing/td_merchant', { section: 'Acquirer/ACH merchant pricing', width: 120 }),
  f('td_monthly_fee', 'Monthly Fee', 'currency', 'pricing/td_merchant', { section: 'Acquirer/ACH merchant pricing', width: 130 }),
  f('td_ebt_volume', 'EBT (Volume)', 'percentage', 'pricing/td_merchant', { section: 'Acquirer/ACH merchant pricing', width: 140 }),
  f('td_amex_template_volume_fee', 'Amex Template Volume Fee', 'percentage', 'pricing/td_merchant', { section: 'Acquirer/ACH merchant pricing',
    width: 200,
  }),
  f('td_gateway_provider_mav', 'Gateway provider', 'text', 'pricing/td_merchant', { width: 190, section: 'TD-Mav other buy rate' }),
  f('td_gateway_monthly_mav', 'Gateway Monthly', 'currency', 'pricing/td_merchant', { width: 180, section: 'TD-Mav other buy rate' }),
  f('td_gateway_auth_fee_mav', 'Gateway auth fee', 'currency', 'pricing/td_merchant', { width: 190, section: 'TD-Mav other buy rate' }),
  f('td_terminal_provider_mav', 'Terminal provider', 'text', 'pricing/td_merchant', { width: 190, section: 'TD-Mav other buy rate' }),
  f('td_terminal_monthly_mav', 'Terminal Monthly', 'currency', 'pricing/td_merchant', { width: 190, section: 'TD-Mav other buy rate' }),
  f('td_gateway_setup_mav', 'Gateway setup (one time)', 'currency', 'pricing/td_merchant', { width: 190, section: 'TD-Mav other buy rate' }),
  f('td_terminal_setup_mav', 'Terminal setup (one-time)', 'currency', 'pricing/td_merchant', { width: 190, section: 'TD-Mav other buy rate' }),
  f('td_gateway_per_item_mav', 'Gateway per item', 'currency', 'pricing/td_merchant', { width: 170, section: 'TD-Mav other buy rate' }),
  f('td_terminal_per_item_mav', 'Terminal per item', 'currency', 'pricing/td_merchant', { width: 170, section: 'TD-Mav other buy rate' }),
  f('td_terminal_auth_fee_mav', 'Terminal auth fee', 'currency', 'pricing/td_merchant', {
    section: 'TD-Mav other buy rate',
    width: 190,
  }),
  f('td_monthly_fee_tapdash', 'Monthly Fee - TapDash', 'currency', 'pricing/td_merchant', { section: 'Acquirer/ACH merchant pricing', width: 190 }),
  f('td_lease_payments_tapdash', 'Lease Payments - TapDash', 'currency', 'pricing/td_merchant', { section: 'Acquirer/ACH merchant pricing',
    width: 200,
  }),
  f('td_ach_transaction_fee', 'ACH transaction fee', 'currency', 'pricing/td_merchant', { width: 180, section: 'Acquirer/ACH merchant pricing' }),
  f('td_ach_return', 'ACH return', 'currency', 'pricing/td_merchant', { width: 150, section: 'Acquirer/ACH merchant pricing' }),
  f('td_ach_monthly_gateway_fee', 'ACH monthly gateway fee', 'currency', 'pricing/td_merchant', { width: 200, section: 'Acquirer/ACH merchant pricing' }),
  f('td_ach_debit_unauthorized_fee', 'ACH Debit unauthorized fee', 'currency', 'pricing/td_merchant', { width: 220, section: 'Acquirer/ACH merchant pricing' }),
  f('td_ach_bin', 'ACH BIN', 'text', 'pricing/td_merchant', { width: 150, section: 'Acquirer/ACH merchant pricing' }),

  /* ====================================================================== */
  /* Pricing → Processor-Vendor Pricing to TD                                */
  /* "the costs incurred by TapDash to pay for the merchants operations. The */
  /* Merchant does not participate in these costs."                         */
  /* ====================================================================== */
  f('vtd_gateway_provider', 'Gateway Provider', 'text', 'pricing/vendor_to_td', { width: 170 }),
  f('vtd_gateway_monthly_fee', 'Gateway Monthly Fee', 'currency', 'pricing/vendor_to_td', { width: 180 }),
  f('vtd_gateway_auth_fee', 'Gateway Auth Fee', 'currency', 'pricing/vendor_to_td', { width: 160 }),
  f('vtd_gateway_per_update', 'Gateway Per Update', 'currency', 'pricing/vendor_to_td', { width: 170 }),
  f('vtd_gateway_td_setup_fee', 'Gateway-TD setup fee', 'currency', 'pricing/vendor_to_td', { width: 180 }),
  f('vtd_terminal_provider', 'Terminal provider', 'text', 'pricing/vendor_to_td', { width: 170 }),
  f('vtd_terminal_monthly_fee', 'Terminal Monthly Fee', 'currency', 'pricing/vendor_to_td', {
    width: 180,
  }),
  f('vtd_terminal_transaction_fee', 'Terminal Transaction Fee', 'currency', 'pricing/vendor_to_td', {
    width: 200,
  }),
  f('vtd_terminal_td_setup_fee', 'Terminal-TD setup fee', 'currency', 'pricing/vendor_to_td', { width: 180 }),
  f('vtd_rewards_provider', 'Rewards Provider', 'text', 'pricing/vendor_to_td', { width: 170 }),
  f('vtd_rewards_volume_cost', 'Rewards Volume Cost', 'percentage', 'pricing/vendor_to_td', {
    width: 180,
  }),
  f('vtd_other_provider', 'Other Provider', 'text', 'pricing/vendor_to_td', { width: 160 }),
  f('vtd_other_monthly_fee', 'Other Monthly Fee', 'currency', 'pricing/vendor_to_td', { width: 170 }),
  f('vtd_merchynt_monthly', 'Merchynt monthly', 'currency', 'pricing/vendor_to_td', { width: 170 }),
  f('vtd_tuzo_monthly', 'Tuzo Monthly', 'currency', 'pricing/vendor_to_td', { width: 160 }),
  f('vtd_tuzo_volume', 'Tuzo volume (percentage)', 'percentage', 'pricing/vendor_to_td', { width: 190 }),
  f('vtd_pos_plus_monthly', 'POS+ monthly', 'currency', 'pricing/vendor_to_td', { width: 160 }),
  f('vtd_pos_volume', 'POS volume', 'percentage', 'pricing/vendor_to_td', { width: 160 }),
  f('vtd_support_agent', 'Support agent', 'currency', 'pricing/vendor_to_td', { width: 160 }),
  f('vtd_tapdash_direct', 'TapDash direct', 'currency', 'pricing/vendor_to_td', { width: 160 }),

  /* ====================================================================== */
  /* Pricing → One Time Charges                                              */
  /* "all one time charges incurred by either the merchant or TD."          */
  /*                                                                        */
  /* No field rows in the sheet at all — the client described this one in   */
  /* chat instead: "Similar to logins tab: [columns] and user can add as    */
  /* needed — Vendor name, Charge amount (currency format), Date (date      */
  /* format), Paid by, Notes." One grid field, typed columns, so Charge     */
  /* amount actually formats as currency and Date is actually a date picker */
  /* rather than four free-text boxes with a label next to them.            */
  /* ====================================================================== */
  f('one_time_charges', 'One Time Charges', 'grid', 'pricing/one_time_charges', {
    columns: [
      { label: 'Vendor name', type: 'text' },
      { label: 'Charge amount', type: 'currency' },
      { label: 'Date', type: 'date' },
      { label: 'Paid by', type: 'text' },
      { label: 'Notes', type: 'long_text' },
    ],
    hint: 'Unlimited rows — add one per charge, similar to the Logins tab.',
    wide: true,
  }),

  /* ====================================================================== */
  /* Pricing → Other Vendor Merchant Payments                                */
  /* "payments the merchant is in contract directly with vendors other than */
  /* TapDash. TapDash does not participate in these costs/revenues."        */
  /* ====================================================================== */
  f('ovmp_processor_provider', 'Processor Provider', 'text', 'pricing/other_vendor', { width: 180 }),
  f('ovmp_monthly_pci_fee', 'Monthly PCI Fee', 'currency', 'pricing/other_vendor', { width: 160 }),
  f('ovmp_monthly_website_monitoring_fee', 'Monthly Website Monitoring Fee', 'currency', 'pricing/other_vendor', {
    width: 220,
  }),
  f('ovmp_irs_annual_fee', 'IRS Annual Fee (once annually)', 'currency', 'pricing/other_vendor', {
    width: 210,
  }),
  f('ovmp_gateway_provider', 'Gateway Provider', 'text', 'pricing/other_vendor', { width: 170 }),
  f('ovmp_gateway_monthly_fee', 'Gateway Monthly Fee', 'currency', 'pricing/other_vendor', { width: 180 }),
  f('ovmp_gateway_auth_fee', 'Gateway Auth Fee', 'currency', 'pricing/other_vendor', { width: 160 }),
  f('ovmp_gateway_per_update', 'Gateway Per Update', 'currency', 'pricing/other_vendor', { width: 170 }),
  f('ovmp_terminal_provider', 'Terminal provider', 'text', 'pricing/other_vendor', { width: 170 }),
  f('ovmp_terminal_monthly_fee', 'Terminal Monthly Fee', 'currency', 'pricing/other_vendor', {
    width: 180,
  }),
  f('ovmp_terminal_transaction_fee', 'Terminal Transaction Fee', 'currency', 'pricing/other_vendor', {
    width: 200,
  }),
  f('ovmp_internet_service_provider', 'Internet Service Provider', 'text', 'pricing/other_vendor', {
    width: 200,
  }),
  f('ovmp_internet_monthly_cost', 'Internet Monthly Cost', 'currency', 'pricing/other_vendor', {
    width: 190,
  }),
  f('ovmp_pos_provider', 'POS Provider', 'text', 'pricing/other_vendor', { width: 150 }),
  f('ovmp_pos_monthly_fee', 'POS Monthly Fee', 'currency', 'pricing/other_vendor', { width: 160 }),
  f('ovmp_pos_auth_fee', 'POS Auth Fee', 'currency', 'pricing/other_vendor', { width: 140 }),

  /* ====================================================================== */
  /* Merchant Equipment List — new custom tab, 19 Aug                        */
  /* ====================================================================== */
  f('equip_gateway_provider', 'Gateway Provider', 'text', 'equipment', { width: 170 }),
  f('equip_gateway_payment_pages', 'Gateway Payment Pages', 'text', 'equipment', { width: 190 }),
  f('equip_gateway_card_updater', 'Gateway Card Updater', 'text', 'equipment', { width: 190 }),
  f('equip_terminal_provider', 'Terminal Provider', 'text', 'equipment', { width: 170 }),
  f('equip_terminal_tpn_amount', 'Terminal TPN Amount', 'text', 'equipment', { width: 180 }),
  f('equip_terminal_tpn_type', 'Terminal TPN Type', 'text', 'equipment', { width: 170 }),
  f('equip_pos_provider', 'POS Provider', 'text', 'equipment', { width: 150 }),
];

/* -------------------------------------------------------------------------- */
/* Lookups                                                                     */
/* -------------------------------------------------------------------------- */

export const FIELD_BY_ID = new Map(FIELDS.map((f) => [f.id, f]));

/** Everything except the primary field, which the chassis renders itself. */
export const EDITABLE_FIELDS = FIELDS.filter((f) => f.id !== 'deal_name');

/** Fields in one tab or subtab. Global — no module argument, by design. */
export function fieldsInTab(tabId: string, subtabId?: string): Field[] {
  const target = subtabId ? `${tabId}/${subtabId}` : tabId;
  return EDITABLE_FIELDS.filter((f) => f.tab === target);
}

/** Whether a tab holds any fields at all, across every subtab. */
export function tabHasFields(tabId: string): boolean {
  const prefix = `${tabId}/`;
  return EDITABLE_FIELDS.some((f) => f.tab === tabId || f.tab.startsWith(prefix));
}

/** How many fields sit under a tab, counting all its subtabs. */
export function fieldCountForTab(tabId: string): number {
  const prefix = `${tabId}/`;
  return EDITABLE_FIELDS.filter((f) => f.tab === tabId || f.tab.startsWith(prefix)).length;
}

/** The admin-configured column set for a module, in configured order. */
export function columnsFor(moduleSlug: string): Field[] {
  return FIELDS.filter((f) => f.columnIn.includes(moduleSlug as never)).sort(
    (a, b) => (a.columnOrder ?? 999) - (b.columnOrder ?? 999),
  );
}

/** Header-strip fields for a module — property (e), varies per module. */
export function headerFieldsFor(moduleSlug: string): Field[] {
  return FIELDS.filter((f) => f.headerIn?.includes(moduleSlug as never));
}

/** Choices for a field in a module — property (f), varies per module. */
export function choicesFor(field: Field, moduleSlug: string): Choice[] {
  return field.choicesByModule?.[moduleSlug as ModuleSlug] ?? field.choices ?? [];
}

/**
 * What a record actually STORES for a choice — never the display label.
 *
 * Every read and write of a choice-backed value goes through this, so a
 * rename in the choices editor changes what is shown and nothing else. The
 * fallback to `value` is what lets the prototype's own label-only fixtures
 * (`c('IC+', 'DP', 'FR')` above) keep working unchanged: there, the label IS
 * the identity, and always was. In the real app `key` is always present —
 * `adapter.ts` fills it from `field_choices.key`.
 */
export function choiceKey(c: Choice): string {
  return c.key ?? c.value;
}

/** The stored value → its current display label, or the raw value if it
 * resolves to nothing (a record holding a key whose choice was never created,
 * or was created in a different module's scope). Showing the raw value is the
 * honest fallback: it is what is really stored, and an admin who sees a key
 * where a label belongs can go and add the missing option. */
export function choiceLabel(options: Choice[], value: unknown): string {
  const raw = String(value);
  return options.find((c) => choiceKey(c) === raw)?.value ?? raw;
}
