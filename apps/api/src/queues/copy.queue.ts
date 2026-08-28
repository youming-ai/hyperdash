/**
 * Copy Queue — BE → Go execution plane.
 * Skill: Long-running jobs → Queues/Workflows.
 * BE produces `CopySignal` on strategy create/update; Go consumes.
 */

export interface CopySignal {
  strategyId: string;
  userId: string;
  traderId: string;
  action: 'create' | 'update' | 'delete';
  timestamp: number;
}

export interface CopyQueue {
  publish(signal: CopySignal): Promise<void>;
}

export class NoopCopyQueue implements CopyQueue {
  async publish(_signal: CopySignal): Promise<void> {}
}

/** Cloudflare Queue producer */
export class CloudflareCopyQueue implements CopyQueue {
  constructor(private readonly binding: { send: (msg: unknown) => Promise<void> }) {}
  async publish(signal: CopySignal): Promise<void> {
    await this.binding.send(signal);
  }
}

/** Redis Streams fallback (local dev) */
export class RedisCopyQueue implements CopyQueue {
  constructor(
    private readonly redis: {
      xAdd: (key: string, id: string, fields: Record<string, string>) => Promise<unknown>;
    },
  ) {}
  async publish(signal: CopySignal): Promise<void> {
    await this.redis.xAdd('copy:signals', '*', { data: JSON.stringify(signal) });
  }
}

export function createCopyQueue(
  env: Record<string, unknown>,
  redis?: { xAdd: (k: string, id: string, f: Record<string, string>) => Promise<unknown> },
): CopyQueue {
  const binding = env.COPY_QUEUE as { send: (msg: unknown) => Promise<void> } | undefined;
  if (binding) return new CloudflareCopyQueue(binding);
  if (redis) return new RedisCopyQueue(redis);
  return new NoopCopyQueue();
}
