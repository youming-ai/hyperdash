import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Skill: Vitest via workerd for binding tests. Pool 0.22 + Vitest 4 runner
    // mismatch currently blocks workerd; fallback to threads for pure utils
    // and keep workerd config for future integration tests that need HYPERDRIVE/KV.
    pool: 'threads',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules', 'dist', '.wrangler'],
  },
});
