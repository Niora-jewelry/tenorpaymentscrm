/**
 * The Maverick Merchant Account Application and Agreement (v1.8), filled
 * from the CRM — every rule from the client's build spec §5–§6 and the
 * "Fields" sheet (TapDash CC Agreement Reconcile.xlsx), with the 30 Oct 2026
 * rulings:
 *
 *   · Bankruptcy prints the kind (Business / Personal / Never filed); a plain
 *     "Yes" in the CRM blocks the send until someone picks the kind.
 *   · Building ownership "Leases" ticks Rents.
 *   · Entity type or Inventory "Other" (and Third Party Storage, which has no
 *     box) block the send until a matching choice is picked.
 *   · Inventory off-site: the warehouse address is the field's own address.
 *   · Seasonal ticks the months themselves.
 *
 * PDF field names are the form's own (see maverick_merchant.fields.json);
 * `mapping.test.ts` proves each one exists. The principal slots print from
 * `owner_ownership[i]` / `owner_private[i]` for the signers the rule picks.
 */
import type { AgreementKindDef, AgreementProblem, AgreementSource, CrmValues, MappingEntry, PrincipalSlot } from './types';
import { addressParts, ein, equipmentList, money, percent, phone, ssn, str, usDate, yearsSince, yesNo } from '../format';
import { addressBlock, bankruptcy, hasDba, part, splitTotal, text, tick, used, v } from './fill';

const priorProcessor = (src: AgreementSource) => str(v(src, 'prior_processor'));
const processesCards = (src: AgreementSource) => priorProcessor(src) !== '' && priorProcessor(src).toLowerCase() !== 'no';
const months = (src: AgreementSource) => (Array.isArray(v(src, 'seasonal')) ? (v(src, 'seasonal') as unknown[]).map((m) => str(m)) : []);
const seasonal = (src: AgreementSource) => months(src).some((m) => m !== 'No');
const pricing = (src: AgreementSource) => str(v(src, 'pricing_model')).toLowerCase();
const isIcPlus = (src: AgreementSource) => pricing(src) === 'ic';
const inventory = (src: AgreementSource) => (Array.isArray(v(src, 'inventory')) ? (v(src, 'inventory') as unknown[]).map((x) => str(x)) : [str(v(src, 'inventory'))].filter(Boolean));

const MONTH_BOX: Record<string, string> = {
  Jan: 'JANUARY', Feb: 'FEBRUARY', Mar: 'MARCH', Apr: 'APRIL', May: 'MAY', Jun: 'JUNE',
  Jul: 'JULY', Aug: 'AUGUST', Sep: 'SEPTEMBER', Oct: 'OCTOBER', Nov: 'NOVEMBER', Dec: 'DECEMBER',
};

