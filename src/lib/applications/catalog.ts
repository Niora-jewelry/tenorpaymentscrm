/**
 * The merchant application, as data: every question the PDF asks, in its
 * order and sections, under the PDF's own field names (spec, Appendix).
 *
 * The online form renders THIS list and the PDF is filled and read by the
 * SAME names, which is what makes "the online form asks exactly what the PDF
 * asks … so both paths produce the same data" true by construction rather
 * than by two lists kept in step.
 *
 * Naming, as in the revised PDF:
 *   text / radio       one field, named by `id`
 *   checkboxes         `<id>__<option>`, one per option
 *   percent group      `<id>_<option>`, one text field (%) per option
 *   owners 1–4         `owner<n>_<name|title|percentage|email|phone|ssn>`
 *   details boxes      their own text field (`bankruptcy_details`, …)
 *
 * Where each answer lands in the CRM is `mapping.ts`. Nothing here names a
 * CRM field.
 */

export type SectionId = 'business' | 'ownership' | 'processing' | 'ach';

export const SECTIONS: { id: SectionId; title: string; blurb: string }[] = [
  { id: 'business', title: 'Business information', blurb: '' },
  {
    id: 'ownership',
    title: 'Business Owner/Officer Information',
    blurb: 'List all principals with 25% or greater ownership. Total ownership listed must equal at least 51%.',
  },
  { id: 'processing', title: 'Credit Card Processing', blurb: '' },
  { id: 'ach', title: 'ACH Processing', blurb: 'You may disregard if you do not accept ACH.' },
];

export type Option = { value: string; label: string };

export type QuestionKind =
  | 'text'
  | 'long_text'
  | 'email'
  | 'phone'
  | 'url'
  | 'date'
  | 'money'
  | 'count'
  | 'address'
  /** Radio buttons. `options` holds the PDF export values (Yes/No, Own/Lease/Rent). */
  | 'radio'
  /** Checkbox group: several may be ticked. */
  | 'checkboxes'
  /** Checkbox group the merchant should answer with ONE tick (ranges). Rendered as radios online. */
  | 'single_checkbox'
  /** One % box per option; the boxes must add up to 100. */
  | 'percent_group';

export type Question = {
  id: string;
  section: SectionId;
  label: string;
  kind: QuestionKind;
  options?: Option[];
  /** The "If yes, provide details" box: required online when the answer is Yes. */
  details?: { id: string; label: string; requiredWhen?: string };
  /** A free-text box that sits with the question but is never required. */
  comments?: { id: string; label: string };
  /** Half-width on the online form's grid. */
  half?: boolean;
  placeholder?: string;
};

const YES_NO: Option[] = [
  { value: 'Yes', label: 'Yes' },
  { value: 'No', label: 'No' },
];

/**
 * Wording, order and sections exactly as on TapDash_Application_v2.pdf
 * (checked against the rendered pages, 29 Oct 2026). The client's decisions
 * of 28 Oct are applied: Area zoned is one tick; the delivery-time question
 * offers the CRM's choices (a dropdown on the PDF); the Seasonal "If yes"
 * box asks which months.
 */
