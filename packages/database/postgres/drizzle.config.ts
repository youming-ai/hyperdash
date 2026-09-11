import { defineConfig } from 'drizzle-kit';

// Migrations connect DIRECTLY to Postgres (DATABASE_URL), never through Hyperdrive.
// `schema.ts` re-exports `auth-schema.ts`, so both business and Better Auth tables
// are covered by this single entry.
export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/hyperdash',
  },
  strict: true,
});
