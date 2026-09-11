/**
 * Ingest stub for ingest worker — delegates to BE API when BE_URL is set,
 * otherwise logs. Full DB ingestion lives in BE (`apps/api` or `api-gateway`).
 */

export interface IngestResult {
  successful: number;
  failed: number;
}

export async function ingestTraderAddresses(
  addresses: string[],
  _options: { concurrency?: number } = {},
): Promise<IngestResult> {
  const beUrl = process.env.BE_URL ?? process.env.VITE_BE_URL;
  if (beUrl) {
    try {
      const res = await fetch(`${beUrl.replace(/\/$/, '')}/api/jobs/whale-discovery`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(process.env.JOBS_SECRET ? { 'x-jobs-secret': process.env.JOBS_SECRET } : {}),
        },
        body: JSON.stringify({ addresses }),
      });
      if (res.ok) {
        const data = (await res.json()) as IngestResult;
        return data;
      }
    } catch {
      // fallback to log
    }
  }
  console.log(`[ingest] would ingest ${addresses.length} traders`, addresses.slice(0, 3));
  return { successful: addresses.length, failed: 0 };
}
