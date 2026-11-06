/**
 * The SQL residual calculator: a thin adapter over the Postgres functions in
 * migration 20260819009917_residual_calc_engine.sql. All arithmetic happens
 * in the database; money comes back as text.
 */
import type { ResidualCalcEngine } from '../types';

/** Anything that can run one parameterised query: a pg Client or Pool. */
export type Queryable = { query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

export function sqlEngine(db: Queryable): ResidualCalcEngine {
  const call = async <T>(fn: string, input: unknown): Promise<T> => {
    const { rows } = await db.query(`select ${fn}($1::jsonb) as out`, [JSON.stringify(input)]);
    return rows[0].out as T;
  };
  return {
    acquiring: (input) => call('residual_calc_acquiring', input),
    ach: (input) => call('residual_calc_ach', input),
    acceptBlue: (input) => call('residual_calc_accept_blue', input),
  };
}
