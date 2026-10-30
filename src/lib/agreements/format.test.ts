import { describe, expect, it } from 'vitest';
import { addressLine, ein, equipmentList, money, percent, phone, ssn, streetLine, usDate, winAnsi, yearsSince, yesNo } from './format';

describe('agreement formatting (spec §6)', () => {
  it('money: two decimals, no symbol', () => {
    expect(money('$1,234.5')).toBe('1234.50');
    expect(money(0)).toBe('0.00');
    expect(money('')).toBe('');
    expect(money('abc')).toBe('');
  });
  it('percent: the number only', () => {
    expect(percent('2.95%')).toBe('2.95');
    expect(percent(0.1)).toBe('0.1');
    expect(percent('0')).toBe('0');
  });
  it('dates as MM/DD/YYYY', () => {
    expect(usDate('2019-11-15')).toBe('11/15/2019');
    expect(usDate('')).toBe('');
  });
  it('years in business: full years, rounded down, under a year is 0', () => {
    const sent = new Date(Date.UTC(2026, 9, 27));
    expect(yearsSince('2019-11-15', sent)).toBe('6');
    expect(yearsSince('2019-10-27', sent)).toBe('7');
    expect(yearsSince('2026-03-01', sent)).toBe('0');
    expect(yearsSince('', sent)).toBe('');
  });
  it('SSN and EIN', () => {
    expect(ssn('123456789')).toBe('123-45-6789');
    expect(ssn('123-45-6789')).toBe('123-45-6789');
    expect(ein('123456789')).toBe('12-3456789');
    expect(ein('12-3456789')).toBe('12-3456789');
  });
  it('phone', () => {
    expect(phone('5125550100')).toBe('(512) 555-0100');
    expect(phone('+1 512 555 0100')).toBe('(512) 555-0100');
    expect(phone('ext 44')).toBe('ext 44');
  });
  it('address boxes', () => {
    const a = { street: '12 Main St', street2: 'Suite 4', city: 'Austin', state: 'TX', zip: '78701' };
    expect(streetLine(a)).toBe('12 Main St, Suite 4');
    expect(addressLine(a)).toBe('12 Main St, Suite 4, Austin, TX 78701');
    expect(addressLine('')).toBe('');
  });
  it('yes / no', () => {
    expect(yesNo('yes')).toBe('Yes');
    expect(yesNo('No')).toBe('No');
    expect(yesNo('maybe')).toBe('');
  });
  it('WinAnsi: curly quotes and dashes become plain, the rest is dropped', () => {
    expect(winAnsi('Joe’s “Pizza” — café ✓')).toBe('Joe\'s "Pizza" - café ');
  });
  it('equipment: once each, in order, NA when empty', () => {
    expect(equipmentList(['Authorize.net', '', 'Clover', 'authorize.NET', 'Clover'])).toBe('Authorize.net, Clover');
    expect(equipmentList(['', undefined, null])).toBe('NA');
  });
});
