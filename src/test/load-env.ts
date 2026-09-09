/**
 * Loads the project's env files for tests, in Next's own precedence order.
 *
 * The header here used to say "unit tests do not need it". That is no longer
 * true, and the way it stopped being true is worth knowing: `lib/env.ts`
 * validates `NEXT_PUBLIC_*` at **import** time and throws when they are
 * missing, so any unit test that transitively imports a Supabase client
 * (`config.ts`, `permissions.ts`, `preferences.ts` and everything importing
 * those) fails during collection — reported as "0 test" and a failed suite,
 * never as a missing-env problem. Only `.env.local` was loaded, so a checkout
 * carrying `.env` instead saw five suites fail for reasons that looked
 * unrelated to env.
 *
 * Precedence, matching how Next itself resolves these: real shell environment
 * wins, then `.env.local`, then `.env`. That ordering is load-bearing —
 * `process.loadEnvFile()` does NOT overwrite a variable that is already set,
 * so the file loaded FIRST wins, and the more specific file has to go first.
 *
 * The integration suites still gate themselves on `SUPABASE_DB_URL` and skip
 * when it is absent, so this stays runnable offline.
 */
import { existsSync } from 'node:fs';

// Node 22 built-in; no dotenv dependency needed.
for (const file of ['.env.local', '.env']) {
  if (existsSync(file)) process.loadEnvFile(file);
}
