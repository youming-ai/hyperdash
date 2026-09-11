import logger from '../utils/logger';
import type { RedisClient } from './redis';

export interface CacheOptions {
  ttl?: number;
  tags?: string[];
  compress?: boolean;
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
  private localCache = new Map<string, { value: any; expiry: number }>();
  private stats = { hits: 0, misses: 0 };

  constructor(redis: RedisClient) {
    this.redis = redis;
    this.startCleanupInterval();
  }

  // Market data caching
  async getMarketData(symbol: string, interval: string): Promise<any | null> {
    const key = `market:${symbol}:${interval}`;
    return this.get(key);
  }

  async setMarketData(symbol: string, interval: string, data: any, ttl = 60): Promise<void> {
    const key = `market:${symbol}:${interval}`;
    await this.set(key, data, { ttl, tags: ['market', symbol, interval] });
  }

  // Trader data caching
  async getTraderProfile(traderId: string): Promise<any | null> {
    const key = `trader:profile:${traderId}`;
    return this.get(key);
  }

  async setTraderProfile(traderId: string, profile: any, ttl = 300): Promise<void> {
    const key = `trader:profile:${traderId}`;
    await this.set(key, profile, { ttl, tags: ['trader', 'profile'] });
  }

  async getTraderRankings(limit = 100): Promise<any[] | null> {
    const key = `trader:rankings:${limit}`;
    return this.get(key);
  }

  async setTraderRankings(rankings: any[], limit = 100, ttl = 600): Promise<void> {
    const key = `trader:rankings:${limit}`;
    await this.set(key, rankings, { ttl, tags: ['trader', 'rankings'] });
  }

  // Position data caching
  async getUserPositions(userId: string): Promise<any[] | null> {
    const key = `user:positions:${userId}`;
    return this.get(key);
  }

  async setUserPositions(userId: string, positions: any[], ttl = 30): Promise<void> {
    const key = `user:positions:${userId}`;
    await this.set(key, positions, { ttl, tags: ['user', 'positions', userId] });
  }

  async getTraderPositions(traderId: string): Promise<any[] | null> {
    const key = `trader:positions:${traderId}`;
    return this.get(key);
  }

  async setTraderPositions(traderId: string, positions: any[], ttl = 60): Promise<void> {
    const key = `trader:positions:${traderId}`;
    await this.set(key, positions, { ttl, tags: ['trader', 'positions', traderId] });
  }

  // Copy trading cache
  async getCopyRelationships(userId: string): Promise<any[] | null> {
    const key = `copy:relationships:${userId}`;
    return this.get(key);
  }

  async setCopyRelationships(userId: string, relationships: any[], ttl = 300): Promise<void> {
    const key = `copy:relationships:${userId}`;
    await this.set(key, relationships, { ttl, tags: ['copy', 'relationships', userId] });
  }

  async getCopyPerformance(userId: string, period = '7d'): Promise<any | null> {
    const key = `copy:performance:${userId}:${period}`;
    return this.get(key);
  }

  async setCopyPerformance(
    userId: string,
    performance: any,
    period = '7d',
    ttl = 600,
  ): Promise<void> {
    const key = `copy:performance:${userId}:${period}`;
    await this.set(key, performance, { ttl, tags: ['copy', 'performance', userId] });
  }

  // Analytics cache
  async getAnalyticsData(metric: string, timeframe: string): Promise<any | null> {
    const key = `analytics:${metric}:${timeframe}`;
    return this.get(key);
  }

  async setAnalyticsData(metric: string, timeframe: string, data: any, ttl = 300): Promise<void> {
    const key = `analytics:${metric}:${timeframe}`;
    await this.set(key, data, { ttl, tags: ['analytics', metric, timeframe] });
  }

  // Alert cache
  async getUserAlerts(userId: string): Promise<any[] | null> {
    const key = `alerts:${userId}`;
    return this.get(key);
  }

  async setUserAlerts(userId: string, alerts: any[], ttl = 120): Promise<void> {
    const key = `alerts:${userId}`;
    await this.set(key, alerts, { ttl, tags: ['alerts', userId] });
  }

  // Session cache
  async getUserSession(userId: string): Promise<any | null> {
    const key = `session:${userId}`;
    return this.get(key);
  }

  async setUserSession(userId: string, session: any, ttl = 86400): Promise<void> {
    const key = `session:${userId}`;
    await this.set(key, session, { ttl, tags: ['session', userId] });
  }

  async invalidateUserSession(userId: string): Promise<void> {
    const key = `session:${userId}`;
    await this.del(key);
  }

