/**
 * The Buy Rate Template exactly as the Nov 3, 2026 specs give it.
 *
 * Card section: "Acquiring Reconciliation Tab", Buy Rate Template build.
 * ACH section: "Maverick ACH Reconciliation Tab", Buy Rate Template.
 * Percentages are fractions ("0.0002" is 0.02%); the No Risk dashes are 0.
 */
import type { AchTemplate, CardTemplate, TemplateRow } from '../types';

const row = (no_risk: string, low_risk: string, moderate_risk: string, high_risk: string): TemplateRow => ({
  no_risk,
  low_risk,
  moderate_risk,
  high_risk,
});
const flat = (v: string) => row(v, v, v, v);

export const CARD_TEMPLATE: CardTemplate = {
  pciFee: row('0.00', '5.00', '5.00', '5.00'),
  vmdBin: row('0', '0.0002', '0.0002', '0.0020'),
  vmdAuthFee: row('0.00', '0.02', '0.03', '0.05'),
  avsFee: row('0.01', '0.01', '0.02', '0.04'),
  monthlyFee: row('0.00', '4.00', '4.00', '7.00'),
  amexOptBlue: row('0.0010', '0.0010', '0.0015', '0.0020'),
  monthlyOnlineAccessFee: row('0.00', '6.50', '8.00', '12.50'),
  batchFee: row('0.00', '0.01', '0.025', '0.04'),
  websiteMonitoringFee: flat('15.00'),
  irsAnnualFee: flat('1.95'),
  chargeback: row('10.00', '15.00', '20.00', '25.00'),
  percentage: row('0.90', '0.90', '0.80', '0.70'),
  iposSpinFeeMonthly: flat('4.00'),
  ipospaysTerminalMonthly: flat('10.00'),
  acceptBlueMonthly: flat('10.00'),
  acceptBlueSetup: flat('49.99'),
  acceptBluePerItem: flat('0.05'),
  ebtAuthFee: flat('0.02'),
  nuvolinq10mbData: flat('5.00'),
  usaEpayGold: flat('20.00'),
  usaEpaySilver: flat('15.00'),
  valorPortalAccess: flat('4.95'),
  valorTerminalAddOns: flat('10.00'),
};

const ach = (low_risk: string, moderate_risk: string, high_risk: string) => ({ low_risk, moderate_risk, high_risk });

export const ACH_TEMPLATE: AchTemplate = {
  transaction: ach('0.10', '0.15', '0.25'),
  achReturn: ach('0.75', '0.75', '0.75'),
  monthly: ach('7.50', '7.50', '7.50'),
  odfiSponsorship: ach('0', '0', '0.0015'),
  debitUnauthorizedFee: ach('5.00', '5.00', '5.00'),
  noc: ach('0.00', '0.00', '0.00'),
};
