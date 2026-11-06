/**
 * The SQL engine against the shared contract. Needs a database with migration
 * 20260819009917 applied; skipped without SUPABASE_DB_URL. The functions are
 * pure (no table reads or writes), so this leaves no data behind.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe } from 'vitest';
import { runCalcContract } from '../contract';
import { sqlEngine } from './engine';

const DB_URL = process.env.SUPABASE_DB_URL;
const local = DB_URL ? /@(127\.0\.0\.1|localhost)[:/]/.test(DB_URL) : false;

describe.skipIf(!DB_URL)('SQL engine', () => {
  const db = new pg.Client({ connectionString: DB_URL, ssl: local ? false : { rejectUnauthorized: false } });
  beforeAll(() => db.connect());
  afterAll(() => db.end());

  runCalcContract('SQL engine', () => sqlEngine(db));
});
