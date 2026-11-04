/**
 * The Help panel on each service in CRM Settings › Integrations (client, 4 Nov
 * 2026: "shows from where that values they got with steps and link").
 *
 * For every setting: where in the provider's own screens the value is found.
 * Then the steps, in order, and links straight to those screens. Pure data, so
 * the browser renders it without a round trip.
 */
import type { IntegrationGroup } from './catalog';
import { GRAPH_SCOPES, TEAMS_SCOPES } from '@/lib/mail/scopes';

export type HelpLink = { label: string; href: string };
export type HelpStep = { text: string; link?: HelpLink };

export type IntegrationHelp = {
  /** One line: what this connection is for. */
  summary: string;
  /** Who usually has access to the provider's console. */
  who: string;
  steps: HelpStep[];
  /** Setting key → where its value is found. */
  where: Record<string, string>;
  links: HelpLink[];
  /** Anything that trips people up. */
  notes?: string[];
};

const MS_PERMISSIONS = [...GRAPH_SCOPES, ...TEAMS_SCOPES].join(', ');

export const HELP: Record<IntegrationGroup, IntegrationHelp> = {
  twilio: {
    summary: 'Calls from the browser, call recordings, voicemail and text messages.',
    who: 'Whoever owns the company’s Twilio account.',
    steps: [
      { text: 'Sign in to the Twilio Console.', link: { label: 'Open Twilio Console', href: 'https://console.twilio.com/' } },
      { text: 'On the Console home page, under Account Info, copy the Account SID (starts with AC) and the Auth Token (press Show first).' },
      {
        text: 'Go to Account › API keys & tokens › Create API key. Pick Standard, give it a name like “Tenor CRM”, and create it. Copy the SID (starts with SK) and the Secret. The secret is shown only once.',
        link: { label: 'Open API keys', href: 'https://console.twilio.com/us1/account/keys-credentials/api-keys' },
      },
      {
        text: 'Go to Phone Numbers › Manage › TwiML apps › Create new TwiML app. Name it “Tenor CRM”, paste the “TwiML app Voice URL” shown on this card into Voice › Request URL, save, then copy the app’s SID (starts with AP).',
        link: { label: 'Open TwiML apps', href: 'https://console.twilio.com/us1/develop/phone-numbers/manage/twiml-apps' },
      },
      {
        text: 'Go to Phone Numbers › Manage › Active numbers, open each number the CRM uses, and paste the “A call comes in” and “A message comes in” addresses from this card. Save.',
        link: { label: 'Open active numbers', href: 'https://console.twilio.com/us1/develop/phone-numbers/manage/incoming' },
      },
      { text: 'Back here, press Add on each value, paste it, then Test and save. Twilio checks the keys before anything is saved.' },
    ],
    where: {
      TWILIO_ACCOUNT_SID: 'Twilio Console home › Account Info › Account SID.',
      TWILIO_AUTH_TOKEN: 'Twilio Console home › Account Info › Auth Token (press Show).',
      TWILIO_API_KEY_SID: 'Account › API keys & tokens › your key › SID (SK…).',
      TWILIO_API_KEY_SECRET: 'Shown once when the API key is created. If it was lost, create a new key.',
      TWILIO_TWIML_APP_SID: 'Phone Numbers › Manage › TwiML apps › your app › SID (AP…).',
    },
    links: [
      { label: 'Twilio Console', href: 'https://console.twilio.com/' },
      { label: 'About API keys', href: 'https://www.twilio.com/docs/iam/api-keys' },
      { label: 'Texting rules (A2P 10DLC)', href: 'https://www.twilio.com/docs/messaging/compliance/a2p-10dlc' },
    ],
    notes: [
      'Sending texts also needs the number registered for A2P 10DLC (or toll-free verification) in Twilio. Receiving works without it.',
      'Switching Twilio off stops calls and texts in the CRM. Keys stay saved.',
    ],
  },

  microsoft: {
    summary: 'Outlook mailboxes in the Email module, plus Calendar and Chat. Each person signs in with their own Microsoft account.',
    who: 'A Microsoft 365 global admin, or someone allowed to register apps in Microsoft Entra.',
    steps: [
      {
        text: 'Sign in to the Azure portal and open Microsoft Entra ID › App registrations › New registration.',
        link: { label: 'Open App registrations', href: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade' },
      },
      { text: 'Name it “Tenor CRM”. Under Supported account types pick “Accounts in any organizational directory” if people outside your company will connect, otherwise “this organizational directory only”.' },
      { text: 'Under Redirect URI choose Web and paste the Redirect URI shown on this card. Register.' },
      { text: 'On the app’s Overview page copy the Application (client) ID and the Directory (tenant) ID.' },
      {
        text: 'Open Certificates & secrets › Client secrets › New client secret. Pick an expiry, add it, and copy the Value column straight away (not the Secret ID). Note the expiry date.',
        link: { label: 'How to add a secret', href: 'https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials' },
      },
      { text: `Open API permissions › Add a permission › Microsoft Graph › Delegated permissions and add: ${MS_PERMISSIONS}, plus offline_access. Then press “Grant admin consent”.` },
      { text: 'Back here, add the client ID, the secret value, the tenant ID and the expiry date, then Test and save.' },
    ],
    where: {
      MAIL_CLIENT_ID: 'Azure › App registrations › your app › Overview › Application (client) ID.',
      MAIL_CLIENT_SECRET: 'Certificates & secrets › Client secrets › the Value column, copied when the secret is created.',
      ALERT_MAIL_TENANT_ID: 'Azure › App registrations › your app › Overview › Directory (tenant) ID.',
      MAIL_CLIENT_SECRET_EXPIRES_AT: 'Certificates & secrets › Client secrets › Expires column.',
      MAIL_ALLOWED_TENANT_IDS: 'The Directory (tenant) ID of each company allowed to connect. Leave empty to allow any work account.',
    },
    links: [
      { label: 'Azure App registrations', href: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade' },
      { label: 'Register an app (Microsoft guide)', href: 'https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app' },
    ],
    notes: [
      'A client secret expires. Make a new one before the date and replace it here; the CRM warns admins ahead of time.',
      'Switching Microsoft 365 off hides Email, Calendar and Chat. Alert email keeps working if it borrows this app.',
    ],
  },

  signwell: {
    summary: 'Sending agreements for e-signature.',
    who: 'Whoever owns the company’s SignWell account.',
    steps: [
      { text: 'Sign in to SignWell.', link: { label: 'Open SignWell', href: 'https://www.signwell.com/' } },
      { text: 'Open Settings › API and create an API key. Copy it.', link: { label: 'SignWell API guide', href: 'https://developers.signwell.com/' } },
      { text: 'Back here, add the API key and press Test and save.' },
      { text: 'Press “Connect this site”. It registers this site with SignWell for signing events and fills in the Webhook ID for you.' },
      { text: 'Leave Test mode on while trying it out: test documents are free and not legally binding. Turn it off to send real agreements.' },
    ],
    where: {
      SIGNWELL_API_KEY: 'SignWell › Settings › API › your API key.',
      SIGNWELL_WEBHOOK_ID: 'Filled in by “Connect this site”. You don’t need to look for it.',
      SIGNWELL_TEST_MODE: 'A setting of this CRM, not of SignWell.',
    },
    links: [
      { label: 'SignWell', href: 'https://www.signwell.com/' },
      { label: 'SignWell API docs', href: 'https://developers.signwell.com/' },
    ],
    notes: [
      'To keep signers from getting a copy of the signed agreement, send agreements from a CRM mailbox (Presets › Sending inbox), not “SignWell’s own email”.',
      'Switching SignWell off stops new agreements going out. Keys stay saved.',
    ],
  },

  alerts: {
    summary: 'Sign-in codes, voicemail alerts and other messages the CRM sends by itself.',
    who: 'A Microsoft 365 admin.',
    steps: [
      { text: 'Enter the From line: the mailbox alerts come from, for example Tenor Payments <No-Reply@tenorpayments.com>. The mailbox must exist in Microsoft 365.' },
      { text: 'Option A, through Microsoft 365: fill in the Microsoft 365 card above (client ID, secret, tenant ID). The app also needs the Mail.Send application permission with admin consent in Azure › API permissions.' },
      {
        text: 'Option B, through SMTP: turn on Authenticated SMTP for the sending mailbox in the Microsoft 365 admin center (Users › Active users › the mailbox › Mail › Manage email apps). Then enter smtp.office365.com, port 587, the mailbox address and its password.',
        link: { label: 'Microsoft: SMTP sending', href: 'https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/authenticated-client-smtp-submission' },
      },
      { text: 'Press Test and save, then “Send me a test alert” to confirm a message really arrives.' },
    ],
    where: {
      EMAIL_FROM: 'Any mailbox your Microsoft 365 has, written as Name <address>.',
      ALERT_MAIL_CLIENT_ID: 'Only if alerts use a separate Azure app: its Overview › Application (client) ID.',
      ALERT_MAIL_CLIENT_SECRET: 'Only if alerts use a separate Azure app: its Certificates & secrets › Value.',
      SMTP_HOST: 'For Microsoft 365: smtp.office365.com.',
      SMTP_PORT: 'For Microsoft 365: 587.',
      SMTP_USER: 'The sending mailbox’s full address.',
      SMTP_PASSWORD: 'That mailbox’s password (or an app password if it uses multi-factor sign-in).',
    },
    links: [
      { label: 'Microsoft 365 admin center', href: 'https://admin.microsoft.com/' },
      { label: 'Microsoft: SMTP sending', href: 'https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/authenticated-client-smtp-submission' },
    ],
    notes: ['Alert email has no off switch: sign-in codes go out through it, so turning it off would lock everyone out.'],
  },

  maverick: {
    summary: 'Sending applications to Maverick, their status, Reporting, statements and support tickets.',
    who: 'Your Maverick Payments account manager, or whoever has admin access to the Maverick dashboard.',
    steps: [
      { text: 'Sign in to the Maverick Payments dashboard with an admin account.', link: { label: 'Maverick Payments', href: 'https://www.maverickpayments.com/' } },
      { text: 'Open the API or Developer section and create an API key for “Tenor CRM”. If there is no such section, ask your Maverick account manager to issue API credentials for your ISO.' },
      { text: 'Copy the API key, and the secret if Maverick shows one. If they gave you a separate address (for example a sandbox), copy that too.' },
      { text: 'Back here, add them and press Test and save.' },
    ],
    where: {
      MAVERICK_API_KEY: 'Maverick dashboard › API / Developer settings, or from your Maverick account manager.',
      MAVERICK_API_SECRET: 'Shown with the API key, when Maverick issues one.',
      MAVERICK_API_URL: 'Only if Maverick gave you a specific address. Leave empty otherwise.',
    },
    links: [{ label: 'Maverick Payments', href: 'https://www.maverickpayments.com/' }],
    notes: [
      'The connection itself is switched on once Maverick’s API documentation is in. Saving the key now means nothing else is needed then.',
      'Never paste a dashboard password here. Only API keys.',
    ],
  },
};
