import logger from '../utils/logger';
import type { RedisClient } from './redis';

// ponytail: localCache bound 30s, per-tag invalidation only. Warm/pattern APIs removed — add when measured need appears.

export interface CacheOptions {
  ttl?: number;
  tags?: string[];
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  keys: number;
  memory: string;
}

export class HyperDashCache {
  private redis: RedisClient;
  private localCache = new Map<string, { value: unknown; expiry: number }>();
  private stats = { hits: 0, misses: 0 };

  constructor(redis: RedisClient) {
    this.redis = redis;
    this.startCleanupInterval();
  }

  // ---- generic ops (single source; callers build their own keys) ----

  async get<T>(key: string): Promise<T | null> {
    try {
      const local = this.localCache.get(key);
      if (local && local.expiry > Date.now()) {
        this.stats.hits++;
        return local.value as T;
      }
      const value = await this.redis.get(key);
      if (value) {
        const parsed = JSON.parse(value) as T;
        this.localCache.set(key, { value: parsed, expiry: Date.now() + 30_000 });
        this.stats.hits++;
        return parsed;
      }
      this.stats.misses++;
      return null;
    } catch (error) {
      logger.error(`Cache GET error for key ${key}:`, error as Error);
      this.stats.misses++;
      return null;
    }
  }

  async set<T>(key: string, value: T, options: CacheOptions = {}): Promise<void> {
    try {
      const { ttl = 300, tags = [] } = options;
      const serialized = JSON.stringify(value);
      await this.redis.set(key, serialized, ttl);
      const localTtl = Math.min(ttl, 30);
      this.localCache.set(key, { value, expiry: Date.now() + localTtl * 1000 });
      if (tags.length > 0) {
        const pipeline = this.redis.createPipeline();
        for (const tag of tags) {
          pipeline.sadd(`tag:${tag}`, key);
          pipeline.expire(`tag:${tag}`, ttl);
        }
        await pipeline.exec();
      }
      logger.debug(`Cache SET: ${key} (TTL: ${ttl}s, Tags: ${tags.join(', ')})`);
    } catch (error) {
      logger.error(`Cache SET error for key ${key}:`, error as Error);
      throw error;
    }
  }

  async del(key: string): Promise<number> {
    try {
      this.localCache.delete(key);
      return await this.redis.del(key);
    } catch (error) {
      logger.error(`Cache DEL error for key ${key}:`, error as Error);
      return 0;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const local = this.localCache.get(key);
      if (local && local.expiry > Date.now()) return true;
      return await this.redis.exists(key);
    } catch (error) {
      logger.error(`Cache EXISTS error for key ${key}:`, error as Error);
      return false;
    }
  }

  async invalidateByTag(tag: string): Promise<number> {
    try {
      const keys = await this.redis.smembers(`tag:${tag}`);
      if (keys.length === 0) return 0;
      for (const key of keys) this.localCache.delete(key);
      const pipeline = this.redis.createPipeline();
      for (const key of keys) pipeline.del(key);
      pipeline.del(`tag:${tag}`);
      const results = await pipeline.exec();
      const deletedCount =
        results
          ?.slice(0, -1)
          .reduce((acc, [err, count]) => acc + (err ? 0 : (count as number)), 0) || 0;
      logger.info(`Invalidated ${deletedCount} keys for tag: ${tag}`);
      return deletedCount;
    } catch (error) {
      logger.error(`Cache invalidation error for tag ${tag}:`, error as Error);
      return 0;
    }
  }

  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses;
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: total > 0 ? this.stats.hits / total : 0,
      keys: this.localCache.size,
      memory: `${this.localCache.size} items in memory`,
    };
  }

  private startCleanupInterval(): void {
    setInterval(() => this.cleanupLocalCache(), 60_000);
  }

  private cleanupLocalCache(): void {
    const now = Date.now();
    for (const [key, value] of this.localCache.entries()) {
      if (value.expiry <= now) this.localCache.delete(key);
    }
  }

  async clearLocalCache(): Promise<void> {
    this.localCache.clear();
    logger.info('Local cache cleared');
  }

  async clearAll(): Promise<void> {
    try {
      this.localCache.clear();
      await this.redis.flushdb();
      logger.info('All cache cleared');
    } catch (error) {
      logger.error('Error clearing cache:', error as Error);
      throw error;
    }
  }

  async getOrSet<T>(
    key: string,
    fetcher: () => Promise<T>,
    options: CacheOptions = {},
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;
    const value = await fetcher();
    await this.set(key, value, options);
    return value;
  }

  async mget<T>(keys: string[]): Promise<(T | null)[]> {
    return Promise.all(keys.map((k) => this.get<T>(k)));
  }

  async mset<T>(entries: Array<{ key: string; value: T; options?: CacheOptions }>): Promise<void> {
    const pipeline = this.redis.createPipeline();
    for (const entry of entries) {
      const ttl = entry.options?.ttl ?? 300;
      pipeline.setex(entry.key, ttl, JSON.stringify(entry.value));
      this.localCache.set(entry.key, {
        value: entry.value,
        expiry: Date.now() + Math.min(ttl, 30) * 1000,
      });
    }
    await pipeline.exec();
  }
}
