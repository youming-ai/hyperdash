/**
 * Copy Queue — BE → Go execution plane.
 *
 * Workers has no TCP/Redis client, so the BE publishes `CopySignal` through a
 * Cloudflare Queue binding (`COPY_QUEUE`) when present; the Go engine consumes
 * `copy:signals` from Redis via its own consumer (`internal/queue/consumer.go`).
 * Without the binding the publish is a no-op — strategy CRUD still succeeds.
 */

export interface CopySignal {
  strategyId: string;
  userId: string;
  traderId: string;
  action: 'create' | 'update' | 'delete';
  timestamp: number;
}

interface QueueBinding {
  send: (msg: unknown) => Promise<void>;
}

export async function publishCopySignals(
  env: Record<string, unknown>,
  signals: CopySignal[],
): Promise<boolean> {
  const binding = env.COPY_QUEUE as QueueBinding | undefined;
  if (!binding) return false;
  await Promise.all(signals.map((signal) => binding.send(signal)));
  return true;
}
