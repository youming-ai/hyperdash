#!/usr/bin/env bun
/**
 * Deploy preflight.
 *
 * Run this before `wrangler deploy`. It catches the configuration mistakes that
 * fail silently in production rather than loudly at deploy time — the kind that
 * surface as "wallet sign-in stopped working" or "every API call is 500" long
 * after the deploy looked successful.
 *
 *   bun scripts/preflight-deploy.ts            # check both Workers
 *   bun scripts/preflight-deploy.ts web        # check one
 *
 * Exits non-zero if any blocker is found. Warnings do not fail the run.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

const PLACEHOLDER = /REPLACE_WITH_[A-Z_]+/g;

type Severity = 'blocker' | 'warning';

interface Finding {
  severity: Severity;
  file: string;
  message: string;
  fix: string;
}

interface Target {
  id: 'web' | 'api';
  path: string;
  /** Bindings whose placeholder value makes the deploy non-functional. */
  requiredIds: string[];
}

const TARGETS: Target[] = [
  {
    id: 'web',
    path: join(ROOT, 'apps/web/wrangler.toml'),
    requiredIds: ['HYPERDRIVE', 'KV'],
  },
  {
    id: 'api',
    path: join(ROOT, 'apps/api/wrangler.toml'),
    requiredIds: ['HYPERDRIVE', 'KV'],
  },
];

const findings: Finding[] = [];

function readToml(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    findings.push({
      severity: 'blocker',
      file: path.replace(`${ROOT}/`, ''),
      message: 'config file is missing',
      fix: 'restore it from git',
    });
    return '';
  }
}

/**
 * Extract `key = "value"` for a top-level key. Deliberately not a full TOML
 * parser: we only need to read a handful of scalar keys, and pulling in a
 * dependency for a preflight script would be disproportionate.
 */
function scalar(source: string, key: string): string | null {
  const match = source.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return match ? match[1] : null;
}

for (const target of TARGETS) {
  const rel = target.path.replace(`${ROOT}/`, '');
  const source = readToml(target.path);
  if (!source) continue;

  // 1. Unreplaced provisioning ids. These are the difference between a Worker
  //    that boots and one that throws on the first request touching the binding.
  const placeholders = new Set(source.match(PLACEHOLDER) ?? []);
  for (const placeholder of placeholders) {
    findings.push({
      severity: 'blocker',
      file: rel,
      message: `provisioning id is still a placeholder (${placeholder})`,
      fix: placeholder.includes('HYPERDRIVE')
        ? 'bunx wrangler hyperdrive create hyperdash-db --connection-string="postgres://…?sslmode=require"'
        : 'bunx wrangler kv namespace create KV',
    });
  }

  // 2. PUBLIC_ORIGIN drives the SIWE domain. Left at localhost, sign-in fails
  //    verification for every user while the deploy itself reports success.
  const origin = scalar(source, 'PUBLIC_ORIGIN');
  if (origin && /localhost|127\.0\.0\.1/.test(origin)) {
    findings.push({
      severity: 'blocker',
      file: rel,
      message: `PUBLIC_ORIGIN is still "${origin}"`,
      fix: 'set it to the deployed https origin (e.g. https://app.example.com)',
    });
  } else if (origin && !origin.startsWith('https://')) {
    findings.push({
      severity: 'warning',
      file: rel,
      message: `PUBLIC_ORIGIN is not https ("${origin}")`,
      fix: 'wallet providers generally refuse to sign over plain http',
    });
  }

  // 3. A VITE_* value in [vars] cannot reach the client bundle: Vite inlines
  //    import.meta.env at build time. Silently doing nothing is the worst
  //    outcome, so call it out.
  for (const key of ['VITE_BE_URL', 'VITE_PUBLIC_ORIGIN', 'VITE_WS_URL']) {
    if (scalar(source, key) !== null) {
      findings.push({
        severity: 'warning',
        file: rel,
        message: `${key} is declared in [vars] but VITE_* values are inlined at build time`,
        fix: `remove ${key} from [vars] and export it in the build environment instead`,
      });
    }
  }

  // 4. The web Worker proxies /api when BE_URL is set, and otherwise serves the
  //    API itself. Both are valid; note which mode a deploy will run in so it is
  //    a decision rather than an accident.
  if (target.id === 'web') {
    const beUrl = scalar(source, 'BE_URL');
    if (!beUrl) {
      findings.push({
        severity: 'warning',
        file: rel,
        message: 'BE_URL is empty — the web Worker will serve /api/* itself',
        fix: 'set BE_URL to the api Worker origin for the FE/BE split, or leave empty intentionally',
      });
    }
  }

  // 5. Network mismatch between the BE and the executor is rejected by the
  //    exchange at order time, which is a very late place to find out.
  if (target.id === 'api') {
    const testnet = scalar(source, 'HYPERLIQUID_TESTNET');
    if (testnet && testnet !== '0') {
      findings.push({
        severity: 'warning',
        file: rel,
        message: `HYPERLIQUID_TESTNET is "${testnet}" — ensure apps/copier matches`,
        fix: 'set the same value in the copier environment',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Cross-file consistency: ENCRYPTION_KEY must be identical in the BE and the
// executor, because one encrypts and the other decrypts.
// ---------------------------------------------------------------------------

const copierEnvExample = join(ROOT, 'apps/copier/.env.example');
try {
  const example = readFileSync(copierEnvExample, 'utf8');
  if (!/^ENCRYPTION_KEY=/m.test(example)) {
    findings.push({
      severity: 'blocker',
      file: 'apps/copier/.env.example',
      message: 'ENCRYPTION_KEY is not documented',
      fix: 'the executor cannot decrypt agent keys without it',
    });
  }
} catch {
  findings.push({
    severity: 'warning',
    file: 'apps/copier/.env.example',
    message: 'could not read the copier env template',
    fix: 'verify ENCRYPTION_KEY is documented for the executor',
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const only = process.argv[2];
const shown = only ? findings.filter((f) => f.file.includes(`apps/${only}/`)) : findings;
const blockers = shown.filter((f) => f.severity === 'blocker');
const warnings = shown.filter((f) => f.severity === 'warning');

function report(list: Finding[], label: string, symbol: string): void {
  if (list.length === 0) return;
  console.log(`\n${symbol} ${label} (${list.length})`);
  for (const f of list) {
    console.log(`\n  ${f.file}`);
    console.log(`    ${f.message}`);
    console.log(`    → ${f.fix}`);
  }
}

console.log('Deploy preflight');
report(blockers, 'BLOCKERS — deploy will not work', '✖');
report(warnings, 'WARNINGS — review before deploying', '!');

if (blockers.length === 0) {
  console.log(`\n✔ no blockers found${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
  process.exit(0);
}

console.log(`\n✖ ${blockers.length} blocker(s) must be fixed before deploying`);
process.exit(1);
