/**
 * Lead fill detection.
 *
 * The industry approach is to watch the lead's fills over a websocket rather
 * than poll: polling either wastes the request budget or adds latency, and in
 * copy trading latency is a direct cost — the lead has already filled, so every
 * millisecond before our order is price the follower pays in slippage.
 *
 * We subscribe to `userFills` per lead and use the event purely as a *trigger*.
 * The fill payload is deliberately not converted into an order: it only tells
 * us "this coin changed", after which the reconciler recomputes the follower's
 * target from current state. Replaying fill-by-fill would break the moment an
 * event is missed, a fill is partial, or a user touches their account manually.
 *
 * Hyperliquid throttles subscriptions per connection (~13) and connections per
 * IP (~10), so subscriptions are capped and deduplicated; leads beyond the cap
 * are still covered by the periodic sweep.
 */

import type { SubscriptionClient } from '@nktkas/hyperliquid';
import { log } from './log';

export type LeadFillHandler = (leadAddress: string) => void | Promise<void>;

export interface LeadFeedOptions {
  /** Hard cap on concurrent per-lead subscriptions (connection limits). */
  maxSubscriptions?: number;
  /** Coalesce bursts: at most one reconcile trigger per lead per window. */
  debounceMs?: number;
}

export class LeadFeed {
  private readonly subscriptions = new Map<string, { unsubscribe: () => Promise<void> }>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly maxSubscriptions: number;
  private readonly debounceMs: number;

  constructor(
    private readonly subscription: SubscriptionClient,
    private readonly handler: LeadFillHandler,
    options: LeadFeedOptions = {},
  ) {
    this.maxSubscriptions = options.maxSubscriptions ?? 8;
    this.debounceMs = options.debounceMs ?? 500;
  }

  get subscribedCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Bring subscriptions in line with the desired lead set.
   *
   * Adding is capped; removing is unconditional so churned strategies release
   * slots immediately.
   */
  async sync(desired: `0x${string}`[]): Promise<void> {
    const wanted = new Set(desired.map((a) => a.toLowerCase()));

    for (const [address, sub] of this.subscriptions) {
      if (!wanted.has(address)) {
        try {
          await sub.unsubscribe();
        } catch (error) {
          log.warn('unsubscribe failed', {
            leadAddress: address,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        this.subscriptions.delete(address);
        log.debug('unsubscribed lead', { leadAddress: address });
      }
    }

    for (const address of wanted) {
      if (this.subscriptions.has(address)) continue;
      if (this.subscriptions.size >= this.maxSubscriptions) {
        log.warn('lead subscription cap reached; covered by sweep only', {
          leadAddress: address,
          cap: this.maxSubscriptions,
        });
        break;
      }
      await this.subscribe(address as `0x${string}`);
    }
  }

  private async subscribe(address: `0x${string}`): Promise<void> {
    try {
      const sub = await this.subscription.userFills({ user: address }, (event) => {
        // Snapshots arrive on connect; they are not new activity.
        if (event.isSnapshot) return;
        if (!event.fills || event.fills.length === 0) return;
        this.trigger(address);
      });

      this.subscriptions.set(address, {
        unsubscribe: async () => {
          await sub.unsubscribe();
        },
      });

      log.info('subscribed to lead fills', { leadAddress: address });
    } catch (error) {
      log.error('lead subscription failed', {
        leadAddress: address,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Debounced trigger.
   *
   * A lead filling five times in a second must not produce five reconciles:
   * each would read positions and place orders against a target that the next
   * event invalidates. Coalescing into one pass is both cheaper and more
   * correct, because the reconciler always converges to the latest target.
   */
  private trigger(address: string): void {
    const existing = this.pending.get(address);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.pending.delete(address);
      void Promise.resolve(this.handler(address)).catch((error) => {
        log.error('lead fill handler failed', {
          leadAddress: address,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.debounceMs);

    this.pending.set(address, timer);
  }

  async close(): Promise<void> {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();

    for (const [address, sub] of this.subscriptions) {
      try {
        await sub.unsubscribe();
      } catch {
        // Closing is best-effort.
      }
      this.subscriptions.delete(address);
    }
  }
}
