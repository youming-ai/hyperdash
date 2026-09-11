/**
 * Feed Queue — high-performance decoupling for time-series persistence.
 *
 * Skill: Long-running / multi-step jobs → Cloudflare Queues / Workflows.
 * Local: Redis pipeline (existing FeedRecorder). Workers: Cloudflare Queue binding.
 *
 * This abstraction lets the same producer code run in both runtimes:
 *   - Node (api-gateway Express): `RedisFeedQueue` → `FeedRecorder` pipeline
 *   - Workers (future ingest Worker): `CloudflareQueue` → `Queue<FeedBatch>`
 */

export interface FeedBatch {
  type: 'funding' | 'price' | 'oi' | 'volume' | 'stress' | 'whaleflow';
  coin?: string;
  ts: number;
  payload: unknown;
}

export interface FeedQueue {
  send(batch: FeedBatch): Promise<void>;
  sendBatch(batches: FeedBatch[]): Promise<void>;
}

/** No-op queue for tests / when no backend configured. */
export class NoopFeedQueue implements FeedQueue {
  async send(_batch: FeedBatch): Promise<void> {}
  async sendBatch(_batches: FeedBatch[]): Promise<void> {}
}

/** Redis-backed queue — retains current FeedRecorder pipeline semantics. */
export class RedisFeedQueue implements FeedQueue {
  constructor(private readonly recorder: { enqueue(batch: FeedBatch): void }) {}

  async send(batch: FeedBatch): Promise<void> {
    this.recorder.enqueue(batch);
  }

  async sendBatch(batches: FeedBatch[]): Promise<void> {
    for (const b of batches) this.recorder.enqueue(b);
  }
}

/**
 * Cloudflare Queue producer (Workers runtime).
 * Bind in wrangler.toml:
 *   [[queues.producers]] queue="feed-batches" binding="FEED_QUEUE"
 * Usage: env.FEED_QUEUE.send(batch)
 */
export class CloudflareFeedQueue implements FeedQueue {
  constructor(
    private readonly binding: {
      send: (msg: unknown) => Promise<void>;
      sendBatch: (msgs: unknown[]) => Promise<void>;
    },
  ) {}

  async send(batch: FeedBatch): Promise<void> {
    await this.binding.send(batch);
  }

  async sendBatch(batches: FeedBatch[]): Promise<void> {
    await this.binding.sendBatch(batches.map((b) => ({ body: b })));
  }
}

export function createFeedQueue(env: Record<string, unknown>, fallback: FeedQueue): FeedQueue {
  const binding = env.FEED_QUEUE as
    | { send: (msg: unknown) => Promise<void>; sendBatch: (msgs: unknown[]) => Promise<void> }
    | undefined;
  if (binding && typeof binding.send === 'function') {
    return new CloudflareFeedQueue(binding);
  }
  return fallback;
}
