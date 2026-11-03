import { describe, expect, it } from 'vitest';
import { buildProposal, hasSavingsFigures, money, posRows } from './content';

const at = new Date(Date.UTC(2026, 10, 3));

describe('the proposal (client\'s "Proposal items" sheet)', () => {
  const values = {
    legal_business_name: 'ZZ Acme Holdings LLC',
    prior_monthly_volume: '50000', prior_effective_rate: 2.95, tenor_effective_rate: '2.1',
    prior_monthly_transactions: 1200, prior_auth_fees: '0.15', tenor_auth_fees: 0.08,
    prior_monthly_fees: '89.95', tenor_monthly_fees: 25,
  };
  const p = buildProposal(values, { dealName: 'ZZ Acme', relationshipManagerEmail: null, preparedOn: at });

  it('works each row out as the sheet does', () => {
    const [eff, tx, monthly] = p.savings.rows;
    // B2*C2, B2*E2, D2-F2
    expect(eff).toMatchObject({ item: 'Effective Rate', volume: 50000, currentCost: 1475, proposedCost: 1050, savings: 425 });
    // B3*C3, B3*E3, D3-F3
    expect(tx).toMatchObject({ item: 'Transaction Fees', volume: 1200, currentCost: 180, proposedCost: 96, savings: 84 });
    // D4, F4, D4-F4
    expect(monthly).toMatchObject({ item: 'Monthly Fees', volume: null, currentCost: 89.95, proposedCost: 25, savings: 64.95 });
  });

  it('totals, then monthly, annual (×12) and 3-year (×36) savings', () => {
    expect(p.savings.totals).toEqual({ currentCost: 1744.95, proposedCost: 1171, savings: 573.95 });
    expect(p.savings.monthly).toBe(573.95);
    expect(p.savings.annual).toBe(6887.4);
    expect(p.savings.threeYear).toBe(20662.2);
  });

  it('names the merchant by the Legal business name, and the closing email falls back to sales', () => {
    expect(p.merchantName).toBe('ZZ Acme Holdings LLC');
    expect(p.closing.email).toBe('sales@tenorpayments.com');
    expect(buildProposal({}, { dealName: 'ZZ Deal', relationshipManagerEmail: 'rm@tenorpayments.com', preparedOn: at })).toMatchObject({
      merchantName: 'ZZ Deal',
      closing: { email: 'rm@tenorpayments.com' },
    });
  });

  it('uses the standard words when no Savings description is written', () => {
    expect(p.savings.description).toMatch(/^The savings outlined in this analysis/);
    expect(buildProposal({ savings_description: 'Our own words.' }, { dealName: 'x', relationshipManagerEmail: null, preparedOn: at }).savings.description).toBe('Our own words.');
  });

  it('includes POS Architecture only when ticked and something is filled in', () => {
    const base = { pos_description: 'Clover Station Duo', merchant_requirements: [{ Requirement: 'Kiosk', Check: 'Yes' }, { Requirement: 'Gift cards', Check: '' }], tenor_features: [{ Feature: 'Phone ID', Check: 'Yes' }] };
    expect(buildProposal(base, { dealName: 'x', relationshipManagerEmail: null, preparedOn: at }).pos).toBeNull();
    const on = buildProposal({ ...base, pos_in_proposal: true }, { dealName: 'x', relationshipManagerEmail: null, preparedOn: at }).pos;
    expect(on).toEqual({
      description: 'Clover Station Duo',
      requirements: [{ text: 'Kiosk', check: true }, { text: 'Gift cards', check: false }],
      features: [{ text: 'Phone ID', check: true }],
    });
    expect(buildProposal({ pos_in_proposal: true }, { dealName: 'x', relationshipManagerEmail: null, preparedOn: at }).pos).toBeNull();
  });

  it('Detailed POS lists the rows ticked In proposal: Amount × Monthly fee', () => {
    const mdr = [
      { Provider: 'Clover', Item: 'Station Duo', Amount: '2', 'Monthly fee': '32.16', 'Per item fee': '10', 'One time fee': '99', 'In proposal': 'Yes' },
      { Provider: 'Comcast', Item: 'Internet', Amount: '1', 'Monthly fee': '80', 'In proposal': '' },
      { Provider: 'Clover', Item: 'Mini', 'Monthly fee': '0.30', 'In proposal': 'Yes' },
    ];
    expect(posRows(mdr)).toEqual([
      { product: 'Station Duo', amount: 2, hardwareCost: 10, setupFee: 99, monthlyCost: 64.32 },
      { product: 'Mini', amount: null, hardwareCost: null, setupFee: null, monthlyCost: 0.3 },
    ]);
    expect(buildProposal({ merchant_direct_relationships: mdr }, { dealName: 'x', relationshipManagerEmail: null, preparedOn: at }).detailedPos).toBeNull();
    expect(buildProposal({ merchant_direct_relationships: mdr, pos_detail_in_proposal: true }, { dealName: 'x', relationshipManagerEmail: null, preparedOn: at }).detailedPos?.rows).toHaveLength(2);
  });

  it('knows when the Savings Analysis has nothing to show', () => {
    expect(hasSavingsFigures({})).toBe(false);
    expect(hasSavingsFigures({ prior_monthly_fees: '10' })).toBe(true);
    expect(money(1234.5)).toBe('$1,234.50');
  });
});
