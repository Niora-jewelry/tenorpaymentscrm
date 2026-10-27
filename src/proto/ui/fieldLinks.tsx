'use client';

/**
 * What clicking an Email or Phone value does.
 *
 * UI spec §4: Email is "click to compose", Phone is "click to call/text". The
 * field registry is shared with the prototype, which has no mail module and no
 * softphone, so it cannot import either. The app provides real actions here
 * (the Email composer, the Twilio dialer, the record's Texts view); without a
 * provider the plain `mailto:` / `tel:` / `sms:` links still do the right thing
 * on any device.
 */
import { createContext, useContext, type ReactNode } from 'react';

export type FieldLinks = {
  /** Where an email address opens a new message to it. */
  emailHref: (address: string) => string;
  /** Places a call from inside the CRM. Absent → a `tel:` link. */
  call?: (number: string) => void;
  /** Where "Text" goes for a number. Absent → an `sms:` link. */
  textHref?: (number: string) => string;
};

const DEFAULT_LINKS: FieldLinks = { emailHref: (a) => `mailto:${a}` };

const FieldLinksContext = createContext<FieldLinks>(DEFAULT_LINKS);

export function FieldLinksProvider({ value, children }: { value: FieldLinks; children: ReactNode }) {
  return <FieldLinksContext.Provider value={value}>{children}</FieldLinksContext.Provider>;
}

export function useFieldLinks(): FieldLinks {
  return useContext(FieldLinksContext);
}

/** "+15551234567" / "5551234567" → "(555) 123-4567"; anything else unchanged. */
export function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  if (ten.length !== 10) return raw;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

/** A website as typed ("acme.com") → something a browser can open. */
export function websiteHref(raw: string): string {
  const v = raw.trim();
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(v: string): boolean {
  return EMAIL_PATTERN.test(v.trim());
}
