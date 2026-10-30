import { maverickMerchant } from './maverickMerchant';
import type { AgreementKindDef } from './types';

/** Every agreement kind the code knows how to fill, by key. */
export const KINDS: Record<string, AgreementKindDef> = {
  [maverickMerchant.key]: maverickMerchant,
};

export function kindFor(key: string): AgreementKindDef | undefined {
  return KINDS[key];
}
