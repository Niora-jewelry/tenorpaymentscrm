import { describe, it, expect } from 'vitest';
import { zipNames } from './zipNames';

describe('zipNames', () => {
  it('keeps names, numbers duplicates (case-insensitively), strips path tricks', () => {
    expect(zipNames(['a.pdf', 'A.pdf', 'a.pdf', '../../etc/passwd', 'x:y*z?.txt', '', '...hidden', 'README'])).toEqual([
      'a.pdf', 'A (2).pdf', 'a (3).pdf', '__.._etc_passwd', 'x_y_z_.txt', 'attachment', '_hidden', 'README',
    ]);
  });
});
