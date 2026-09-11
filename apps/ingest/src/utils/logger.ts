export function getLogger() {
  return {
    debug: (msg: string, ...args: unknown[]) => console.debug(`[ingest] ${msg}`, ...args),
    info: (msg: string, ...args: unknown[]) => console.log(`[ingest] ${msg}`, ...args),
    warn: (msg: string, ...args: unknown[]) => console.warn(`[ingest] ${msg}`, ...args),
    error: (msg: string, ...args: unknown[]) => console.error(`[ingest] ${msg}`, ...args),
  };
}
