/**
 * The Maverick ACH Processing Application (v1.7), filled from the CRM —
 * the client's "Tapdash ACH agreement" sheet, with the rulings of
 * 30 Oct 2026:
 *
 *   · Customer Service Number and Contact Number are the one Business phone;
 *     Customer Service Email and Contact Email the one Business email.
 *   · Monthly maintenance fee: the CRM's ACH monthly gateway fee, 0 if blank.
 *   · Notification of Change: always 5.00.
 *   · Rate (debit transactions only): ACH BIN, now a percentage.
 *   · Bankruptcy prints the kind; a plain "Yes" blocks the send.
 *   · Building ownership "Leases" ticks Rents; Entity type "Other" blocks.
 *
 * The form's checkboxes are unnamed (CheckBox1 … CheckBox52); each is placed
 * here by its position on the page, matched against the printed labels
 * (see maverick_ach.fields.json). Two signature sets per principal:
 * Merchant Acceptance and the Personal Guarantee.
 */
import type { AgreementKindDef, AgreementProblem, AgreementSource, MappingEntry, PrincipalSlot } from './types';
import { addressParts, ein, money, percent, phone, ssn, str, usDate, yearsSince, yesNo } from '../format';
import { addressBlock, bankruptcy, hasDba, noteWhenYes, ownerText, part, splitTotal, text, textOr, tick, used, v } from './fill';

const yes = (src: AgreementSource, key: string) => yesNo(v(src, key)) === 'Yes';
const priorAch = (src: AgreementSource) => str(v(src, 'prior_ach_provider'));
const processesAch = (src: AgreementSource) => priorAch(src) !== '' && priorAch(src).toLowerCase() !== 'no';

