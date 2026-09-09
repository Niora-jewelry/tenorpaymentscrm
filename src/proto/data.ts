/**
 * PROTOTYPE — the sample dataset.
 *
 * Every merchant, message, case, file and credential below is invented. No part
 * of this file touches Supabase, and none of it ships to production.
 *
 * Values are generated from a fixed seed rather than `Math.random`, so the same
 * row shows the same numbers on the server and in the browser. A React
 * hydration mismatch in a demo looks exactly like a bug in the product.
 */
import { FIELDS } from './fields';
import { PIPELINES } from './modules';
import type {
  ActivityEntry,
  CaseThread,
  Creator,
  CustomEntry,
  FieldValue,
  FileRow,
  LoginRow,
  Message,
  ModuleSlug,
  Note,
  Notification,
  RecordRow,
  StatementFile,
  Update,
  User,
} from './schema';

/** The prototype's "now". Fixed, so nothing drifts between renders. */
export const TODAY = new Date('2026-08-18T09:30:00Z');

/* -------------------------------------------------------------------------- */
/* Deterministic pseudo-randomness                                             */
/* -------------------------------------------------------------------------- */

function makeRng(seed: number) {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const pick = <T,>(rng: () => number, arr: readonly T[]): T =>
  arr[Math.floor(rng() * arr.length)]!;

const int = (rng: () => number, min: number, max: number): number =>
  min + Math.floor(rng() * (max - min + 1));

/** A "must total 100%" split that really does total 100. */
function split(rng: () => number, keys: readonly string[]): Record<string, number> {
  const weights = keys.map(() => 1 + Math.floor(rng() * 9));
  const total = weights.reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  let used = 0;
  keys.forEach((k, i) => {
    const v = i === keys.length - 1 ? 100 - used : Math.round((weights[i]! / total) * 100);
    out[k] = v;
    used += v;
  });
  return out;
}

const daysBefore = (n: number) =>
  new Date(TODAY.getTime() - n * 86_400_000).toISOString().slice(0, 10);

const isoBefore = (hours: number) =>
  new Date(TODAY.getTime() - hours * 3_600_000).toISOString();

const digits = (rng: () => number, n: number) =>
  Array.from({ length: n }, () => String(int(rng, 0, 9))).join('');

/* -------------------------------------------------------------------------- */
/* Team                                                                        */
/* -------------------------------------------------------------------------- */

export const USERS: User[] = [
  { id: 'u_izzy', name: 'Izzy Rahman', initials: 'IR', role: 'Super admin', hue: 212 },
  { id: 'u_sarah', name: 'Sarah Whitfield', initials: 'SW', role: 'Sales rep', hue: 268 },
  { id: 'u_marcus', name: 'Marcus Bell', initials: 'MB', role: 'Sales rep', hue: 168 },
  { id: 'u_dana', name: 'Dana Okonkwo', initials: 'DO', role: 'Underwriting', hue: 24 },
  { id: 'u_leo', name: 'Leo Vasquez', initials: 'LV', role: 'Support', hue: 340 },
  { id: 'u_priya', name: 'Priya Nair', initials: 'PN', role: 'Accounting', hue: 190 },
  { id: 'u_tom', name: 'Tom Hargreaves', initials: 'TH', role: 'Relationship manager', hue: 45 },
];

export const USER_BY_ID = new Map(USERS.map((u) => [u.id, u]));

/** Who you are "signed in as". Switchable in the sidebar. */
export const DEFAULT_VIEWER = 'u_izzy';

const REP_IDS = ['u_sarah', 'u_marcus', 'u_tom', 'u_leo'];

/**
 * Marketing campaigns, for the polymorphic Record creator.
 *
 * Campaigns are "a future build" and have no module of their own, so these
 * exist only as ids a record can point at — which is the whole reason the
 * creator carries a discriminator from day one.
 */
export const CAMPAIGNS = [
  { id: 'camp_q3rest', name: 'Q3 Restaurant Push' },
  { id: 'camp_ecom', name: 'Ecom Outbound' },
  { id: 'camp_referral', name: 'Referral Partner Drive' },
];
export const CAMPAIGN_BY_ID = new Map(CAMPAIGNS.map((c) => [c.id, c]));

/* -------------------------------------------------------------------------- */
/* Source material                                                             */
/* -------------------------------------------------------------------------- */

const BUSINESSES: [string, string, string][] = [
  ["Joe's Pizza", 'LLC', 'Restaurant'],
  ['Bella Cafe', 'LLC', 'Restaurant'],
  ['Metro Mart', 'Inc', 'Convenience'],
  ['Sunrise Deli', 'LLC', 'Restaurant'],
  ['Northgate Liquors', 'Inc', 'Liquor'],
  ['Peak Fitness Club', 'LLC', 'Fitness'],
  ['Riverside Auto Body', 'Inc', 'Automotive'],
  ['Lotus Nail Spa', 'LLC', 'Salon & Spa'],
  ['Copperfield Hardware', 'Inc', 'Retail'],
  ['Sable & Sons Jewelers', 'LLC', 'Retail'],
  ['Harbor Dental Group', 'PC', 'Healthcare'],
  ['Verdant Garden Supply', 'LLC', 'Retail'],
  ['Kingsway Tyres', 'Inc', 'Automotive'],
  ['Blue Ridge Outfitters', 'LLC', 'E-commerce'],
  ['Marino Family Bakery', 'Inc', 'Restaurant'],
  ['Quartz Legal Partners', 'LLP', 'Professional Services'],
  ['Sixth Street Barbers', 'LLC', 'Salon & Spa'],
  ['Aurora Pet Clinic', 'PC', 'Healthcare'],
  ['Timberline Lumber', 'Inc', 'Retail'],
  ['Casa Verde Cantina', 'LLC', 'Restaurant'],
  ['Pinnacle Roofing', 'Inc', 'Professional Services'],
  ['Gilded Frame Gallery', 'LLC', 'Retail'],
  ['Fairmont Wine Cellar', 'Inc', 'Liquor'],
  ['Radiant Skin Studio', 'LLC', 'Salon & Spa'],
  ['Orchard Lane Grocers', 'Inc', 'Convenience'],
  ['Bayside Marine Repair', 'LLC', 'Automotive'],
  ['Stonebridge Physio', 'PC', 'Healthcare'],
  ['Vellum Print House', 'LLC', 'Professional Services'],
  ['Halcyon Yoga Loft', 'LLC', 'Fitness'],
  ['Duke Street Diner', 'Inc', 'Restaurant'],
  ['Meridian Optics', 'LLC', 'Healthcare'],
  ['Ferrous Metalworks', 'Inc', 'Professional Services'],
  ['Petal & Stem Florist', 'LLC', 'Retail'],
  ['Crown Point Cleaners', 'Inc', 'Professional Services'],
  ['Anchor Bait & Tackle', 'LLC', 'Retail'],
  ['Solstice Coffee Roasters', 'Inc', 'Restaurant'],
  ['Whitcombe Accounting', 'LLP', 'Professional Services'],
  ['Iron Gate Gym', 'LLC', 'Fitness'],
  ['Larkspur Boutique', 'LLC', 'E-commerce'],
  ['Vantage Auto Glass', 'Inc', 'Automotive'],
  ['Meadowbrook Vets', 'PC', 'Healthcare'],
  ['Tidewater Seafood Co', 'Inc', 'Restaurant'],
  ['Brightwell Pharmacy', 'Inc', 'Healthcare'],
  ['Cascade Ski Rentals', 'LLC', 'Retail'],
  ['Onyx Nightlife Group', 'LLC', 'Liquor'],
  ['Palladium Interiors', 'Inc', 'Professional Services'],
  ['Fenwick Toy Emporium', 'LLC', 'Retail'],
  ['Grove Street Grill', 'Inc', 'Restaurant'],
  ['Silverline Electric', 'LLC', 'Professional Services'],
  ['Wexford Book Barn', 'Inc', 'Retail'],
  ['Alpine Sports Depot', 'LLC', 'E-commerce'],
  ['Mosaic Tile Works', 'Inc', 'Retail'],
  ['Clearwater Pools', 'LLC', 'Professional Services'],
  ['Rutherford Motors', 'Inc', 'Automotive'],
  ['Juniper Day Spa', 'LLC', 'Salon & Spa'],
  ['Emberly Steakhouse', 'Inc', 'Restaurant'],
  ['Nordic Bake Shop', 'LLC', 'Restaurant'],
  ['Castlebrook Golf Shop', 'Inc', 'Retail'],
  ['Vertex Software Group', 'LLC', 'Professional Services'],
  ['Beacon Hill Chemists', 'Inc', 'Healthcare'],
  ['Thornbury Farm Store', 'LLC', 'Convenience'],
  ['Lumen Photography', 'LLC', 'Professional Services'],
  ['Saltwater Surf Co', 'Inc', 'E-commerce'],
  ['Windham Tea Rooms', 'LLC', 'Restaurant'],
];

const STREETS = ['Maple Ave', 'Commerce St', 'Baker Rd', 'Lakeview Dr', 'Chestnut Blvd', 'Winslow Way', 'Harborside Pkwy', 'Elmwood Ln'];
const CITIES: [string, string, string][] = [
  ['Portland', 'OR', '97205'], ['Austin', 'TX', '78701'], ['Tampa', 'FL', '33602'],
  ['Denver', 'CO', '80202'], ['Raleigh', 'NC', '27601'], ['Columbus', 'OH', '43215'],
  ['Phoenix', 'AZ', '85004'], ['Nashville', 'TN', '37203'],
];
const FIRST = ['Joseph', 'Maria', 'Andre', 'Nadia', 'Robert', 'Elena', 'Samuel', 'Grace', 'Hakim', 'Claire'];
const LAST = ['Moretti', 'Alvarez', 'Chen', 'Okafor', 'Sanderson', 'Vargas', 'Lindqvist', 'Baptiste', 'Whitmore', 'Duval'];
const TITLES = ['Owner', 'Managing Partner', 'President', 'CEO', 'Director of Ops'];
const AFFILIATES = ['Northstar Partners', 'Cobalt Referral Group', 'Redwood ISO', 'Halston Agency', ''];
const PRIOR_PROCESSORS = ['Square', 'Stripe', 'Heartland', 'Chase Paymentech', 'Toast', 'Clover / Fiserv'];
const PRIOR_POS = ['Clover Station', 'Toast Flex', 'Square Register', 'Aloha', 'Lightspeed', 'None'];
const MCC_CODES = ['5812', '5411', '5541', '7230', '8021', '5921', '7997', '5945', '0742', '0780'];

/* -------------------------------------------------------------------------- */
/* Per-module values                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `Current Status` has different choices per module, so it must also hold a
 * different VALUE per module — a record cannot be "Working" (a Leads status)
 * while sitting in Deals, whose list does not contain it.
 *
 * Keyed as `fieldId@module`. Only fields carrying `choicesByModule` use this;
 * every other field is stored under its plain id.
 */
export function valueKey(fieldId: string, moduleSlug?: string): string {
  const field = FIELDS.find((f) => f.id === fieldId);
  if (!field?.choicesByModule || !moduleSlug) return fieldId;
  return `${fieldId}@${moduleSlug}`;
}

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

function membershipsFor(i: number, rng: () => number): ModuleSlug[] {
  if (i % 17 === 5) return []; // archived — Records List only
  const m: ModuleSlug[] = [];
  const stage = i % 7;
  if (stage <= 2) m.push('leads');
  if (stage >= 1 && stage <= 4) m.push('deals');
  if (stage >= 3) m.push('contacts');
  if (stage >= 4) m.push('residuals');
  if (i % 5 === 0) m.push('tickets');
  if (i % 11 === 3 && !m.includes('leads')) m.push('leads');
  return m.length ? m : [pick(rng, ['leads', 'deals'] as const)];
}

function buildRecord(i: number): RecordRow {
  const rng = makeRng(i + 101);
  const [dealName, suffix, industry] = BUSINESSES[i]!;
  const [city, state, zip] = pick(rng, CITIES);
  const firstName = pick(rng, FIRST);
  const lastName = pick(rng, LAST);
  const domain = `${dealName.toLowerCase().replace(/[^a-z0-9]+/g, '')}.com`;
  const memberships = membershipsFor(i, rng);

  const acqVolume = int(rng, 12, 640) * 1000 + int(rng, 0, 99) * 10;
  const achVolume = rng() > 0.55 ? int(rng, 4, 180) * 1000 : 0;
  const avgTicket = int(rng, 18, 480);
  const owner = pick(rng, REP_IDS);
  const phone = () =>
    `(${int(rng, 201, 989)}) ${int(rng, 200, 999)}-${String(int(rng, 0, 9999)).padStart(4, '0')}`;

  /* --- repeatable groups --------------------------------------------- */
  const ownerCount = rng() > 0.78 ? 3 : rng() > 0.55 ? 2 : 1;
  const ownerPercents = ownerCount === 1 ? [100] : ownerCount === 2 ? [60, 40] : [50, 30, 20];
  const repeats: Record<string, FieldValue> = {};
  for (let n = 1; n <= ownerCount; n++) {
    const fn = n === 1 ? firstName : pick(rng, FIRST);
    const ln = n === 1 ? lastName : pick(rng, LAST);
    repeats[`owner_${n}_first`] = fn;
    repeats[`owner_${n}_last`] = ln;
    repeats[`owner_${n}_title`] = n === 1 ? pick(rng, TITLES) : 'Partner';
    repeats[`owner_${n}_phone`] = phone();
    repeats[`owner_${n}_email`] = `${fn.toLowerCase()}.${ln.toLowerCase()}@${domain}`;
    repeats[`owner_${n}_percentage`] = ownerPercents[n - 1]!;
    repeats[`owner_${n}_ssn`] = digits(rng, 9);
  }
  repeats._owner_count = ownerCount;

  const contactCount = rng() > 0.65 ? 2 : 1;
  for (let n = 1; n <= contactCount; n++) {
    const fn = n === 1 ? firstName : pick(rng, FIRST);
    repeats[`contact_name_${n}`] = `${fn} ${pick(rng, LAST)}`;
    repeats[`contact_email_${n}`] = `${fn.toLowerCase()}@${domain}`;
    repeats[`contact_phone_${n}`] = phone();
  }
  repeats._contact_count = contactCount;

  const affiliateName = pick(rng, AFFILIATES);
  const affCount = affiliateName ? 1 : 0;
  if (affCount) {
    repeats.affiliate_name_1 = `${pick(rng, FIRST)} ${pick(rng, LAST)}`;
    repeats.affiliate_email_1 = `partners@${affiliateName.toLowerCase().replace(/[^a-z]/g, '')}.com`;
    repeats.affiliate_phone_1 = phone();
  }
  repeats._affiliate_count = Math.max(1, affCount);

  /* --- per-module Current Status -------------------------------------- */
  const statusByModule: Record<string, FieldValue> = {
    'current_status@records': pick(rng, ['Urgent', 'High', 'Mid', 'Low']),
    'current_status@tickets': pick(rng, ['Urgent', 'High', 'Mid', 'Low']),
    'current_status@residuals': pick(rng, ['Urgent', 'High', 'Mid', 'Low']),
    'current_status@leads': pick(rng, ['New lead', 'Working', 'Qualified', 'Proposal sent', 'Closed']),
    'current_status@deals': pick(rng, ['Application sent', 'Underwriting', 'Approved', 'Live', 'Declined']),
    'current_status@contacts': pick(rng, ['Onboarding', 'Active', 'At risk', 'Churned']),
  };

  const values: Record<string, FieldValue> = {
    ...repeats,
    ...statusByModule,

    /* Overview */
    legal_business_name: `${dealName} ${suffix}`,
    mid: memberships.some((m) => m !== 'leads') ? digits(rng, rng() > 0.5 ? 8 : 9) : null,
    risk_level: pick(rng, ['No risk', 'Low', 'Low', 'Medium', 'High']),
    team_members_assigned: [owner, ...(rng() > 0.72 ? [pick(rng, REP_IDS)] : [])].filter(
      (v, idx, a) => a.indexOf(v) === idx,
    ),
    relationship_manager: rng() > 0.5 ? ['u_tom'] : [],
    last_merchant_response: daysBefore(int(rng, 1, 60)),
    last_outreach: daysBefore(int(rng, 0, 21)),
    onboard_date: memberships.includes('contacts') ? daysBefore(int(rng, 30, 500)) : null,
    mcc_code: pick(rng, MCC_CODES),
    merchant_industry: industry,
    merchant_website: `https://www.${domain}`,

    /* Contact */
    affiliate_business_name: affiliateName,
    merchant_address: `${int(rng, 100, 4899)} ${pick(rng, STREETS)}, ${city}, ${state} ${zip}`,
    affiliate_main_email: affiliateName ? `hello@${affiliateName.toLowerCase().replace(/[^a-z]/g, '')}.com` : '',
    affiliate_main_phone: affiliateName ? phone() : '',

    /* Marketing */
    campaign: pick(rng, ['Q3 Restaurant Push', 'Ecom Outbound', 'Referral Partner Drive', 'Renewal Winback']),
    pitch: pick(rng, ['Rate savings', 'Cash discount', 'Next-day funding', 'POS upgrade']),
    ad_campaign: pick(rng, ['Q3 Restaurant Push', 'Ecom Outbound', 'Referral Partner Drive']),
    date_lead_generated: daysBefore(int(rng, 20, 420)),

    /* Application → General */
    retail_address: rng() > 0.4 ? `${int(rng, 100, 4899)} ${pick(rng, STREETS)}, ${city}, ${state} ${zip}` : 'N/A',
    dba: dealName,
    entity_type: suffix === 'LLC' ? 'LLC' : suffix === 'LLP' ? 'Partnership' : 'Corp',
    describe_product_service: rng() > 0.5 ? 'Counter-service food and beverage, dine-in and takeaway.' : '',
    fax_number: rng() > 0.7 ? phone() : '',
    business_founded_date: daysBefore(int(rng, 700, 9000)),
    seasonal: rng() > 0.75 ? ['Jun', 'Jul', 'Aug'] : [],
    charge_to_service: pick(rng, ['24 hours', '2 days', '3-10 days']),
    order_to_service: pick(rng, ['24 hours', '2-5 days', '6-10 days']),
    building_type: pick(rng, ['Shopping center', 'Office building', 'Industrial', 'Residence']),
    building_ownership: pick(rng, ['Owns', 'Rents']),
    area_zoned: pick(rng, ['Commercial', 'Industrial', 'Residential']),
    square_footage: pick(rng, ['0-500', '501-2500', '2501-5000', '5001-10000', '10000+']),
    inventory: pick(rng, ['On-site', 'Off-site', '3rd party', 'Service only']),
    other_fulfillment: pick(rng, ['Yes', 'No']),
    recurring_subscription: pick(rng, ['Yes', 'No']),
    when_charged: pick(rng, ['Time of order', 'Upon shipment']),
    advertising_method: rng() > 0.5 ? 'Local radio and Instagram' : '',
    third_party_shipping: pick(rng, ['Yes', 'No']),
    refund_policy: rng() > 0.6 ? '30 days with receipt, store credit thereafter.' : '',
    bankruptcy: rng() > 0.85 ? ['Business'] : ['Never'],
    customer_type: split(rng, ['Business', 'Gov', 'Individual']),
    customer_profile: split(rng, ['Local', 'National', 'International']),
    sales_method: split(rng, ['In person', 'Mail/phone', 'Ecommerce']),

    /* Application → Financial */
    monthly_acq_volume: acqVolume,
    monthly_ach_volume: achVolume,
    avg_transaction: avgTicket,
    max_transaction: avgTicket * int(rng, 4, 20),
    amex_monthly_volume: Math.round(acqVolume * (int(rng, 2, 14) / 100)),

    /* Application → ACQ */
    cc_termination: rng() > 0.9 ? 'Yes' : 'No',
    amex_esa: rng() > 0.6 ? digits(rng, 10) : '',
    ebt_fns: rng() > 0.8 ? digits(rng, 7) : '',

    /* Application → ACH */
    ach_monthly_returns: achVolume ? int(rng, 0, 12) : null,
    ach_credits_required: achVolume ? pick(rng, ['Yes', 'No']) : null,
    payment_codes: achVolume ? split(rng, ['PPD', 'CCD', 'Web', 'Tel']) : null,
    ach_termination: 'No',

    /* Application → Private */
    ein: digits(rng, 9),
    account_number: digits(rng, int(rng, 9, 12)),
    routing_number: digits(rng, 9),

    /* Application → Prior Processor */
    prior_processor: pick(rng, PRIOR_PROCESSORS),
    prior_gateway: pick(rng, ['Authorize.net', 'NMI', 'None', '']),
    prior_pos: pick(rng, PRIOR_POS),
    prior_pos_agnostic: rng() > 0.55,
    prior_acq_pricing_model: pick(rng, ['DP', 'Flat', 'IC+', 'Tiered']),
    prior_ach_provider: rng() > 0.6 ? pick(rng, ['Paya', 'Maverick', '']) : '',
    prior_terminal_provider: pick(rng, ['Dejavoo', 'PAX', 'Verifone', '']),
  };

  // Pipeline assignment — independent per module, as the spec requires.
  const pipeline: RecordRow['pipeline'] = {};
  for (const m of memberships) {
    const p = PIPELINES.find((pl) => pl.module === m);
    if (!p) continue;
    if (rng() < 0.16) continue; // a record may have no pipeline
    pipeline[m] = { pipelineId: p.id, stepId: pick(rng, p.steps).id };
  }

  // Roughly one record in nine was created by a campaign, not a person.
  const creator: Creator =
    i % 9 === 4
      ? { kind: 'campaign', id: pick(rng, CAMPAIGNS).id }
      : { kind: 'user', id: pick(rng, REP_IDS) };

  return {
    id: `rec_${String(i + 1).padStart(3, '0')}`,
    dealName,
    values,
    creator,
    memberships,
    pipeline,
    createdAt: daysBefore(int(rng, 25, 500)),
  };
}

export const RECORDS: RecordRow[] = BUSINESSES.map((_, i) => buildRecord(i));

/** One record in the Recycle Bin, so Delete → Restore has something to show. */
RECORDS.push({
  ...buildRecord(3),
  id: 'rec_deleted_1',
  dealName: 'Halewood Cycle Works',
  memberships: [], // archived before it could be deleted — the rule
  pipeline: {},
  deleted: true,
  createdAt: daysBefore(410),
});

export const RECORD_BY_ID = new Map(RECORDS.map((r) => [r.id, r]));

/* -------------------------------------------------------------------------- */
/* The "Other" tab — per-record entries, added by users                        */
/* -------------------------------------------------------------------------- */

const CUSTOM_SEEDS: [string, string][] = [
  ['Gate code', '#4471 — rear loading bay'],
  ['Best time to call', 'Before 10am, never Fridays'],
  ['Parking', 'Two spaces behind the unit, ask for Marco'],
  ['Landlord contact', 'Hallam Estates, 555-0182'],
  ['Old MID (pre-2024)', '447829104'],
  ['Franchise agreement', 'Renews each March, group-wide pricing'],
];

export const CUSTOM_ENTRIES: CustomEntry[] = RECORDS.filter((r) => !r.deleted).flatMap(
  (r, i) => {
    const rng = makeRng(i + 8800);
    if (rng() > 0.35) return [];
    const n = int(rng, 1, 3);
    return Array.from({ length: n }, (_, k) => {
      const [label, value] = CUSTOM_SEEDS[(i + k) % CUSTOM_SEEDS.length]!;
      return {
        id: `ce_${r.id}_${k}`,
        recordId: r.id,
        label,
        value,
        createdBy: pick(rng, REP_IDS),
        at: isoBefore(int(rng, 20, 1600)),
      };
    });
  },
);

/* -------------------------------------------------------------------------- */
/* Communication                                                               */
/* -------------------------------------------------------------------------- */

const EMAIL_BODIES = [
  'Thanks for sending the statement over. Our underwriting team is reviewing it now and I should have indicative pricing back to you by Thursday.',
  'Following up on the proposal I sent last week — did you get a chance to look at the effective rate comparison?',
  'Attaching the signed application. Let me know if you need anything else from our side to get this moving.',
  'We are still waiting on the voided check and the last three months of processing statements. Once those land we can submit.',
  'Quick note: the terminal shipped this morning, tracking is in the portal. Install is booked for Tuesday at 9am.',
];
const TEXT_BODIES = [
  'Hi — is now a good time for a quick call?',
  'Statements sent to your email just now.',
  'Can we push the install to Wednesday?',
  'Got it, thanks!',
  'The reader is showing a decline error again.',
];

export const MESSAGES: Message[] = RECORDS.filter((r) => !r.deleted).flatMap((r, i) => {
  const rng = makeRng(i + 900);
  const email = String(r.values.contact_email_1 ?? 'merchant@example.com');
  const count = int(rng, 0, 5);
  return Array.from({ length: count }, (_, k) => {
    const inbound = rng() > 0.5;
    const channel: Message['channel'] = rng() > 0.72 ? 'text' : rng() > 0.4 ? 'email' : 'instantly';
    return {
      id: `msg_${r.id}_${k}`,
      recordId: r.id,
      channel,
      direction: inbound ? ('in' as const) : ('out' as const),
      from: inbound ? email : 'sarah@tapdash.co',
      to: inbound ? 'sarah@tapdash.co' : email,
      subject:
        channel === 'text'
          ? undefined
          : pick(rng, [
              `Re: ${r.dealName} — pricing proposal`,
              `${r.dealName} — application status`,
              'Statements requested',
              'Install scheduling',
            ]),
      body: channel === 'text' ? pick(rng, TEXT_BODIES) : pick(rng, EMAIL_BODIES),
      at: isoBefore(int(rng, 2, 900)),
    };
  });
});

/* -------------------------------------------------------------------------- */
/* Updates — threads exactly one level deep                                    */
/* -------------------------------------------------------------------------- */

const UPDATE_BODIES = [
  'Spoke to the owner. They want to see side-by-side pricing against their current Square rate before committing.',
  'Statements received — three months, all clean. Passing to underwriting.',
  'Heads up: they have a second location opening in the spring, so volume should roughly double.',
  'Left a voicemail. Trying again Thursday morning.',
  'Approved with a rolling reserve. Sending the terms across today.',
  'Merchant asked about next-day funding — confirmed available on this platform.',
];
const REPLY_BODIES = [
  'Nice one. I will get the comparison sheet built this afternoon.',
  'Thanks — reserve terms look reasonable given the MCC.',
  'Noted, I have flagged it on the account.',
  'Do you want me to loop in underwriting now or wait for the statements?',
];

export const UPDATES: Update[] = RECORDS.filter((r) => !r.deleted).flatMap((r, i) => {
  const rng = makeRng(i + 1700);
  const threads = int(rng, 0, 3);
  const out: Update[] = [];
  for (let t = 0; t < threads; t++) {
    const rootId = `upd_${r.id}_${t}`;
    out.push({
      id: rootId,
      recordId: r.id,
      authorId: pick(rng, REP_IDS),
      body: pick(rng, UPDATE_BODIES),
      at: isoBefore(int(rng, 6, 1400)),
      edited: rng() > 0.85,
      mentions: rng() > 0.75 ? [pick(rng, REP_IDS)] : undefined,
    });
    const replies = int(rng, 0, 3);
    for (let k = 0; k < replies; k++) {
      out.push({
        id: `${rootId}_r${k}`,
        recordId: r.id,
        parentId: rootId,
        authorId: pick(rng, REP_IDS),
        body: pick(rng, REPLY_BODIES),
        at: isoBefore(int(rng, 1, 500)),
      });
    }
  }
  return out;
});

/* -------------------------------------------------------------------------- */
/* Cases — one global sequence from #10000, never reused                       */
/* -------------------------------------------------------------------------- */

const CASE_SEEDS: [string, string, string | undefined][] = [
  ['Terminal declining all chip transactions',
   'Merchant reports every chip transaction declining with error 51 since Monday morning. Swipe still works. Batch closed normally on Sunday.',
   'Firmware on the Dejavoo was two versions behind. Pushed the update remotely and confirmed a $1 test sale. Merchant confirmed resolved.'],
  ['Deposits arriving two days late',
   'Funding was next-day at boarding but the last three batches have settled on day two. Merchant is chasing because it affects their payroll run.',
   undefined],
  ['Chargeback response never submitted',
   'A $2,340 chargeback from 14 June was not responded to within the window and has been debited. Merchant supplied the signed receipt at the time.',
   'Represented under the late-compelling-evidence path. Funds returned on 02 August. Reminder rule added so the deadline is flagged at day 5.'],
  ['Statement shows a fee not on the proposal',
   'A $19.95 "compliance service" line appeared on the July statement. It is not in the signed pricing schedule.',
   undefined],
  ['Gateway API keys rotated without notice',
   'Their developer rotated the Authorize.net keys and the ecommerce checkout has been down since 08:00.',
   'Issued new keys and walked the developer through updating the store config. Checkout confirmed live at 11:20.'],
  ['Requesting rate review after volume increase',
   'Volume has gone from roughly 90k to 210k per month since opening the second location. Owner is asking for the tier to be revisited.',
   undefined],
  ['PCI non-compliance fee applied',
   'Merchant was charged the non-compliance fee despite completing the SAQ in May. Confirmation email attached.',
   'SAQ had been filed against the old MID. Re-linked and the fee was refunded on the next statement.'],
  ['Duplicate batch settled twice',
   'The 06 August batch appears twice in the deposit report, total overstated by $4,118.',
   undefined],
];

export const CASES: CaseThread[] = (() => {
  const out: CaseThread[] = [];
  let seq = 10_000; // the global sequence, exactly as specified
  const withTickets = RECORDS.filter((r) => !r.deleted && r.memberships.includes('tickets'));

  withTickets.forEach((r, i) => {
    const rng = makeRng(i + 2600);
    const n = int(rng, 1, 3);
    for (let k = 0; k < n; k++) {
      const [title, issue, solution] = CASE_SEEDS[(i + k) % CASE_SEEDS.length]!;
      const author = pick(rng, REP_IDS);
      const hasSolution = Boolean(solution);
      const managers = [author, ...(rng() > 0.6 ? [pick(rng, ['u_leo', 'u_dana'])] : [])].filter(
        (v, idx, a) => a.indexOf(v) === idx,
      );
      out.push({
        id: `case_${r.id}_${k}`,
        recordId: r.id,
        number: seq++,
        title,
        issue,
        issueAuthorId: author,
        issueAt: isoBefore(int(rng, 40, 2000)),
        solution,
        solutionAuthorId: hasSolution ? pick(rng, managers) : undefined,
        solutionAt: hasSolution ? isoBefore(int(rng, 2, 38)) : undefined,
        managerIds: managers,
        // A case can only be Closed once a Solution exists.
        state: hasSolution && rng() > 0.3 ? 'closed' : 'open',
        replies:
          rng() > 0.45
            ? [
                {
                  id: `case_${r.id}_${k}_r0`,
                  authorId: pick(rng, REP_IDS),
                  body: 'Called the merchant to confirm the timeline. They are fine to wait until Friday.',
                  at: isoBefore(int(rng, 5, 200)),
                },
              ]
            : [],
        files: rng() > 0.6 ? int(rng, 1, 3) : 0,
        editedBy: rng() > 0.92 ? 'u_izzy' : undefined,
      });
    }
  });
  return out;
})();

export const NEXT_CASE_NUMBER = 10_000 + CASES.length;

/* -------------------------------------------------------------------------- */
/* Files                                                                       */
/* -------------------------------------------------------------------------- */

export const APPLICATION_ROWS = [
  'Owner ID', 'Bank statements', 'Processing statements', 'Corp docs', 'Voided check',
] as const;

export const FILES: FileRow[] = RECORDS.filter((r) => !r.deleted).flatMap((r, i) => {
  const rng = makeRng(i + 3300);
  const rows: FileRow[] = APPLICATION_ROWS.map((name, k) => {
    const filled = rng() > 0.35;
    return {
      id: `file_${r.id}_app${k}`,
      recordId: r.id,
      kind: 'application' as const,
      name,
      locked: true,
      files: filled
        ? Array.from({ length: int(rng, 1, 4) }, (_, n) => ({
            name: `${name.toLowerCase().replace(/ /g, '-')}-${n + 1}.pdf`,
            size: `${int(rng, 120, 4800)} KB`,
            at: isoBefore(int(rng, 20, 1800)),
            version: n === 0 && rng() > 0.8 ? 2 : 1,
          }))
        : [],
      note: filled && rng() > 0.7 ? 'Second page was illegible — merchant re-sent.' : undefined,
    };
  });

  const otherCount = int(rng, 0, 3);
  for (let k = 0; k < otherCount; k++) {
    const name = pick(rng, [
      'Signed proposal', 'Site survey photos', 'Equipment agreement',
      'Landlord waiver', 'Prior statements (archive)',
    ]);
    rows.push({
      id: `file_${r.id}_oth${k}`,
      recordId: r.id,
      kind: 'other',
      name,
      files: [
        {
          name: `${name.toLowerCase().replace(/[^a-z]+/g, '-')}.pdf`,
          size: `${int(rng, 90, 9000)} KB`,
          at: isoBefore(int(rng, 10, 1200)),
        },
      ],
    });
  }
  return rows;
});

/* -------------------------------------------------------------------------- */
/* Logins                                                                      */
/* -------------------------------------------------------------------------- */

const LOGIN_TYPES: [string, string][] = [
  ['Merchant portal', 'https://portal.maverickpayments.com'],
  ['Gateway', 'https://account.authorize.net'],
  ['POS back office', 'https://www.clover.com/dashboard'],
  ['Bank', 'https://business.chase.com'],
  ['Reporting', 'https://ims.micamp.com'],
];

export const LOGINS: LoginRow[] = RECORDS.filter((r) => !r.deleted).flatMap((r, i) => {
  const rng = makeRng(i + 4100);
  const n = int(rng, 0, 4);
  return Array.from({ length: n }, (_, k) => {
    const [type, link] = LOGIN_TYPES[(i + k) % LOGIN_TYPES.length]!;
    return {
      id: `login_${r.id}_${k}`,
      recordId: r.id,
      type,
      link,
      user: String(r.values.contact_email_1 ?? 'merchant@example.com'),
      // Invented. Nothing here is or ever was a real credential.
      pass: `Tp${int(rng, 1000, 9999)}!${pick(rng, ['xk', 'qz', 'mv', 'rb'])}${int(rng, 10, 99)}`,
      note: rng() > 0.75 ? 'MFA sends to the owner’s mobile.' : undefined,
    };
  });
});

/* -------------------------------------------------------------------------- */
/* Statements — prebuilt month rows, July 2024 → December 2032                 */
/* -------------------------------------------------------------------------- */

export const STATEMENT_FIRST = { year: 2024, month: 7 };
export const STATEMENT_LAST_YEAR = 2032;

export const STATEMENT_YEARS = Array.from(
  { length: STATEMENT_LAST_YEAR - STATEMENT_FIRST.year + 1 },
  (_, i) => STATEMENT_FIRST.year + i,
);

export const STATEMENTS: StatementFile[] = RECORDS.filter(
  (r) => !r.deleted && r.memberships.includes('residuals'),
).flatMap((r, i) => {
  const rng = makeRng(i + 5200);
  const out: StatementFile[] = [];
  for (let back = 1; back <= 16; back++) {
    if (rng() < 0.25) continue;
    const d = new Date(Date.UTC(2026, 7 - back, 1));
    out.push({
      recordId: r.id,
      period: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
      files: [
        {
          name: `residual-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.pdf`,
          size: `${int(rng, 180, 900)} KB`,
          at: isoBefore(back * 720),
        },
      ],
    });
  }
  return out;
});

/* -------------------------------------------------------------------------- */
/* Notes — field-scoped AND tab-scoped, one table                              */
/* -------------------------------------------------------------------------- */

const FIELD_NOTE_BODIES: Record<string, string[]> = {
  seasonal: [
    'Owner says June to August is roughly 70% of the year’s volume. Worth flagging to underwriting before they see the monthly average.',
    'Confirmed again on the August call — they close entirely for two weeks in January.',
  ],
  inventory: ['Stock is held at a third-party warehouse in Reno, not on site.'],
  bankruptcy: ['Business filing was 2016 under the previous owner. Current owner bought the entity in 2019.'],
  cc_termination: ['Terminated by a prior processor in 2021 over chargeback ratio. Ratio has been under 0.4% for eighteen months since.'],
  ach_credits_required: ['They pay ~40 vendors by ACH every fortnight. Credits are essential.'],
  ach_termination: ['No history. Confirmed with the owner in writing.'],
  merchant_address: ['Suite number on the statement is out of date — they moved from Suite 4 to Suite 11 last spring.'],
};

/** "Each tab should have a notes field" / "Each sub tab should have a notes field". */
const TAB_NOTE_BODIES: Record<string, string[]> = {
  overview: ['Merchant was referred by an existing client — treat pricing sensitively.'],
  contact: ['Owner prefers text over email. Do not call the landline, nobody answers it.'],
  'application/private': ['ID and voided check verified against the bank letter on 04 Aug.'],
  'application/prior': ['They are still inside a 90-day notice period with the prior processor.'],
  pricing: ['Rate agreed verbally at 2.45% effective; awaiting the signed schedule.'],
};

export const NOTES: Note[] = RECORDS.filter((r) => !r.deleted).flatMap((r, i) => {
  const rng = makeRng(i + 7700);
  const out: Note[] = [];

  for (const [fieldId, bodies] of Object.entries(FIELD_NOTE_BODIES)) {
    if (rng() > 0.22) continue;
    bodies.forEach((body, k) => {
      if (k > 0 && rng() > 0.4) return;
      out.push({
        id: `note_f_${r.id}_${fieldId}_${k}`,
        recordId: r.id,
        scopeKind: 'field',
        scopeId: fieldId,
        authorId: pick(rng, REP_IDS),
        body,
        at: isoBefore(int(rng, 12, 1600)),
        edited: rng() > 0.9,
      });
    });
  }

  for (const [tabId, bodies] of Object.entries(TAB_NOTE_BODIES)) {
    if (rng() > 0.25) continue;
    bodies.forEach((body, k) => {
      out.push({
        id: `note_t_${r.id}_${tabId.replace('/', '_')}_${k}`,
        recordId: r.id,
        scopeKind: 'tab',
        scopeId: tabId,
        authorId: pick(rng, REP_IDS),
        body,
        at: isoBefore(int(rng, 12, 1400)),
      });
    });
  }

  return out;
});

/* -------------------------------------------------------------------------- */
/* Activity log                                                                */
/* -------------------------------------------------------------------------- */

export const ACTIVITY: ActivityEntry[] = RECORDS.filter((r) => !r.deleted).flatMap((r, i) => {
  const rng = makeRng(i + 6400);
  const entries: ActivityEntry[] = [
    {
      id: `act_${r.id}_0`,
      recordId: r.id,
      actorId: r.creator.kind === 'user' ? r.creator.id : 'u_sarah',
      at: isoBefore(int(rng, 1200, 5000)),
      kind: 'record',
      summary:
        r.creator.kind === 'campaign'
          ? `Record created by campaign — ${CAMPAIGN_BY_ID.get(r.creator.id)?.name}`
          : 'Record created in Leads',
    },
  ];

  const pool = FIELDS.filter((f) => !f.system && !f.sensitive && f.type !== 'grid');
  const n = int(rng, 3, 9);
  for (let k = 0; k < n; k++) {
    const kind = pick(rng, [
      'field', 'field', 'field', 'membership', 'pipeline', 'file', 'update', 'credential',
    ] as const);
    const at = isoBefore(int(rng, 3, 1150));
    const base = { id: `act_${r.id}_${k + 1}`, recordId: r.id, actorId: pick(rng, REP_IDS), at };

    if (kind === 'field') {
      const fld = pick(rng, pool);
      entries.push({
        ...base,
        kind,
        summary: `${fld.label} changed`,
        from: fld.type === 'currency' ? `$${int(rng, 10, 90)},000` : 'Working',
        to: fld.type === 'currency' ? `$${int(rng, 90, 300)},000` : 'Underwriting',
      });
    } else if (kind === 'membership') {
      entries.push({
        ...base, kind,
        summary: `Added to ${pick(rng, ['Deals', 'Contacts', 'Tickets', 'Residuals'])}`,
      });
    } else if (kind === 'pipeline') {
      entries.push({
        ...base, kind, summary: 'Pipeline step moved',
        from: 'Application received', to: 'Underwriting',
      });
    } else if (kind === 'file') {
      entries.push({ ...base, kind, summary: `Uploaded to ${pick(rng, APPLICATION_ROWS)}` });
    } else if (kind === 'credential') {
      // Every reveal is audited. This is what that looks like in the log.
      entries.push({ ...base, kind, summary: `Revealed password — ${pick(rng, LOGIN_TYPES)[0]}` });
    } else {
      entries.push({ ...base, kind, summary: 'Posted an update' });
    }
  }
  return entries.sort((a, b) => (a.at < b.at ? 1 : -1));
});

/* -------------------------------------------------------------------------- */
/* Notifications                                                               */
/* -------------------------------------------------------------------------- */

export const NOTIFICATIONS: Notification[] = [
  { id: 'n1', body: 'Sarah Whitfield mentioned you on Bella Cafe', at: isoBefore(3), read: false, recordId: 'rec_002' },
  { id: 'n2', body: 'Case #10003 was assigned to you', at: isoBefore(9), read: false },
  { id: 'n3', body: 'Marcus Bell mentioned you on Metro Mart', at: isoBefore(27), read: false, recordId: 'rec_003' },
  { id: 'n4', body: 'Dana Okonkwo replied to your update on Peak Fitness Club', at: isoBefore(52), read: true, recordId: 'rec_006' },
];