const mapping: MappingEntry[] = [
  // ── Business information ────────────────────────────────────────────────
  text('CORPORATE  LEGAL NAME', 'legal_business_name'),
  text('FEDERAL TAX ID NUMBER', 'ein', ein),
  ...addressBlock('LOCATION ADDRESS', 'CITY', 'STATE', 'ZIP', 'merchant_address'),
  text('MERCHANT NAME DBA OR TRADE NAME', 'dba'),
  { pdf: 'Information same as above corporate  legal', fill: (src) => ({ check: !hasDba(src), used: used('dba') }) },
  ...addressBlock('LOCATION ADDRESS_2', 'CITY_2', 'STATE_2', 'ZIP_2', 'merchant_address', hasDba),
  // ── Contact information ─────────────────────────────────────────────────
  text('CUSTOMER SERVICE NUMBER', 'business_phone', phone),
  text('BUSINESS EMAIL', 'business_email'),
  text('WEBSITE ADDRESS', 'merchant_website'),
  // ── Processing information ──────────────────────────────────────────────
  text('AVERAGE TRANSACTION AMOUNT', 'avg_transaction', money),
  text('MAXIMUM TRANSACTION AMOUNT', 'max_transaction', money),
  text('MONTHLY VOLUME', 'monthly_acq_volume', money),
  text('AMEX MONTHLY VOLUME', 'amex_monthly_volume', money),
  text('DESCRIBE YOUR PRODUCTSERVICE', 'describe_product_service'),
  text('MCCSIC CODE', 'mcc_code'),
  // ── Entity type ─────────────────────────────────────────────────────────
  tick('INDIVIDUAL  SOLE PROPRIETOR', 'entity_type', ['sole_prop']),
  tick('PARTNERSHIP', 'entity_type', ['partnership']),
  tick('CORPORATION', 'entity_type', ['corp']),
  tick('GOVERNMENT', 'entity_type', ['gov']),
  tick('LLC', 'entity_type', ['llc']),
  tick('NONPROFIT MUST PROVIDE 501C3 LETTER', 'entity_type', ['np']),
  tick('PUBLICLY TRADED PAPC', 'entity_type', ['public']),
  { pdf: 'YEARS IN BUSINESS', fill: (src) => ({ text: yearsSince(v(src, 'business_founded_date'), src.sentAt), used: used('business_founded_date') }) },
  // ── Location ────────────────────────────────────────────────────────────
  tick('SHOPPING CENTER', 'building_type', ['shopping_center']),
  tick('OFFICE BUILDING', 'building_type', ['office_building']),
  tick('INDUSTRIAL BUILDING', 'building_type', ['industrial']),
  tick('RESIDENCE', 'building_type', ['residence']),
  tick('OWNS', 'building_ownership', ['owns']),
  tick('RENTS', 'building_ownership', ['rents', 'leases']), // Lease = Rent (the client, 30 Oct 2026)
  tick('COMMERCIAL', 'area_zoned', ['commercial']),
  tick('INDUSTRIAL', 'area_zoned', ['industrial']),
  tick('RESIDENTIAL', 'area_zoned', ['residential']),
  tick('0500', 'square_footage', ['0_500']),
  tick('5012500', 'square_footage', ['501_2500']),
  tick('2501  5000', 'square_footage', ['2501_5000']),
  tick('5000  10000', 'square_footage', ['5001_10000']),
  tick('10000', 'square_footage', ['10000']),
  // ── General information ─────────────────────────────────────────────────
  { pdf: 'BUSINESS BANKRUPTCY', fill: (src) => ({ check: bankruptcy(src) === 'business', used: used('bankruptcy') }) },
  { pdf: 'PERSONAL BANKRUPTCY', fill: (src) => ({ check: bankruptcy(src) === 'personal', used: used('bankruptcy') }) },
  { pdf: 'NEVER FILED', fill: (src) => ({ check: bankruptcy(src) === 'never', used: used('bankruptcy') }) },
  { pdf: 'IF YES PLEASE EXPLAIN', fill: (src) => ({ text: ['business', 'personal'].includes(bankruptcy(src)) ? src.notes.bankruptcy ?? '' : '', used: [{ fieldKey: 'bankruptcy', kind: 'note' }] }) },
  { pdf: 'CURRENT PROCESSOR', fill: (src) => ({ text: processesCards(src) ? priorProcessor(src) : '', used: used('prior_processor') }) },
  { pdf: 'IF YES PLEASE EXPLAIN_2', fill: (src) => ({ text: yesNo(v(src, 'cc_termination')) === 'Yes' ? src.notes.cc_termination ?? '' : '', used: [{ fieldKey: 'cc_termination', kind: 'note' }] }) },
  { pdf: 'AMERICAN EXPRESS ESA', fill: (src) => ({ text: str(v(src, 'amex_esa')), used: used('amex_esa') }) },
  { pdf: 'WHICH PAYMENTS WOULD YOU LIKE TO ACCEPT CHECK ALL THAT APPLY', fill: (src) => ({ check: Boolean(str(v(src, 'amex_esa'))), used: used('amex_esa') }) }, // the Amex ESA box
  { pdf: 'undefined_2', fill: (src) => ({ check: Boolean(str(v(src, 'ebt_fns'))), used: used('ebt_fns') }) }, // the EBT box
  text('EBT  EBT FNS NUMBER', 'ebt_fns'),
  // ── Sales method ────────────────────────────────────────────────────────
  part('IN PERSON', 'sales_method', 'in_person'),
  part('MAILPHONE', 'sales_method', 'mail_phone'),
  part('ECOMMERCE', 'sales_method', 'ecommerce'),
  // ── Bank account 1 ──────────────────────────────────────────────────────
  text('ROUTING NUMBER', 'routing_number'),
  text('ACCOUNT NUMBER', 'account_number'),
  // ── Merchant questionnaire ──────────────────────────────────────────────
  text('i  PLEASE DESCRIBE YOUR REFUNDRETURN POLICY', 'refund_policy'),
  {
    pdf: 'ii  PLEASE LIST EQUIPMENT ANDOR SOFTWARE USED TO PROCESS CARDS POINTOFSALE TERMINAL PAYMENT GATEWAY ETC',
    fill: (src) => ({
      text: equipmentList(EQUIPMENT_KEYS.map((k) => v(src, k))),
      used: EQUIPMENT_KEYS.map((k) => ({ fieldKey: k, kind: 'value' as const })),
    }),
  },
  { pdf: 'ONSITE', fill: (src) => ({ check: inventory(src).includes('on_site'), used: used('inventory') }) },
  { pdf: 'OFFSITE IE WAREHOUSE IF SO PROVIDE ADDRESS', fill: (src) => ({ check: inventory(src).includes('off_site'), used: used('inventory') }) },
  { pdf: 'undefined_5', fill: (src) => ({ text: inventory(src).includes('off_site') ? addressLineOf(src.addresses.inventory) : '', used: [{ fieldKey: 'inventory', kind: 'address' }] }) },
  { pdf: '3RD PARTY FULFILLMENT CENTER IF SO PROVIDE FULLY EXECUTED FULFILLMENT AGREEMENT', fill: (src) => ({ check: inventory(src).includes('fulfillment_center'), used: used('inventory') }) },
  { pdf: 'Service Only No Products Sold', fill: (src) => ({ check: inventory(src).includes('none'), used: used('inventory') }) },
  { pdf: 'NO_4', fill: (src) => ({ check: yesNo(v(src, 'third_party_shipping')) === 'No', used: used('third_party_shipping') }) },
  { pdf: 'YES IF SO PROVIDE FULLY EXECUTED FULFILLMENT AGREEMENT', fill: (src) => ({ check: yesNo(v(src, 'third_party_shipping')) === 'Yes', used: used('third_party_shipping') }) },
  {
    pdf: 'iii  DO YOU OFFER RECURRING AND TIMEEXTENDED SERVICES SUBSCRIPTIONS MEMBERSHIPS RECURRING PLANS ETC IF YES PLEASE DESCRIBE AND INCLUDE DURATION',
    // "Choice – notes". Choice only if notes are empty.
    fill: (src) => {
      const choice = src.label('recurring_subscription', str(v(src, 'recurring_subscription')));
      const note = src.notes.recurring_subscription ?? '';
      return { text: [choice, note].filter(Boolean).join(' – '), used: [{ fieldKey: 'recurring_subscription', kind: 'value' }, { fieldKey: 'recurring_subscription', kind: 'note' }] };
    },
  },
  part('INDIVIDUAL CONSUMER', 'customer_type', 'individual'),
  part('BUSINESS', 'customer_type', 'business'),
  part('GOVERNMENT_2', 'customer_type', 'gov'),
  part('LOCAL', 'customer_profile', 'local'),
  part('NATIONAL', 'customer_profile', 'national'),
  part('INTERNATIONAL', 'customer_profile', 'international'),
  tick('24 HOURS', 'charge_to_service', ['24_hours']),
  tick('2 DAYS', 'charge_to_service', ['2_days']),
  tick('310 DAYS', 'charge_to_service', ['3_10_days']),
  tick('1130 DAYS', 'charge_to_service', ['11_30_days']),
  tick('3190 DAYS', 'charge_to_service', ['31_90_days']),
  tick('90 DAYS', 'charge_to_service', ['90_days']),
  tick('24 HOURS_2', 'order_to_service', ['24_hours']),
  tick('25 DAYS', 'order_to_service', ['2_5_days']),
  tick('610 DAYS', 'order_to_service', ['6_10_days']),
  tick('11 DAYS', 'order_to_service', ['11_days']),
  tick('TIME OF ORDER', 'when_charged', ['time_of_order']),
  tick('UP SHIPMENT', 'when_charged', ['upon_shipment']),
  { pdf: 'ix  DO YOU HAVE A RETAIL LOCATION FOR MOTOINTERNET MERCHANTS IF YES PLEASE CONFIRM PHYSICAL ADDRESS', fill: (src) => ({ text: addressLineOf(v(src, 'retail_address')), used: used('retail_address') }) },
  text('x HOW DO YOU ADVERTISE INTERNET MAGAZINES TV ETC LIST ALL THAT APPLY', 'advertising_method'),
  ...Object.entries(MONTH_BOX).map(([m, pdf]): MappingEntry => ({ pdf, fill: (src) => ({ check: months(src).includes(m), used: used('seasonal') }) })),
  // ── Fee schedule ────────────────────────────────────────────────────────
  { pdf: 'Percentage', fill: (src) => ({ text: isIcPlus(src) ? percent(v(src, 'td_vmd_volume')) : '0', used: [{ fieldKey: 'pricing_model', kind: 'value' }, { fieldKey: 'td_vmd_volume', kind: 'value' }] }) }, // Interchange plus %
  tick('Flat Rate', 'pricing_model', ['fr']),
  tick('Surcharge', 'pricing_model', ['surcharge']),
  tick('Dual Pricing', 'pricing_model', ['dp']),
  { pdf: 'Percentage_4', fill: (src) => ({ text: percent(v(src, 'td_vmd_volume')), used: used('td_vmd_volume') }) }, // Visa/MC/Discover %
  { pdf: 'Percentage_5', fill: (src) => ({ text: percent(v(src, 'td_pin_debit_volume')), used: used('td_pin_debit_volume') }) }, // Offline debit %
  { pdf: 'Passthrough Network Fees', fill: (src) => ({ check: isIcPlus(src), used: used('pricing_model') }) },
  { pdf: 'Percentage_6', fill: (src) => ({ text: percent(v(src, 'td_amex_volume')), used: used('td_amex_volume') }) }, // Amex OptBlue %
  { pdf: 'Passthrough Network Fees_2', fill: (src) => ({ check: isIcPlus(src), used: used('pricing_model') }) },
  { pdf: 'Percentage_7', fill: (src) => ({ text: percent(v(src, 'td_ebt_volume')) || '0', used: used('td_ebt_volume') }) }, // EBT %
  { pdf: 'Percentage_8', fill: (src) => ({ text: percent(v(src, 'td_pin_debit_volume')), used: used('td_pin_debit_volume') }) }, // PIN debit rate %
  { pdf: 'Authorization Fee_2', fill: (src) => ({ text: money(v(src, 'td_ebt_auth_fee')) || '0.00', used: used('td_ebt_auth_fee') }) }, // EBT auth fee
  { pdf: 'Authorization Fee_3', fill: (src) => ({ text: money(v(src, 'td_pin_debit_auth_fee')), used: used('td_pin_debit_auth_fee') }) }, // PIN debit auth fee
  // Other fees (the "fill_*" column boxes, top to bottom, left then right)
  text('fill_29', 'td_vmd_auth_fee', money), // Authorization fee
  text('fill_31', 'td_batch_fee', money), // Batch fee
  { pdf: 'fill_33', fill: (src) => ({ text: money(v(src, 'td_vmd_transaction_fee')) || '0.00', used: used('td_vmd_transaction_fee') }) }, // Transaction fee
  text('fill_35', 'td_chargeback_fee', money), // Chargeback fee
  text('fill_41', 'td_avs_fee', money), // AVS transaction fee
  { pdf: 'fill_m_fee', fill: (src) => ({ text: money(v(src, 'td_monthly_fee')) || '0.00', used: used('td_monthly_fee') }) }, // Monthly fee
  text('fill_51.0', 'td_pci_fee', money), // Monthly PCI fee
  // ── Merchant acceptance ─────────────────────────────────────────────────
  text('Merchant Legal Name of Business', 'legal_business_name'),
];

