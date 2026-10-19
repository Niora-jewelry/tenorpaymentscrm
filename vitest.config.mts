import { configDefaults, defineConfig } from 'vitest/config';
import path from 'node:path';

const root = import.meta.dirname;

export default defineConfig({
  test: {
    environment: 'node',
    /*
     * `.tsx` as well as `.ts`: the rich-text renderer for Updates (Modules
     * §3.2) is a component, and the tests that matter for it assert what it
     * renders — that a `javascript:` URL never becomes an href, and that a body
     * containing markup never becomes markup. Those have to render JSX, and
     * under a `.ts`-only pattern such a file is collected by nothing and
     * "passes" by being invisible. (The patterns live on the projects below;
     * a root-level `include` would be merged INTO each project and run the
     * integration files twice, once in parallel.)
     */
    setupFiles: ['./src/test/load-env.ts'],
    /*
     * The integration suite talks to the real Supabase project in us-west-2.
     * One round trip from here is roughly 600ms, and the signup flow makes
     * several of them plus a Have I Been Pwned lookup — comfortably past
     * Vitest's 5s default. That made `npm run verify` fail on timing rather
     * than on anything being wrong, while `npm run test:integration` passed,
     * because only the latter passed --testTimeout. Setting it here means both
     * commands behave the same. The unit tests are unaffected: they finish in
     * milliseconds, so a generous ceiling costs them nothing.
     */
    testTimeout: 60_000,
    hookTimeout: 60_000,
    /*
     * Two projects, because the integration files share ONE live database.
     * Several of them borrow the same real rows inside rolled-back
     * transactions (the oldest records, the test accounts' profiles); run in
     * parallel they lock those rows in different orders and Postgres kills
     * one with "deadlock detected" — a failure about scheduling, not about
     * the code. Integration files therefore run one at a time; unit tests,
     * which touch no database, stay parallel.
     */
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          exclude: [...configDefaults.exclude, 'src/**/*.integration.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/*.integration.test.ts'],
          fileParallelism: false,
        },
      },
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(root, './src'),
      // `server-only` throws when imported outside a server context. Under test
      // there is no such context, so it is stubbed out.
      'server-only': path.resolve(root, './src/test/server-only-stub.ts'),
    },
  },
});
