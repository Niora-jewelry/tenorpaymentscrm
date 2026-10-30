/**
 * The e-sign service the CRM talks to. One place decides which; everything
 * else sees the `ESignVendor` interface.
 */
import 'server-only';
import { agreementsConfigured, serverEnv, signwellTestMode } from '@/lib/env.server';
import { SignWell } from './signwell';
import type { ESignVendor } from './types';

export { agreementsConfigured, signwellTestMode };

let instance: ESignVendor | null = null;

export function vendor(): ESignVendor {
  if (!agreementsConfigured) throw new Error('The signing service is not configured (SIGNWELL_API_KEY, SIGNWELL_WEBHOOK_ID).');
  if (!instance) instance = new SignWell(serverEnv.SIGNWELL_API_KEY!, serverEnv.SIGNWELL_WEBHOOK_ID!);
  return instance;
}