export const QUESTIONS: Question[] = [
  // ── 1 Business information ────────────────────────────────────────────────
  { id: 'legal_business_name', section: 'business', label: 'Legal/Corporate Name', kind: 'text', half: true },
  { id: 'merchant_address', section: 'business', label: 'Address', kind: 'address' },
  {
    id: 'building_ownership',
    section: 'business',
    label: 'Do you own, lease or rent the property?',
    kind: 'radio',
    options: [
      { value: 'Own', label: 'Own' },
      { value: 'Lease', label: 'Lease' },
      { value: 'Rent', label: 'Rent' },
    ],
  },
  { id: 'dba', section: 'business', label: 'DBA (If different than legal)', kind: 'text', half: true },
  { id: 'retail_address', section: 'business', label: 'Retail Address', kind: 'address' },
  {
    id: 'area_zoned',
    section: 'business',
    label: 'How is the property zoned?',
    kind: 'single_checkbox',
    options: [
      { value: 'commercial', label: 'Commercial' },
      { value: 'industrial', label: 'Industrial' },
      { value: 'residential', label: 'Residential' },
    ],
  },
  {
    id: 'square_footage',
    section: 'business',
    label: 'Estimated square footage',
    kind: 'single_checkbox',
    options: [
      { value: '1_1000', label: '1-1,000' },
      { value: '1000_5000', label: '1,000-5,000' },
      { value: '5000_10000', label: '5,000-10,000' },
      { value: 'above_10000', label: 'Above 10,000' },
    ],
  },
  { id: 'contact_email', section: 'business', label: 'Business Email Address', kind: 'email', half: true },
  { id: 'contact_phone', section: 'business', label: 'Business Phone Number', kind: 'phone', half: true },
  { id: 'business_founded_date', section: 'business', label: 'Business Founded Date', kind: 'date', half: true },
  {
    id: 'entity_type',
    section: 'business',
    label: 'Type of entity (select one)',
    kind: 'single_checkbox',
    options: [
      { value: 'sole_proprietor', label: 'Sole Proprietor' },
      { value: 'partnership', label: 'Partnership' },
      { value: 'corporation', label: 'Corporation' },
      { value: 'llc', label: 'LLC' },
      { value: 'non_profit', label: 'Non Profit' },
      { value: 'other', label: 'Other' },
    ],
  },
  {
    id: 'bankruptcy',
    section: 'business',
    label: 'Has the business or any of its principals ever filed bankruptcy?',
    kind: 'radio',
    options: YES_NO,
    details: { id: 'bankruptcy_details', label: 'If yes, provide more details', requiredWhen: 'Yes' },
  },
  {
    id: 'cc_termination',
    section: 'business',
    label: 'Has the business or any of its principals ever been terminated from accepting bank cards?',
    kind: 'radio',
    options: YES_NO,
    details: { id: 'cc_termination_details', label: 'If yes, provide more details', requiredWhen: 'Yes' },
  },
  { id: 'merchant_website', section: 'business', label: 'Website Address', kind: 'url', placeholder: 'https://' },

  // ── 3 Credit Card Processing ──────────────────────────────────────────────
  { id: 'prior_processor', section: 'processing', label: 'Current processing company', kind: 'text', half: true },
  { id: 'prior_pos', section: 'processing', label: 'Current terminal type or POS system', kind: 'text', half: true },
  { id: 'monthly_acq_volume', section: 'processing', label: 'Average monthly credit card volume', kind: 'money', half: true },
  { id: 'average_transaction_amount', section: 'processing', label: 'Average ticket', kind: 'money', half: true },
  { id: 'maximum_transaction_amount', section: 'processing', label: 'High ticket', kind: 'money', half: true },
  {
    id: 'seasonal',
    section: 'processing',
    label: 'Is the business seasonal?',
    kind: 'radio',
    options: YES_NO,
    // The client: "The application should have a notes field asking which
    // months — if yes." On the PDF this is the "If yes, provide more
    // details" box beside the question.
    details: { id: 'seasonal_details', label: 'If yes, which months?', requiredWhen: 'Yes' },
  },
  {
    id: 'sales_method',
    section: 'processing',
    label: 'Estimate the breakdown of credit card payment type (must equal 100%)',
    kind: 'percent_group',
    options: [
      { value: 'internet', label: 'Internet/eCommerce' },
      { value: 'in_person', label: 'In Person' },
      { value: 'mail_phone', label: 'Mail/Phone' },
    ],
  },
  {
    id: 'customer_type',
    section: 'processing',
    label: 'Provide an estimated breakdown of your customer base (must equal 100%)',
    kind: 'percent_group',
    options: [
      { value: 'b2c', label: 'Consumers (B2C)' },
      { value: 'b2b', label: 'Business (B2B)' },
      { value: 'government', label: 'Government' },
    ],
  },
  {
    id: 'customer_profile',
    section: 'processing',
    label: "Estimate your customers' geographic distribution (must equal 100%)",
    kind: 'percent_group',
    options: [
      { value: 'local', label: 'Local' },
      { value: 'national', label: 'National' },
      { value: 'international', label: 'International' },
    ],
  },
  { id: 'advertising_method', section: 'processing', label: 'List your primary advertising methods (enter N/A if none)', kind: 'text' },
  { id: 'return_policy', section: 'processing', label: 'What is your return policy (enter N/A if none)?', kind: 'long_text' },
  {
    id: 'inventory',
    section: 'processing',
    label: 'Where is your inventory stored (select all applicable)?',
    kind: 'checkboxes',
    options: [
      { value: 'none', label: 'We don’t have any' },
      { value: 'on_site', label: 'On-site' },
      { value: 'off_site_warehouse', label: 'Off-site (Warehouse)' },
      { value: 'fulfillment_center', label: 'Fulfillment Center' },
      { value: 'third_party_storage', label: 'Third Party Storage' },
      { value: 'other', label: 'Other' },
    ],
  },
  {
    id: 'accepts_payment_before_delivery',
    section: 'processing',
    label: 'Do you accept transactions before the customer receives product or services?',
    kind: 'radio',
    options: YES_NO,
  },
  {
    id: 'product_received_time',
    section: 'processing',
    label: 'How long does it take for the customer to receive the product or service?',
    kind: 'radio',
    // The CRM's own choices (the client: "set choices on pdf also/online
    // app"). Values are the PDF dropdown's option texts.
    options: [
      { value: '24 hours', label: '24 hours' },
      { value: '2-5 days', label: '2-5 days' },
      { value: '6-10 days', label: '6-10 days' },
      { value: '11+ days', label: '11+ days' },
    ],
    comments: { id: 'product_received_comments', label: 'Additional comments' },
  },
  {
    id: 'service_model',
    section: 'processing',
    label: 'Which of the following accurately describes the service model (select all that apply)?',
    kind: 'checkboxes',
    options: [
      { value: 'one_time', label: 'One time service' },
      { value: 'recurring', label: 'Recurring Services' },
      { value: 'extended', label: 'Extended Services' },
      { value: 'subscriptions', label: 'Subscriptions' },
      { value: 'memberships', label: 'Memberships' },
    ],
  },

  // ── 4 ACH Processing ──────────────────────────────────────────────────────
  { id: 'ach_monthly_transactions', section: 'ach', label: '# of Monthly ACH Transactions', kind: 'count', half: true },
  { id: 'monthly_ach_volume', section: 'ach', label: 'Average Monthly ACH Sales Volume', kind: 'money', half: true },
  { id: 'average_ach_transaction_amount', section: 'ach', label: 'Average ACH Transaction Amount', kind: 'money', half: true },
  { id: 'maximum_ach_transaction_amount', section: 'ach', label: 'Maximum ACH Transaction Amount', kind: 'money', half: true },
  { id: 'ach_monthly_returns', section: 'ach', label: '# of Monthly ACH Returns', kind: 'count', half: true },
  { id: 'ach_refunds', section: 'ach', label: 'Do you issue refunds via ACH?', kind: 'radio', options: YES_NO },
  {
    id: 'payment_codes',
    section: 'ach',
    label: 'Please provide the approximate percentage of your ACH transactions by type (must total 100%)',
    kind: 'percent_group',
    options: [
      { value: 'ccd', label: 'Written Authorization - Corporate Account (CCD)' },
      { value: 'ppd', label: 'Written Authorization - Personal Account (PPD)' },
      { value: 'tel', label: 'Telephone Authorization (TEL)' },
      { value: 'web', label: 'Internet / Website-Initiated (WEB)' },
    ],
  },
];

