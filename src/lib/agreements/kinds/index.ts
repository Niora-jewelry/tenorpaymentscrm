import { maverickAch } from './maverickAch';
import { maverickMerchant } from './maverickMerchant';
import type { AgreementKindDef } from './types';

/** Every agreement kind the code knows how to fill, by key. */
export const KINDS: Record<string, AgreementKindDef> = {
  [maverickMerchant.key]: maverickMerchant,
  [maverickAch.key]: maverickAch,
};

export function kindFor(key: string): AgreementKindDef | undefined {
  return KINDS[key];
}
