'use client';

/**
 * What an Email or Phone value does when clicked inside a record (UI spec §4):
 *
 *   * Email → a new message to that address in the Email module;
 *   * Phone → a call from the CRM's own phone line (Twilio), so it is logged
 *     on the record like any other call;
 *   * Text  → this record's Communication tab, Phone → Texts.
 *
 * The field registry cannot import either module (it is shared with the
 * prototype), so the drawer hands them in through context.
 */
import { useMemo, type ReactNode } from 'react';
import { FieldLinksProvider, type FieldLinks } from '@/proto/ui/fieldLinks';
import { usePhone } from '../phone/PhoneProvider';

export function DrawerFieldLinks({
  moduleSlug,
  recordId,
  children,
}: {
  moduleSlug: string;
  recordId: string;
  children: ReactNode;
}) {
  const { dial } = usePhone();
  const links = useMemo<FieldLinks>(
    () => ({
      emailHref: (address) => `/email?to=${encodeURIComponent(address)}`,
      call: (number) => void dial(number),
      textHref: () =>
        `/${moduleSlug}?record=${encodeURIComponent(recordId)}&tab=communication&subtab=phone&view=texts`,
    }),
    [dial, moduleSlug, recordId],
  );
  return <FieldLinksProvider value={links}>{children}</FieldLinksProvider>;
}
