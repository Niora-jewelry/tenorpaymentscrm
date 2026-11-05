/**
 * The one place the CRM talks to a processor. Maverick first; another processor
 * is another adapter behind the same interface (spec: "built so other processors
 * can be added later").
 *
 * The reading side is written from Maverick's published documentation
 * (`maverickApi.ts`), but no real response has been seen: their firewall has
 * stopped every request so far. Until one has, every call answers
 * `ProcessorNotReady`, which the screens and the daily sync turn into a plain
 * sentence. Once Test in Integrations says Maverick accepted the key, compare one
 * real response against the mappings and set ADAPTER_READY to true.
 */
import 'server-only';
import { integrationValues, maverickReadyFrom } from '@/lib/integrations/resolve';
import { maverickApi } from './maverickApi';
import { ProcessorNotReady, type ProcessorVendor } from './vendorTypes';

export * from './vendorTypes';

export const PROCESSOR = 'maverick';

/**
 * False until a real Maverick response has been checked. While false the daily
 * sync stays idle (no failed run, no alert every morning) and Send to Maverick
 * explains why nothing was sent.
 */
export const ADAPTER_READY = false;
export const PROCESSOR_LABEL = 'Maverick';

const notYet = (): never => {
  throw new ProcessorNotReady('The Maverick connection isn’t switched on yet: Maverick’s firewall is still stopping API requests. Nothing was sent.');
};

/** What the CRM uses while ADAPTER_READY is false: no call leaves the building. */
const switchedOff: ProcessorVendor = {
  merchants: async () => notYet(),
  transactions: async () => notYet(),
  batches: async () => notYet(),
  payouts: async () => notYet(),
  ach: async () => notYet(),
  statements: async () => notYet(),
  tickets: async () => notYet(),
  applicationStatus: async () => notYet(),
  sendApplication: async () => notYet(),
};

/** The adapter, when the key is entered and the service is switched on in Integrations. */
export async function processorVendor(): Promise<ProcessorVendor> {
  const values = await integrationValues();
  if (!maverickReadyFrom(values)) {
    throw new ProcessorNotReady('Maverick is not connected. A super admin enters the Maverick API key in CRM Settings › Integrations.');
  }
  if (!ADAPTER_READY) return switchedOff;
  return maverickApi({ apiKey: values.MAVERICK_API_KEY!, baseUrl: values.MAVERICK_API_URL });
}

export async function processorConnected(): Promise<boolean> {
  return maverickReadyFrom(await integrationValues());
}
