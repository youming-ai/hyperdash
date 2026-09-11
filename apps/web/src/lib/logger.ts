import pino from 'pino';

// Level is read from the `LOG_LEVEL` var when present; `process.env` is empty on
// Workers, so this falls back to `info`. Inspect logs with `wrangler tail`.
export const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
