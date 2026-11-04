import { describe, expect, it } from 'vitest';
import { completedHtml, firstName, inviteHtml, reminderDue, reminderHtml, withdrawnHtml } from './signerEmails';

const about = { what: 'merchant agreement', merchant: 'ZZ Pizza', sentAt: '2026-11-03T18:00:00Z', expiresAt: '2026-12-03T18:00:00Z' };
const link = 'https://crm.test/sign/abc';

describe('the reminder schedule: day 3, 6 and 10', () => {
  const sent = '2026-11-01T12:00:00Z';
  const day = (n: number, hours = 0) => new Date(new Date(sent).getTime() + n * 86400_000 + hours * 3600_000);
  it('the first is not due before day 3, and is on it', () => {
    expect(reminderDue(sent, 0, day(2, 23))).toBe(false);
    expect(reminderDue(sent, 0, day(3))).toBe(true);
  });
  it('each later one waits for its own day', () => {
    expect(reminderDue(sent, 1, day(5))).toBe(false);
    expect(reminderDue(sent, 1, day(6))).toBe(true);
    expect(reminderDue(sent, 2, day(9))).toBe(false);
    expect(reminderDue(sent, 2, day(10))).toBe(true);
  });
  it('there is no fourth, however long it waits', () => {
    expect(reminderDue(sent, 3, day(300))).toBe(false);
  });
});

describe('emails to signers', () => {
  it('each signer sees their own first name, wherever the sender put it', () => {
    const html = inviteHtml('Hi {{signer_name}},\n\nThanks {{ signer_name }}.', { name: 'Jane Q Doe' }, link, about.expiresAt);
    expect(html).toContain('Hi Jane,');
    expect(html).toContain('Thanks Jane.');
    expect(html).not.toContain('signer_name');
  });

  it('the invite carries the button, the link and the date it stops working', () => {
    const html = inviteHtml('Please sign.', { name: 'Jane Doe' }, link, about.expiresAt);
    expect(html).toContain(`href="${link}"`);
    expect(html).toContain('Review and sign');
    expect(html).toContain('December 3, 2026');
  });

  it('nothing from the sender or the record becomes markup', () => {
    const html = inviteHtml('<script>alert(1)</script>', { name: '<img src=x onerror=y>' }, link, about.expiresAt);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    const r = reminderHtml({ ...about, merchant: '<b>Joe’s</b>' }, { name: 'Jane' }, link);
    expect(r).not.toContain('<b>');
    expect(r).toContain('&lt;b&gt;');
    expect(inviteHtml('x', { name: 'J' }, 'https://crm.test/"><script>', about.expiresAt)).not.toContain('"><script>');
  });

  it('a reminder names the agreement and the merchant, and keeps the same link', () => {
    const r = reminderHtml(about, { name: 'Jane Doe' }, link);
    expect(r).toContain('merchant agreement for ZZ Pizza');
    expect(r).toContain(`href="${link}"`);
    expect(r).toContain('Hi Jane,');
  });

  it('a withdrawn notice has nothing to click', () => {
    const w = withdrawnHtml(about, { name: 'Jane Doe' });
    expect(w).toContain('withdrawn');
    expect(w).toContain('November 3, 2026');
    expect(w).not.toContain('<a ');
  });

  it('the completion note offers the signed copy for the stated days', () => {
    const c = completedHtml(about, { name: 'Jane Doe' }, link, 30);
    expect(c).toContain('Download your signed copy');
    expect(c).toContain('next 30 days');
    expect(c).toContain(`href="${link}"`);
  });

  it('a signer with no usable name is still greeted', () => {
    expect(firstName('   ')).toBe('there');
    expect(firstName('Jane Doe')).toBe('Jane');
  });
});