  // Generic cache operations
  async get<T = any>(key: string): Promise<T | null> {
    try {
      // Try local cache first
      const local = this.localCache.get(key);
      if (local && local.expiry > Date.now()) {
        this.stats.hits++;
        return local.value;
      }

      // Try Redis
      const value = await this.redis.get(key);
      if (value) {
        const parsed = JSON.parse(value);
        // Store in local cache with 30 second TTL
        this.localCache.set(key, {
          value: parsed,
          expiry: Date.now() + 30000,
        });
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

  async set<T = any>(key: string, value: T, options: CacheOptions = {}): Promise<void> {
    try {
      const { ttl = 300, tags = [] } = options;
      const serialized = JSON.stringify(value);

      // Store in Redis
      await this.redis.set(key, serialized, ttl);

      // Store in local cache
      const localTtl = Math.min(ttl, 30); // Max 30 seconds in local cache
      this.localCache.set(key, {
        value,
        expiry: Date.now() + localTtl * 1000,
      });

      // Add to tag sets for invalidation
      if (tags.length > 0) {
        const pipeline = this.redis.createPipeline();
        for (const tag of tags) {
          pipeline.sadd(`tag:${tag}`, key);
          pipeline.expire(`tag:${tag}`, ttl || 300);
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
      // Remove from local cache
      this.localCache.delete(key);

      // Remove from Redis
      return await this.redis.del(key);
    } catch (error) {
      logger.error(`Cache DEL error for key ${key}:`, error as Error);
      return 0;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      // Check local cache first
      const local = this.localCache.get(key);
      if (local && local.expiry > Date.now()) {
        return true;
      }

      // Check Redis
      return await this.redis.exists(key);
    } catch (error) {
      logger.error(`Cache EXISTS error for key ${key}:`, error as Error);
      return false;
    }
  }

  // Tag-based invalidation
  async invalidateByTag(tag: string): Promise<number> {
    try {
      const keys = await this.redis.smembers(`tag:${tag}`);
      if (keys.length === 0) {
        return 0;
      }

      // Remove from local cache
      for (const key of keys) {
        this.localCache.delete(key);
      }

      // Remove from Redis
      const pipeline = this.redis.createPipeline();
      for (const key of keys) {
        pipeline.del(key);
      }
      pipeline.del(`tag:${tag}`);
      const results = await pipeline.exec();

      const deletedCount =
        results?.slice(0, -1).reduce((acc, [err, count]) => {
          return acc + (err ? 0 : (count as number));
        }, 0) || 0;

      logger.info(`Invalidated ${deletedCount} keys for tag: ${tag}`);
      return deletedCount;
    } catch (error) {
      logger.error(`Cache invalidation error for tag ${tag}:`, error as Error);
      return 0;
    }
  }

  async invalidateByPattern(pattern: string): Promise<number> {
    try {
      const keys = await this.redis.getClient().keys(`*${pattern}*`);
      if (keys.length === 0) {
        return 0;
      }

      // Remove from local cache
      for (const key of keys) {
        this.localCache.delete(key);
      }

      // Remove from Redis
      return await this.redis.getClient().del(...keys);
    } catch (error) {
      logger.error(`Cache pattern invalidation error for pattern ${pattern}:`, error as Error);
      return 0;
    }
  }

  // Cache warming and preloading
  async warmMarketData(symbols: string[], intervals: string[]): Promise<void> {
    logger.info(`Warming market data cache for ${symbols.length} symbols`);

    for (const symbol of symbols) {
      for (const interval of intervals) {
        try {
          const key = `market:${symbol}:${interval}`;
          const exists = await this.exists(key);
          if (!exists) {
            // This would trigger actual market data fetching
            logger.debug(`Pre-warming cache for ${key}`);
          }
        } catch (error) {
          logger.error(`Error warming cache for ${symbol}:${interval}:`, error as Error);
        }
      }
    }
  }

  async warmTraderRankings(): Promise<void> {
    try {
      const key = 'trader:rankings:100';
      const exists = await this.exists(key);
      if (!exists) {
        logger.debug('Pre-warming trader rankings cache');
      }
    } catch (error) {
      logger.error('Error warming trader rankings cache:', error as Error);
    }
  }

  // Cache statistics
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

  async getRedisStats(): Promise<any> {
    try {
      const info = await this.redis.info('memory');
      const keyspace = await this.redis.info('keyspace');
      const dbsize = await this.redis.dbsize();

      return {
        keys: dbsize,
        memory: info,
        keyspace: keyspace,
      };
    } catch (error) {
      logger.error('Error getting Redis stats:', error as Error);
      return null;
    }
  }

  // Cache maintenance
  private startCleanupInterval(): void {
    setInterval(() => {
      this.cleanupLocalCache();
    }, 60000); // Cleanup every minute
  }

  private cleanupLocalCache(): void {
    const now = Date.now();
    for (const [key, value] of this.localCache.entries()) {
      if (value.expiry <= now) {
        this.localCache.delete(key);
      }
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

  // Advanced cache operations
  async getOrSet<T = any>(
    key: string,
    fetcher: () => Promise<T>,
    options: CacheOptions = {},
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    try {
      const value = await fetcher();
      await this.set(key, value, options);
      return value;
    } catch (error) {
      logger.error(`Error in getOrSet for key ${key}:`, error as Error);
      throw error;
    }
  }

  async mget<T = any>(keys: string[]): Promise<(T | null)[]> {
    const results: (T | null)[] = [];

    for (const key of keys) {
      results.push(await this.get<T>(key));
    }

    return results;
  }

  async mset<T = any>(
    entries: Array<{ key: string; value: T; options?: CacheOptions }>,
  ): Promise<void> {
    const pipeline = this.redis.createPipeline();

    for (const entry of entries) {
      const serialized = JSON.stringify(entry.value);
      const ttl = entry.options?.ttl || 300;

      pipeline.setex(entry.key, ttl, serialized);

      // Store in local cache too
      this.localCache.set(entry.key, {
        value: entry.value,
        expiry: Date.now() + Math.min(ttl, 30) * 1000,
      });
    }

    await pipeline.exec();
  }
}
