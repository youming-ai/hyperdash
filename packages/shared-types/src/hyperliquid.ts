import { z } from 'zod';

// ponytail: single Hyperliquid Info client — retry + timeout lives here, callers just pass {type, ...}. Add new methods as thin wrappers.

export class HyperliquidApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'HyperliquidApiError';
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveInfoUrl(raw: string): string {
  const r = raw.trim();
  return r.endsWith('/info') ? r : `${r.replace(/\/$/, '')}/info`;
}

export async function hyperliquidRequest<T>(
  infoUrl: string,
  body: Record<string, unknown>,
): Promise<T> {
  const url = resolveInfoUrl(infoUrl);
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) return (await res.json()) as T;
      if (res.status !== 429 && res.status < 500) {
        const text = await res.text().catch(() => '');
        throw new HyperliquidApiError(
          `Hyperliquid info(${String(body.type)}) failed: ${res.status} ${res.statusText}`,
          res.status,
          text,
        );
      }
      lastError = new HyperliquidApiError(
        `Hyperliquid info(${String(body.type)}) transient: ${res.status} ${res.statusText}`,
        res.status,
      );
    } catch (err) {
      clearTimeout(timeout);
      if (
        err instanceof HyperliquidApiError &&
        err.status !== undefined &&
        err.status !== 429 &&
        err.status < 500
      )
        throw err;
      lastError = err;
    }
    if (attempt < MAX_RETRIES) {
      const base = 250 * 2 ** attempt;
      const jitter = Math.floor(Math.random() * 100) - 50;
      await sleep(base + jitter);
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new HyperliquidApiError('Hyperliquid info request failed after retries');
}

// Common schemas
export const HyperliquidMetaSchema = z.object({
  universe: z.array(
    z.object({
      name: z.string(),
      szDecimals: z.number(),
      maxLeverage: z.number(),
      onlyIsolated: z.boolean().optional(),
      isDelisted: z.boolean().optional(),
    }),
  ),
});

export type HyperliquidMeta = z.infer<typeof HyperliquidMetaSchema>;

export const HyperliquidAssetCtxSchema = z.object({
  dayNtlVlm: z.string(),
  funding: z.string(),
  markPx: z.string(),
  midPx: z.string().nullable().optional(),
  openInterest: z.string(),
  oraclePx: z.string(),
  prevDayPx: z.string(),
});

export type HyperliquidAssetCtx = z.infer<typeof HyperliquidAssetCtxSchema>;
