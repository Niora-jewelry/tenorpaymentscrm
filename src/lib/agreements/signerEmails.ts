/**
 * The words of the emails the CRM sends signers when an agreement goes through
 * Outlook. Pure: no database, no network, so every line can be tested.
 *
 * Everything from the record or the sender is escaped: a merchant called
 * `<b>Joe's</b>` prints as those characters, never as markup.
 */
export type EmailAbout = { what: string; merchant: string; sentAt: string; expiresAt: string };

/** SignWell's own schedule, kept when the CRM sends the reminders: days after sending. */
export const REMINDER_DAYS = [3, 6, 10];

/** Is the next automatic reminder due? `sent` counts the automatic ones this signer has had. */
export function reminderDue(sentAt: string, sent: number, now: Date): boolean {
  const day = REMINDER_DAYS[sent];
  return day !== undefined && now.getTime() >= new Date(sentAt).getTime() + day * 86400_000;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const firstName = (name: string) => name.trim().split(/\s+/)[0] || 'there';
const longDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;">${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function button(href: string, label: string): string {
  return `<p style="margin:20px 0 18px;"><a href="${esc(href)}" style="display:inline-block;background:#102347;color:#ffffff;font-weight:700;text-decoration:none;padding:11px 20px;border-radius:8px;">${esc(label)}</a></p>`;
}

const fine = (text: string) => `<p style="margin:0 0 14px;color:#6b7280;font-size:12px;">${esc(text)}</p>`;
const personal = (until: string | null) => `This link is personal to you. Please don’t forward it.${until ? ` It works until ${longDate(until)}.` : ''}`;

/** The first email: the sender's own words, this signer's name in them, and their link. */
export function inviteHtml(message: string, signer: { name: string }, link: string, expiresAt: string): string {
  const words = message.replace(/\{\{\s*signer_name\s*\}\}/g, firstName(signer.name));
  return paragraphs(words) + button(link, 'Review and sign') + fine(personal(expiresAt));
}

export function reminderHtml(a: EmailAbout, signer: { name: string }, link: string): string {
  return (
    paragraphs(`Hi ${firstName(signer.name)},\n\nA quick reminder: the ${a.what} for ${a.merchant} is still waiting for your signature. Everything is filled in already; you only need to sign and date where marked.`) +
    button(link, 'Review and sign') +
    fine(personal(a.expiresAt))
  );
}

/** No link: it no longer works, and a withdrawn agreement has nothing to click. */
export function withdrawnHtml(a: EmailAbout, signer: { name: string }): string {
  return paragraphs(
    `Hi ${firstName(signer.name)},\n\nThe ${a.what} for ${a.merchant} that we sent on ${longDate(a.sentAt)} has been withdrawn, and its signing link no longer works. You don’t need to do anything.\n\nIf an updated version is needed, it will come in a separate email.`,
  );
}

export function completedHtml(a: EmailAbout, signer: { name: string }, link: string, copyDays: number): string {
  return (
    paragraphs(`Hi ${firstName(signer.name)},\n\nEveryone has signed the ${a.what} for ${a.merchant}. Thank you.\n\nYou can download your signed copy from your link for the next ${copyDays} days.`) +
    button(link, 'Download your signed copy') +
    fine(personal(null))
  );
}
