import type { Swatch } from '@/proto/schema';
import type { ProposalStatus } from '@/lib/proposals/service';

export const PROPOSAL_STATUS: Record<ProposalStatus, { label: string; swatch: Swatch }> = {
  sent: { label: 'Sent', swatch: 'blue' },
  viewed: { label: 'Viewed', swatch: 'indigo' },
  approved: { label: 'Approved', swatch: 'green' },
  expired: { label: 'Expired', swatch: 'slate' },
  voided: { label: 'Voided', swatch: 'red' },
};