const mapping: MappingEntry[] = [
  // ── Business information ────────────────────────────────────────────────
  text('Corporate/Legal Name', 'legal_business_name'),
  text('Federal Tax ID Number', 'ein', ein),
  ...addressBlock('Corp/Legal Location Address', 'Corp/Legal City', 'Corp/Legal State', 'Corp/Legal Zip', 'merchant_address'),
  { pdf: 'CheckBox1', fill: (src) => ({ check: !hasDba(src), used: used('dba') }) }, // Information same as above
  text('Merchant Name', 'dba'),
  ...addressBlock('Merchant Location Address', 'Merchant City', 'Merchant State', 'Merchant Zip', 'merchant_address', hasDba),
  // ── Contact information ─────────────────────────────────────────────────
  text('Customer Service Number', 'business_phone', phone),
  text('Contact Number', 'business_phone', phone),
  text('Customer Service Email', 'business_email'),
  text('Contact Email', 'business_email'),
  text('Website Address', 'merchant_website'),
  // ── Processing information ──────────────────────────────────────────────
  text('# of Monthly ACH Transactions', 'ach_monthly_transactions', (x) => (str(x) ? String(Math.round(Number(str(x).replace(/[,\s]/g, '')) || 0)) : '')),
  text('Average Monthly ACH Sales Volume', 'monthly_ach_volume', money),
  text('Average ACH Transaction Amount', 'ach_avg_transaction', money),
  text('Maximum Transaction Amount', 'ach_max_transaction', money),
  text('# of Monthly ACH Returns', 'ach_monthly_returns', (x) => (str(x) ? String(Math.round(Number(str(x).replace(/[,\s]/g, '')) || 0)) : '')),
  tick('CheckBox2', 'ach_credits_required', ['no']), // Will you need to issue ACH credits? No
  tick('CheckBox3', 'ach_credits_required', ['yes']), // … Yes
  noteWhenYes('If yes, provide details:', 'ach_credits_required'),
  text('Describe your product/service:', 'describe_product_service'),
  text('MCC/SIC Code', 'mcc_code'),
  // ── Standard Entry Class codes (must equal 100%) ────────────────────────
  part('PPD Percentage', 'payment_codes', 'ppd'),
  part('CCD Percentage', 'payment_codes', 'ccd'),
  part('Web Percentage', 'payment_codes', 'web'),
  part('Tel Percentage', 'payment_codes', 'tel'),
  // ── Entity type ─────────────────────────────────────────────────────────
  tick('CheckBox4', 'entity_type', ['sole_prop']),
  tick('CheckBox5', 'entity_type', ['partnership']),
  tick('CheckBox6', 'entity_type', ['corp']),
  tick('CheckBox7', 'entity_type', ['gov']),
  tick('CheckBox8', 'entity_type', ['llc']),
  tick('CheckBox9', 'entity_type', ['np']),
  tick('CheckBox24', 'entity_type', ['public']),
  { pdf: 'Years in business', fill: (src) => ({ text: yearsSince(v(src, 'business_founded_date'), src.sentAt), used: used('business_founded_date') }) },
  // ── Location ────────────────────────────────────────────────────────────
  tick('CheckBox10', 'building_type', ['shopping_center']),
  tick('CheckBox11', 'building_type', ['office_building']),
  tick('CheckBox12', 'building_type', ['industrial']),
  tick('CheckBox13', 'building_type', ['residence']),
  tick('CheckBox14', 'building_ownership', ['owns']),
  tick('CheckBox15', 'building_ownership', ['rents', 'leases']), // Lease = Rent (the client, 30 Oct 2026)
  tick('CheckBox16', 'area_zoned', ['commercial']),
  tick('CheckBox17', 'area_zoned', ['industrial']),
  tick('CheckBox18', 'area_zoned', ['residential']),
  tick('CheckBox19', 'square_footage', ['0_500']),
  tick('CheckBox20', 'square_footage', ['501_2500']),
  tick('CheckBox21', 'square_footage', ['2501_5000']),
  tick('CheckBox22', 'square_footage', ['5001_10000']),
  tick('CheckBox23', 'square_footage', ['10000']),
  // ── General information ─────────────────────────────────────────────────
  { pdf: 'CheckBox27', fill: (src) => ({ check: bankruptcy(src) === 'business', used: used('bankruptcy') }) },
  { pdf: 'CheckBox28', fill: (src) => ({ check: bankruptcy(src) === 'personal', used: used('bankruptcy') }) },
  { pdf: 'CheckBox29', fill: (src) => ({ check: bankruptcy(src) === 'never', used: used('bankruptcy') }) },
  { pdf: 'If yes, please explain:', fill: (src) => ({ text: ['business', 'personal'].includes(bankruptcy(src)) ? src.notes.bankruptcy ?? '' : '', used: [{ fieldKey: 'bankruptcy', kind: 'note' }] }) },
  { pdf: 'CheckBox30', fill: (src) => ({ check: priorAch(src) !== '' && !processesAch(src), used: used('prior_ach_provider') }) }, // currently process ACH? No
  { pdf: 'CheckBox31', fill: (src) => ({ check: processesAch(src), used: used('prior_ach_provider') }) }, // … Yes
  { pdf: 'If yes, current processor', fill: (src) => ({ text: processesAch(src) ? priorAch(src) : '', used: used('prior_ach_provider') }) },
  tick('CheckBox32', 'ach_termination', ['no']), // ever terminated from ACH? No
  tick('CheckBox33', 'ach_termination', ['yes']), // … Yes
  noteWhenYes('If yes, please explain termination reason', 'ach_termination'),
  part('Individual Consumer Percentage', 'customer_type', 'individual'),
  part('Business Percentage', 'customer_type', 'business'),
  part('Government Percentage', 'customer_type', 'gov'),
  tick('CheckBox34', 'charge_to_service', ['24_hours']),
  tick('CheckBox35', 'charge_to_service', ['2_days']),
  tick('CheckBox36', 'charge_to_service', ['3_10_days']),
  tick('CheckBox37', 'charge_to_service', ['11_30_days']),
  tick('CheckBox38', 'charge_to_service', ['31_90_days']),
  tick('CheckBox39', 'charge_to_service', ['90_days']),
  tick('CheckBox40', 'when_charged', ['time_of_order']),
  tick('CheckBox41', 'when_charged', ['upon_shipment']),
  text('Refund/Return Policy', 'refund_policy'),
  tick('CheckBox42', 'recurring_subscription', ['no']), // recurring fees for ongoing services? No
  tick('CheckBox43', 'recurring_subscription', ['yes']), // … Yes
  noteWhenYes('If yes, please provide details', 'recurring_subscription'),
  // ── Bank account 1: debits and billing always; credits when ACH credits = Yes
  text('Routing Number', 'routing_number'),
  text('Account Number', 'account_number'),
  { pdf: 'CheckBox45', fill: (src) => ({ check: yes(src, 'ach_credits_required'), used: used('ach_credits_required') }) },
  // ── Fee schedule (Schedule A) ───────────────────────────────────────────
  textOr('Per Transaction Fee', 'td_ach_transaction_fee', money, '0.00'),
  textOr('Rate (debit transactions only)', 'td_ach_bin', percent, '0'),
  textOr('Monthly Maintenance Fee', 'td_ach_monthly_gateway_fee', money, '0.00'),
  textOr('Return Item Processing', 'td_ach_return', money, '0.00'),
  textOr('FED Unauthorized Return Fee', 'td_ach_debit_unauthorized_fee', money, '0.00'),
  textOr('Exception/Corrections Processing', 'td_ach_exception_fee', money, '0.00'),
  // ── Merchant acceptance ─────────────────────────────────────────────────
  text('Merchant (Legal Name of Business)', 'legal_business_name'),
];

/** Fixed values (the sheet's "Always …" rows). */
const fixed: Record<string, string | boolean> = {
  CheckBox26: true, // controlling person already listed in the Principal section: Yes
  CheckBox44: true, // bank account 1: Debits (receive funds)
  CheckBox46: true, // bank account 1: Billing (fees)
  'Inital Setup Fee': '0.00',
  'Notification of Change': '5.00',
};

