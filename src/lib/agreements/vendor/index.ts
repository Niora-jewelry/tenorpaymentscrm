/**
 * The e-sign service the CRM talks to. One place decides which; everything
 * else sees the `ESignVendor` interface.
 */
import 'server-only';
import { agreementsReady, agreementsReadyFrom, integrationValues, signwellTestMode } from '@/lib/integrations/resolve';
import { SignWell } from './signwell';
import type { ESignVendor } from './types';

export { agreementsReady, signwellTestMode };

let held: { key: string; vendor: ESignVendor } | null = null;

/** The keys can be replaced in CRM Settings, so a new one gets a new client. */
export async function vendor(): Promise<ESignVendor> {
  const v = await integrationValues();
  if (!agreementsReadyFrom(v)) throw new Error('The signing service is not configured (SignWell API key and webhook ID).');
  const key = `${v.SIGNWELL_API_KEY}|${v.SIGNWELL_WEBHOOK_ID}`;
  if (held?.key !== key) held = { key, vendor: new SignWell(v.SIGNWELL_API_KEY!, v.SIGNWELL_WEBHOOK_ID!) };
  return held.vendor;
}
