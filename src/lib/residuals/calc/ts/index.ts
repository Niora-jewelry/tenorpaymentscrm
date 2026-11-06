/**
 * The TypeScript residual calculator. Pure: no database, no I/O.
 */
import type { ResidualCalcEngine } from '../types';
import { reconcileAcceptBlue } from './acceptBlue';
import { reconcileAch } from './ach';
import { reconcileAcquiring } from './acquiring';

export const tsEngine: ResidualCalcEngine = {
  acquiring: async (input) => reconcileAcquiring(input),
  ach: async (input) => reconcileAch(input),
  acceptBlue: async (input) => reconcileAcceptBlue(input),
};