/** Principal slot n: the owner's own boxes, and the two places they sign. */
const slot = (n: 1 | 2 | 3 | 4): PrincipalSlot => ({
  slot: n,
  fields: [
    { pdf: `First Name Principal ${n}`, fill: (o) => ownerText(o, 'first') },
    { pdf: `Last Name Principal ${n}`, fill: (o) => ownerText(o, 'last') },
    { pdf: `SSN Principal ${n}`, fill: (_o, p) => ssn(p.ssn) },
    { pdf: `% Ownership Principal ${n}`, fill: (o) => percent(o.percentage) },
    { pdf: `Title Principal ${n}`, fill: (o) => ownerText(o, 'title') },
    { pdf: `Home Address Principal ${n}`, fill: (o) => [addressParts(o.address).street, addressParts(o.address).street2].filter(Boolean).join(', ') },
    { pdf: `City Principal ${n}`, fill: (o) => addressParts(o.address).city },
    { pdf: `State Principal ${n}`, fill: (o) => addressParts(o.address).state },
    { pdf: `Zip Principal ${n}`, fill: (o) => addressParts(o.address).zip },
    { pdf: `Home Phone Principal ${n}`, fill: (o) => phone(o.phone) },
    { pdf: `Email Principal ${n}`, fill: (o) => ownerText(o, 'email') },
    { pdf: `Drivers License/Exp Date Principal ${n}`, fill: (_o, p) => [str(p.dl_number), usDate(p.dl_expiry)].filter(Boolean).join(' exp. ') },
    { pdf: `DOB Principal ${n}`, fill: (o) => usDate(o.dob) },
  ],
  signatures: [
    { signature: `Principal ${n} (Signature)`, date: `prin${n}date` },
    // The form's own naming: guarantor 3's date box is just "Date".
    { signature: `Principal/Guarantor ${n}`, date: n === 3 ? 'Date' : `guarprin${n}date` },
  ],
});

/** The sheet's "Y" rows, by CRM field key, with the label the pop-up shows. */
const required: AgreementKindDef['required'] = [
  ['legal_business_name', 'Legal business name'], ['ein', 'EIN'], ['merchant_address', 'Merchant address'],
  ['business_phone', 'Business phone'], ['business_email', 'Business email'],
  ['ach_monthly_transactions', 'Monthly ACH transactions'], ['monthly_ach_volume', 'Monthly ACH volume'],
  ['ach_avg_transaction', 'Average ACH transaction amount'], ['ach_max_transaction', 'Maximum ACH transaction amount'],
  ['ach_monthly_returns', 'ACH monthly returns'], ['ach_credits_required', 'ACH credits required'],
  ['describe_product_service', 'Describe product/service'], ['mcc_code', 'MCC code'], ['payment_codes', 'Payment codes'],
  ['entity_type', 'Entity type'], ['business_founded_date', 'Business founded date'],
  ['building_type', 'Building type'], ['building_ownership', 'Building ownership'], ['area_zoned', 'Area zoned'], ['square_footage', 'Square footage'],
  ['bankruptcy', 'Bankruptcy'], ['prior_ach_provider', 'Prior ACH provider (type "No" if none)'], ['ach_termination', 'ACH termination'],
  ['customer_type', 'Customer type'], ['charge_to_service', 'How long after charge is service/product received'], ['when_charged', 'When is customer charged'],
  ['refund_policy', 'Return policy'], ['recurring_subscription', 'Recurring or subscription'],
  ['routing_number', 'Routing number'], ['account_number', 'Account number'],
].map(([fieldKey, label]) => ({ fieldKey: fieldKey!, label: label! }));

function check(src: AgreementSource): AgreementProblem[] {
  const out: AgreementProblem[] = [];
  if (bankruptcy(src) === 'yes') out.push({ fieldKey: 'bankruptcy', message: 'Bankruptcy says "Yes". Pick Business bankruptcy, Personal bankruptcy or Never filed — the agreement has a box for each.' });
  if (['business', 'personal'].includes(bankruptcy(src)) && !(src.notes.bankruptcy ?? '').trim()) out.push({ fieldKey: 'bankruptcy', message: 'Bankruptcy is Yes: add the details as a note on the field.' });
  if (str(v(src, 'entity_type')).toLowerCase() === 'other') out.push({ fieldKey: 'entity_type', message: 'Entity type "Other" has no box on the agreement. Pick the matching entity type.' });
  for (const [key, label] of [['payment_codes', 'Payment codes (PPD, CCD, Web, Tel)'], ['customer_type', 'Customer type']] as const) {
    const total = splitTotal(v(src, key));
    if (!Number.isNaN(total) && Math.abs(total - 100) > 0.01) out.push({ fieldKey: key, message: `${label} percentages add up to ${Math.round(total * 100) / 100}%; they must total exactly 100%.` });
  }
  return out;
}

export const maverickAch: AgreementKindDef = {
  key: 'maverick_ach',
  label: 'Maverick ACH agreement',
  fileLabel: 'ACH Agreement',
  emailLabel: 'ACH agreement',
  templateFile: 'Maverick_ACH_Agreement_v1.7.pdf',
  fieldsFile: 'maverick_ach.fields.json',
  version: '1.7',
  fixed,
  mapping,
  principals: [slot(1), slot(2), slot(3), slot(4)],
  check,
  required,
};
