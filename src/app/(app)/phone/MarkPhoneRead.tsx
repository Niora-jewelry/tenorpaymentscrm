'use client';

/**
 * Opening the Phone page is "I've looked at my calls": the missed-call,
 * voicemail and recording alerts counted on the sidebar's Phone item are
 * marked read, and the count clears. Renders nothing.
 */
import { useEffect } from 'react';
import { markAllReadAction } from '../actions';
import { announceNotificationsChanged } from '../useLiveCounts';

export function MarkPhoneRead() {
  useEffect(() => {
    void markAllReadAction({ scope: 'phone' }).then((r) => {
      if (r.changed > 0) announceNotificationsChanged();
    });
  }, []);
  return null;
}