/** The seven equipment/software provider fields, in the spec's order. */
const EQUIPMENT_KEYS = [
  'vtd_gateway_provider', 'vtd_terminal_provider',
  'td_gateway_provider_mav', 'td_terminal_provider_mav',
  'ovmp_gateway_provider', 'ovmp_terminal_provider', 'ovmp_pos_provider',
];

function addressLineOf(a: unknown): string {
  const p = addressParts(a);
  const cityState = [p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [p.street, p.street2, cityState].filter(Boolean).join(', ');
}

/** Fixed values (spec §6): printed the same on every agreement. */
const fixed: Record<string, string | boolean> = {
  // Controlling person: "already listed in the Principal section?" → Yes
  undefined: 'YES',
  // Accept Visa/MC/Discover · Amex OptBlue · PIN Debit · opt out of Amex marketing
  'VISA MASTERCARD DISCOVER': true,
  'AMERICAN EXPRESS OPTBLUE': true,
  'PIN DEBIT': true,
  'By checking this box Merchantopts out of receiving future commercial marketing communications from American Express': true,
  // Bank account 1: debits and deposits
  'Debits such as fees  chargebacks': true,
  'Deposits such as payouts': true,
  // Tiered: 0 · 0 · 0
  'Percentage_2.0': '0',
  'Percentage_2.1': '0',
  Percentage_3: '0',
  // Left column, top to bottom: Monthly dashboard access (fill_36) · Voice auth/IVR 0.75
  // (fill_39) · Monthly minimum (fill_42) · Application (fill_44) · Annual (fill_49);
  // right column: Retrieval 7.50 (fill_38). Monthly PCI (fill_51.0) is mapped above.
  fill_36: '0.00',
  fill_38: '7.50',
  fill_39: '0.75',
  fill_42: '0.00',
  fill_44: '0.00',
  fill_49: '0.00',
  // Other fee 1 and 2
  Other: '0',
  'Include Fee Type  Billing Method One time monthly etc': '0',
  'Billing Method': '0',
  Other_2: '0',
  'Include Fee Type  Billing Method One time monthly etc_2': '0',
  'Billing Method_2': '0',
  // POS hardware
  Purchase: '0.00',
  // Service provider fees, rows 1 and 2: $ 0
  fill_57: '0.00', fill_58: '0.00', fill_59: '0.00', 'Per Trans Fee': '0.00', fill_61: '0.00', 'Monthly Fee': '0.00', fill_63: '0.00',
  fill_66: '0.00', fill_67: '0.00', fill_68: '0.00', 'Per Trans Fee_2': '0.00', fill_70: '0.00', 'Monthly Fee_2': '0.00', fill_72: '0.00',
  'Please list any other service providers': '0',
};

/** The three radio questions the sheet answers from the CRM. */
const radios: MappingEntry[] = [
  { pdf: 'DOES THIS BUSINESS CURRENTLY PROCESS CARDS', fill: (src) => ({ text: processesCards(src) ? 'YES_2' : 'NO_2', used: used('prior_processor') }) },
  {
    pdf: 'HAVE MERCHANT OR OWNERS  PRINCIPALS EVER BEEN TERMINATED FROM ACCEPTING BANKCARDS FOR THIS BUSINESS OR ANY OTHER BUSINESSES',
    fill: (src) => ({ text: yesNo(v(src, 'cc_termination')) === 'Yes' ? 'YES_3' : yesNo(v(src, 'cc_termination')) === 'No' ? 'NO_3' : '', used: used('cc_termination') }),
  },
  { pdf: 'xi IS YOUR BUSINESS SEASONAL', fill: (src) => ({ text: months(src).length ? (seasonal(src) ? 'YES_4' : 'NO_5') : '', used: used('seasonal') }) },
];

/** Principal slot n: the owner's own boxes, and the spots they sign. */
const owner = (o: CrmValues, k: string) => str(o[k]);
const slot = (n: 1 | 2 | 3 | 4, sfx: string, addr: [string, string, string, string]): PrincipalSlot => ({
  slot: n,
  fields: [
    { pdf: `FIRST${sfx}`, fill: (o) => owner(o, 'first') },
    { pdf: `LAST${sfx}`, fill: (o) => owner(o, 'last') },
    { pdf: `SSN${sfx}`, fill: (_o, p) => ssn(p.ssn) },
    { pdf: `OWNERSHIP${sfx}`, fill: (o) => percent(o.percentage) },
    { pdf: `TITLE${sfx}`, fill: (o) => owner(o, 'title') },
    { pdf: addr[0], fill: (o) => [addressParts(o.address).street, addressParts(o.address).street2].filter(Boolean).join(', ') },
    { pdf: addr[1], fill: (o) => addressParts(o.address).city },
    { pdf: addr[2], fill: (o) => addressParts(o.address).state },
    { pdf: addr[3], fill: (o) => addressParts(o.address).zip },
    { pdf: `EMAIL${sfx}`, fill: (o) => owner(o, 'email') },
    { pdf: `HOME PHONE${sfx}`, fill: (o) => phone(o.phone) },
    { pdf: `DRIVERS LICENSE NUMBER AND EXP DATE${sfx}`, fill: (_o, p) => [str(p.dl_number), usDate(p.dl_expiry)].filter(Boolean).join(' exp. ') },
    { pdf: `DATE OF BIRTH${sfx}`, fill: (o) => usDate(o.dob) },
  ],
  signatures: [
    { signature: n === 1 ? 'PRINCIPAL  1' : `PRINCIPAL  ${n}`, date: n === 1 ? 'DATE' : `DATE_${n}` },
    // The form's own naming: slot 1's date is lower-case, the others capitalised.
    { signature: `Pg_prin${n}`, date: n === 1 ? 'pg_prin1_date' : `Pg_prin${n}_date` },
    { signature: `bd_prin${n}`, date: `bd_prin${n}_date` },
  ],
});

const principals: PrincipalSlot[] = [
  slot(1, '', ['HOME ADDRESS', 'CITY_3', 'STATE_3', 'ZIP_3']),
  slot(2, '_2', ['HOME ADDRESS_2', 'CITY_4', 'STATE_4', 'ZIP_4']),
  slot(3, '_3', ['HOME ADDRESS_3', 'CITY_5', 'STATE_5', 'ZIP_5']),
  slot(4, '_4', ['HOME ADDRESS_4', 'CITY_6', 'STATE_6', 'ZIP_6']),
];

/** Spec §5 "Always required", by CRM field key, with the label the pop-up shows. */
const required: AgreementKindDef['required'] = [
  ['legal_business_name', 'Legal business name'], ['mcc_code', 'MCC code'], ['pricing_model', 'Pricing model'],
  ['merchant_address', 'Merchant address'], ['business_phone', 'Business phone'], ['business_email', 'Business email'],
  ['describe_product_service', 'Describe product/service'], ['entity_type', 'Entity type'], ['business_founded_date', 'Business founded date'],
  ['building_type', 'Building type'], ['building_ownership', 'Building ownership'], ['area_zoned', 'Area zoned'], ['square_footage', 'Square footage'],
  ['bankruptcy', 'Bankruptcy'], ['sales_method', 'Sales method'], ['refund_policy', 'Return policy'], ['inventory', 'Inventory'],
  ['recurring_subscription', 'Recurring or subscription'], ['customer_type', 'Customer type'], ['customer_profile', 'Customer location'],
  ['charge_to_service', 'How long after charge is service/product received'], ['order_to_service', 'How long after order is service/product received'],
  ['when_charged', 'When is customer charged'], ['advertising_method', 'Advertising method'], ['seasonal', 'Seasonal'],
  ['avg_transaction', 'Average transaction amount'], ['max_transaction', 'Maximum transaction amount'], ['monthly_acq_volume', 'Monthly ACQ volume'], ['amex_monthly_volume', 'Amex monthly volume'],
  ['ein', 'EIN'], ['routing_number', 'Routing number'], ['account_number', 'Account number'],
  ['prior_processor', 'Prior processor (type "No" if none)'], ['cc_termination', 'CC termination'],
  ['td_vmd_volume', 'VMD Volume'], ['td_pin_debit_volume', 'Pin debit volume'], ['td_amex_volume', 'Amex volume'], ['td_pin_debit_auth_fee', 'Pin Debit Auth Fee'],
  ['td_vmd_auth_fee', 'VMD Auth fee'], ['td_pci_fee', 'PCI Fee'], ['td_batch_fee', 'Batch fee'], ['td_chargeback_fee', 'Chargeback fee'], ['td_avs_fee', 'AVS Fee'],
].map(([fieldKey, label]) => ({ fieldKey: fieldKey!, label: label! }));

const sum = splitTotal;

/** Conditional and total rules (spec §5) and the 30 Oct "pick a matching choice" rules. */
function check(src: AgreementSource): AgreementProblem[] {
  const out: AgreementProblem[] = [];
  const pm = pricing(src);
  if (pm && !['ic', 'fr', 'surcharge', 'dp'].includes(pm)) out.push({ fieldKey: 'pricing_model', message: 'Pricing model must be IC+, Flat Rate, Surcharge or Dual Pricing.' });
  if (bankruptcy(src) === 'yes') out.push({ fieldKey: 'bankruptcy', message: 'Bankruptcy says "Yes". Pick Business bankruptcy, Personal bankruptcy or Never filed — the agreement has a box for each.' });
  if (['business', 'personal'].includes(bankruptcy(src)) && !(src.notes.bankruptcy ?? '').trim()) out.push({ fieldKey: 'bankruptcy', message: 'Bankruptcy is Yes: add the details as a note on the field.' });
  const et = str(v(src, 'entity_type')).toLowerCase();
  if (et === 'other') out.push({ fieldKey: 'entity_type', message: 'Entity type "Other" has no box on the agreement. Pick the matching entity type.' });
  const inv = inventory(src);
  if (inv.includes('other')) out.push({ fieldKey: 'inventory', message: 'Inventory "Other" has no box on the agreement. Pick the options that match.' });
  if (inv.includes('third_party_storage')) out.push({ fieldKey: 'inventory', message: 'Inventory "Third Party Storage" has no box on the agreement. Pick On-site, Off-site, Fulfillment Center or We don’t have any.' });
  if (inv.includes('off_site') && !addressLineOf(src.addresses.inventory)) out.push({ fieldKey: 'inventory', message: 'Inventory is off-site: add the warehouse address (the pin on the field).' });
  // Seasonal: the months themselves are ticked on the form (the client, 30 Oct
  // 2026: "Seasonal — approved"), so no note is needed.
  for (const [key, label] of [['sales_method', 'Sales method'], ['customer_type', 'Customer type'], ['customer_profile', 'Customer location']] as const) {
    const total = sum(v(src, key));
    if (!Number.isNaN(total) && Math.abs(total - 100) > 0.01) out.push({ fieldKey: key, message: `${label} percentages add up to ${Math.round(total * 100) / 100}%; they must total exactly 100%.` });
  }
  return out;
}

export const maverickMerchant: AgreementKindDef = {
  key: 'maverick_merchant',
  label: 'Maverick merchant agreement',
  fileLabel: 'Merchant Agreement',
  emailLabel: 'merchant agreement',
  templateFile: 'Maverick_Merchant_Agreement_v1.8.pdf',
  fieldsFile: 'maverick_merchant.fields.json',
  version: '1.8',
  fixed,
  mapping: [...mapping, ...radios],
  principals,
  check,
  required,
};
