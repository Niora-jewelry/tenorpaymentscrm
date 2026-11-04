/**
 * Every provider setting that can be entered in CRM Settings › Integrations.
 *
 * Infrastructure secrets are deliberately not here and can never be: Supabase's
 * keys, OTP_PEPPER, LOGIN_ENC_KEY, MAIL_TOKEN_ENC_KEY, MAIL_STATE_SIGNING_SECRET
 * and CRON_SECRET. The app needs them to reach or to unlock this very table.
 *
 * Pure data and checks, so the browser form and the server share one definition.
 */

export type IntegrationGroup = 'twilio' | 'microsoft' | 'signwell' | 'alerts';

export type SettingKind = 'text' | 'secret' | 'date' | 'switch' | 'number';

export type SettingDef = {
  key: string;
  group: IntegrationGroup;
  label: string;
  kind: SettingKind;
  /** Needed for the service to count as connected. */
  required: boolean;
  placeholder?: string;
  help?: string;
  /** Null when the value is fine, otherwise what to tell the person typing. */
  check?: (value: string) => string | null;
};

const startsWith = (prefix: string, label: string) => (v: string) =>
  new RegExp(`^${prefix}[0-9a-fA-F]{32}$`).test(v) ? null : `${label} starts with ${prefix} followed by 32 letters and numbers.`;

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const uuid = (label: string) => (v: string) => (UUID.test(v) ? null : `${label} looks like 11111111-2222-3333-4444-555555555555.`);

const noSpaces = (label: string) => (v: string) => (/\s/.test(v) ? `${label} has no spaces in it.` : null);

/** The From line of an alert: an address, with or without a name in front. */
export function validFrom(v: string): string | null {
  const address = /<([^<>]+)>\s*$/.exec(v)?.[1] ?? v;
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address.trim()) ? null : 'Enter an address, like Tenor Payments <No-Reply@tenorpayments.com>.';
}

export const SETTINGS: readonly SettingDef[] = [
  { key: 'TWILIO_ACCOUNT_SID', group: 'twilio', label: 'Account SID', kind: 'text', required: true, placeholder: 'AC…', check: startsWith('AC', 'The Account SID') },
  { key: 'TWILIO_AUTH_TOKEN', group: 'twilio', label: 'Auth token', kind: 'secret', required: true, check: noSpaces('The auth token') },
  { key: 'TWILIO_API_KEY_SID', group: 'twilio', label: 'API key SID', kind: 'text', required: true, placeholder: 'SK…', check: startsWith('SK', 'The API key SID') },
  { key: 'TWILIO_API_KEY_SECRET', group: 'twilio', label: 'API key secret', kind: 'secret', required: true, check: noSpaces('The API key secret') },
  { key: 'TWILIO_TWIML_APP_SID', group: 'twilio', label: 'TwiML app SID', kind: 'text', required: true, placeholder: 'AP…', check: startsWith('AP', 'The TwiML app SID') },

  { key: 'MAIL_CLIENT_ID', group: 'microsoft', label: 'Application (client) ID', kind: 'text', required: true, check: uuid('The client ID') },
  { key: 'MAIL_CLIENT_SECRET', group: 'microsoft', label: 'Client secret value', kind: 'secret', required: true, help: 'The Value column in Azure, not the Secret ID.' },
  { key: 'ALERT_MAIL_TENANT_ID', group: 'microsoft', label: 'Directory (tenant) ID', kind: 'text', required: false, help: 'Your company’s tenant. Needed to test the app and to send alerts through Microsoft.', check: uuid('The tenant ID') },
  { key: 'MAIL_CLIENT_SECRET_EXPIRES_AT', group: 'microsoft', label: 'Secret expires on', kind: 'date', required: false, help: 'The CRM warns admins before this date.', check: (v) => (Number.isNaN(Date.parse(v)) ? 'Pick a date.' : null) },
  {
    key: 'MAIL_ALLOWED_TENANT_IDS',
    group: 'microsoft',
    label: 'Allowed tenants',
    kind: 'text',
    required: false,
    help: 'Only accounts from these tenants can connect. Separate with commas. Leave empty to allow any work account, which is what lets people from other organizations connect.',
    check: (v) => (v.split(',').map((t) => t.trim()).filter(Boolean).every((t) => UUID.test(t)) ? null : 'Enter tenant IDs separated by commas.'),
  },

  { key: 'SIGNWELL_API_KEY', group: 'signwell', label: 'API key', kind: 'secret', required: true, check: noSpaces('The API key') },
  { key: 'SIGNWELL_WEBHOOK_ID', group: 'signwell', label: 'Webhook ID', kind: 'secret', required: true, help: 'Proves signing events really came from SignWell. Separate several with commas. “Connect this site” below fills it in.', check: (v) => (/^[\w\-,\s]+$/.test(v) ? null : 'A webhook ID is letters, numbers and dashes.') },
  { key: 'SIGNWELL_TEST_MODE', group: 'signwell', label: 'Test mode', kind: 'switch', required: false, help: 'On: documents are free and not legally binding. Turn off to send real agreements.', check: (v) => (v === 'true' || v === 'false' ? null : 'Choose on or off.') },

  { key: 'EMAIL_FROM', group: 'alerts', label: 'From line', kind: 'text', required: true, placeholder: 'Tenor Payments <No-Reply@tenorpayments.com>', help: 'The mailbox alerts and sign-in codes come from.', check: validFrom },
  { key: 'ALERT_MAIL_CLIENT_ID', group: 'alerts', label: 'Client ID for alerts', kind: 'text', required: false, help: 'Only if alerts use a different Azure app from Email.', check: uuid('The client ID') },
  { key: 'ALERT_MAIL_CLIENT_SECRET', group: 'alerts', label: 'Client secret for alerts', kind: 'secret', required: false, help: 'Only if alerts use a different Azure app from Email.' },
  { key: 'SMTP_HOST', group: 'alerts', label: 'SMTP server', kind: 'text', required: false, placeholder: 'smtp.office365.com', check: (v) => (/^[a-zA-Z0-9.-]+$/.test(v) ? null : 'Enter a server name, like smtp.office365.com.') },
  { key: 'SMTP_PORT', group: 'alerts', label: 'SMTP port', kind: 'number', required: false, placeholder: '587', check: (v) => (/^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 65535 ? null : 'Enter a port, usually 587.') },
  { key: 'SMTP_USER', group: 'alerts', label: 'SMTP username', kind: 'text', required: false },
  { key: 'SMTP_PASSWORD', group: 'alerts', label: 'SMTP password', kind: 'secret', required: false },
] as const;

export const SETTING_KEYS: readonly string[] = SETTINGS.map((s) => s.key);

export const settingDef = (key: string): SettingDef | undefined => SETTINGS.find((s) => s.key === key);

export const settingsIn = (group: IntegrationGroup): SettingDef[] => SETTINGS.filter((s) => s.group === group);

/**
 * What the screen may show after saving. A secret keeps only its last four
 * characters, and only when it is long enough that four give nothing away.
 */
export function hintFor(def: SettingDef, value: string): string {
  if (def.kind !== 'secret') return value;
  return value.length >= 16 ? `ending in ${value.slice(-4)}` : 'saved';
}

/** Trims what was pasted and checks its shape. */
export function cleanValue(def: SettingDef, raw: string): { ok: true; value: string } | { ok: false; message: string } {
  const value = raw.trim();
  if (!value) return { ok: false, message: `${def.label} is empty.` };
  if (value.length > 2000) return { ok: false, message: `${def.label} is too long.` };
  const problem = def.check?.(value);
  return problem ? { ok: false, message: problem } : { ok: true, value };
}
