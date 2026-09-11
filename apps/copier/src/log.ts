/** Minimal leveled logger — no dependency, structured context. */

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = ORDER.info;

export function setLogLevel(level: Level): void {
  threshold = ORDER[level];
}

function emit(level: Level, message: string, context?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const stamp = new Date().toISOString();
  const ctx = context && Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : '';
  const line = `[${stamp}] ${level.toUpperCase().padEnd(5)} ${message}${ctx}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (m: string, c?: Record<string, unknown>) => emit('debug', m, c),
  info: (m: string, c?: Record<string, unknown>) => emit('info', m, c),
  warn: (m: string, c?: Record<string, unknown>) => emit('warn', m, c),
  error: (m: string, c?: Record<string, unknown>) => emit('error', m, c),
};