/** Owners: Owner 1 plus up to three more, as on the PDF. */
export const MAX_OWNERS = 4;
export const OWNER_PARTS = ['name', 'title', 'percentage', 'email', 'phone', 'ssn'] as const;
export type OwnerPart = (typeof OWNER_PARTS)[number];
export const OWNER_LABELS: Record<OwnerPart, string> = {
  name: 'Corporate Officer/Owner Name',
  title: 'Title',
  percentage: 'Ownership %',
  email: 'Email Address',
  phone: 'Phone Number',
  ssn: 'Social Security Number',
};
/** Online, the name is two inputs (spec: "First name and last name are
 * separate inputs, matching the CRM's Ownership fields"); the PDF has one box. */
export const ONLINE_OWNER_PARTS = ['first', 'last'] as const;
export type OnlineOwnerPart = (typeof ONLINE_OWNER_PARTS)[number];
export const ownerField = (n: number, part: OwnerPart | OnlineOwnerPart) => `owner${n}_${part}`;

/** The hidden field that ties a returned PDF to its application. */
export const APP_ID_FIELD = 'tapdash_app_id';

export const questionById = new Map(QUESTIONS.map((q) => [q.id, q]));

/**
 * Every answer the application can hold, flat, keyed exactly like the PDF —
 * except that a checkbox group is ONE key holding the ticked option values,
 * and an address answered online is an object.
 */
export type AddressAnswer = { street: string; street2: string; city: string; state: string; zip: string };
export type AnswerValue = string | string[] | AddressAnswer;
export type Answers = Record<string, AnswerValue>;

/** Every flat key that belongs to the application, for whitelisting input. */
export function answerKeys(): Set<string> {
  const keys = new Set<string>();
  for (const q of QUESTIONS) {
    if (q.kind === 'percent_group') for (const o of q.options ?? []) keys.add(`${q.id}_${o.value}`);
    else keys.add(q.id);
    if (q.details) keys.add(q.details.id);
    if (q.comments) keys.add(q.comments.id);
  }
  for (let n = 1; n <= MAX_OWNERS; n++) for (const p of [...OWNER_PARTS, ...ONLINE_OWNER_PARTS]) keys.add(ownerField(n, p));
  return keys;
}
