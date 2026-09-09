/**
 * Test stub for the `server-only` package.
 *
 * In the app, importing `server-only` from client code is a build error — that
 * is the guard keeping the service-role key out of browser bundles. Under
 * Vitest there is no client/server split, so it resolves to this no-op.
 */
export {};
