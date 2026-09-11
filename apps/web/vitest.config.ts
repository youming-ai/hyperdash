import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Workers integration tests only (need HYPERDRIVE/KV bindings via workerd).
    // Unit tests run under `bun test` (see `test` script); keep vitest for
    // `test:workers`. Pool 0.22 + Vitest 4 runner mismatch currently blocks
    // workerd, so no files match until integration tests land.
    pool: '@cloudflare/vitest-pool-workers',
    include: ['src/**/*.workers.test.ts'],
    exclude: ['node_modules', 'dist', '.wrangler'],
  },
});
