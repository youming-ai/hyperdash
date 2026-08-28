// Workers Observability — console is the log sink, `wrangler tail` streams it.
// No pino/hono-pino on Workers (V8 isolate, not Node). Keep API compatible
// with existing `logger.info/warn/error/debug` call sites.
export const logger = {
  debug: (...args: unknown[]) => console.debug(...args),
  info: (...args: unknown[]) => console.log(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};
