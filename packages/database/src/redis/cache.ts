import { getRedisConnection, type Redis } from './client';

export interface CacheOptions {
  ttl?: number; // Time to live in seconds
  tags?: string[]; // Cache tags for invalidation
  compress?: boolean; // Compress large values
}

export interface CacheResult<T> {
  hit: boolean;
  value: T | null;
  ttl?: number;
}

export class CacheManager {
  private redis: Redis;
  private defaultTTL: number;

  constructor(defaultTTL: number = 300) {
    this.redis = getRedisConnection();
    this.defaultTTL = defaultTTL;
  }

  // Set a value in cache
  async set<T>(key: string, value: T, options: CacheOptions = {}): Promise<void> {
    const { ttl = this.defaultTTL, tags = [], compress = false } = options;

    try {
      const serializedValue = JSON.stringify(value);
      const cacheValue = compress ? this.compress(serializedValue) : serializedValue;

      // Store with TTL
      await this.redis.getIORedisClient().setex(key, ttl, cacheValue);

      // Add to tag sets for invalidation
      if (tags.length > 0) {
        for (const tag of tags) {
          await this.redis.getIORedisClient().sadd(`tag:${tag}`, key);
          await this.redis.getIORedisClient().expire(`tag:${tag}`, ttl);
        }
      }

      console.log(`✅ Cached key: ${key} (TTL: ${ttl}s, Tags: [${tags.join(', ')}])`);
    } catch (error) {
      console.error(`❌ Failed to cache key ${key}:`, error);
      throw error;
    }
  }

  // Get a value from cache
  async get<T>(key: string): Promise<CacheResult<T>> {
    try {
      const cached = await this.redis.getIORedisClient().get(key);

      if (cached === null) {
        return { hit: false, value: null };
      }

      // Try to decompress if needed
      const decompressed = this.tryDecompress(cached);
      const value = JSON.parse(decompressed) as T;

      // Get remaining TTL
      const ttl = await this.redis.getIORedisClient().ttl(key);

      return { hit: true, value, ttl: ttl > 0 ? ttl : undefined };
    } catch (error) {
      console.error(`❌ Failed to get cached key ${key}:`, error);
      return { hit: false, value: null };
    }
  }

  // Delete a key from cache
  async del(key: string): Promise<void> {
    try {
      await this.redis.getIORedisClient().del(key);
      console.log(`🗑️ Deleted cache key: ${key}`);
    } catch (error) {
      console.error(`❌ Failed to delete cache key ${key}:`, error);
      throw error;
    }
  }

  // Invalidate cache by tags
  async invalidateByTag(tag: string): Promise<void> {
    try {
      const tagKey = `tag:${tag}`;
      const keys = await this.redis.getIORedisClient().smembers(tagKey);

      if (keys.length > 0) {
        await this.redis.getIORedisClient().del(...keys);
        await this.redis.getIORedisClient().del(tagKey);
        console.log(`🗑️ Invalidated ${keys.length} keys for tag: ${tag}`);
      }
    } catch (error) {
      console.error(`❌ Failed to invalidate tag ${tag}:`, error);
      throw error;
    }
  }

  // Increment a numeric value
  async incr(key: string, amount: number = 1, ttl?: number): Promise<number> {
    try {
      const result = await this.redis.getIORedisClient().incrby(key, amount);

      if (ttl) {
        await this.redis.getIORedisClient().expire(key, ttl);
      }

      return result;
    } catch (error) {
      console.error(`❌ Failed to increment key ${key}:`, error);
      throw error;
    }
  }

  // Decrement a numeric value
  async decr(key: string, amount: number = 1, ttl?: number): Promise<number> {
    try {
      const result = await this.redis.getIORedisClient().decrby(key, amount);

      if (ttl) {
        await this.redis.getIORedisClient().expire(key, ttl);
      }

      return result;
    } catch (error) {
      console.error(`❌ Failed to decrement key ${key}:`, error);
      throw error;
    }
  }

  // Set if not exists (useful for locking)
  async setIfNotExists<T>(key: string, value: T, ttl: number): Promise<boolean> {
    try {
      const serializedValue = JSON.stringify(value);
      const result = await this.redis.getIORedisClient().set(key, serializedValue, 'EX', ttl, 'NX');

      return result === 'OK';
    } catch (error) {
      console.error(`❌ Failed to set key if not exists ${key}:`, error);
      throw error;
    }
  }

  // Get or set pattern (useful for memoization)
  async getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    options: CacheOptions = {},
  ): Promise<T> {
    // Try to get from cache first
    const cached = await this.get<T>(key);
    if (cached.hit && cached.value !== null) {
      return cached.value;
    }

    // Generate value
    const value = await factory();

    // Set in cache
    await this.set(key, value, options);

    return value;
  }

  // Batch operations
  async mget<T>(keys: string[]): Promise<Record<string, CacheResult<T>>> {
    try {
      const values = await this.redis.getIORedisClient().mget(...keys);
      const result: Record<string, CacheResult<T>> = {};

      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const value = values[i];

        if (value === null) {
          result[key] = { hit: false, value: null };
        } else {
          try {
            const decompressed = this.tryDecompress(value);
            const parsed = JSON.parse(decompressed) as T;
            result[key] = { hit: true, value: parsed };
          } catch {
            result[key] = { hit: false, value: null };
          }
        }
      }

      return result;
    } catch (error) {
      console.error('❌ Failed to get multiple keys:', error);
      throw error;
    }
  }

  // Clear all cache (dangerous!)
  async flushAll(): Promise<void> {
    try {
      await this.redis.getIORedisClient().flushall();
      console.log('🧹 Flushed all cache');
    } catch (error) {
      console.error('❌ Failed to flush cache:', error);
      throw error;
    }
  }

  // Get cache statistics
  async getStats(): Promise<{
    keys: number;
    memory: string;
    hits: number;
    misses: number;
    hitRate: string;
  }> {
    try {
      const info = await this.redis.getInfo();
      const keys = parseInt(info.db0?.split(',')[0]?.split('=')[1] || '0', 10);
      const memory = info.used_memory_human || '0B';

      // These would need to be tracked separately in a real implementation
      const hits = 0;
      const misses = 0;
      const hitRate = hits + misses > 0 ? `${((hits / (hits + misses)) * 100).toFixed(2)}%` : '0%';

      return { keys, memory, hits, misses, hitRate };
    } catch (error) {
      console.error('❌ Failed to get cache stats:', error);
      throw error;
    }
  }

  // Simple compression (placeholder - use real compression in production)
  private compress(data: string): string {
    // In production, use gzip or brotli
    return Buffer.from(data).toString('base64');
  }

  // Simple decompression
  private tryDecompress(data: string): string {
    try {
      // Try to decompress
      return Buffer.from(data, 'base64').toString();
    } catch {
      // Return original if decompression fails
      return data;
    }
  }
}

// Cache factory for different TTL strategies
export class CacheFactory {
  private static instances = new Map<string, CacheManager>();

  static getInstance(ttl: number = 300): CacheManager {
    const key = `ttl:${ttl}`;

    if (!CacheFactory.instances.has(key)) {
      CacheFactory.instances.set(key, new CacheManager(ttl));
    }

    const instance = CacheFactory.instances.get(key);
    if (!instance) throw new Error(`Cache instance not found: ${key}`);
    return instance;
  }

  static getShortLivedCache(): CacheManager {
    return CacheFactory.getInstance(60); // 1 minute
  }

  static getMediumLivedCache(): CacheManager {
    return CacheFactory.getInstance(300); // 5 minutes
  }

  static getLongLivedCache(): CacheManager {
    return CacheFactory.getInstance(3600); // 1 hour
  }
}

// Decorator for memoizing functions
export function Memoize(
  options: CacheOptions & { keyGenerator?: (...args: any[]) => string } = {},
) {
  return (target: any, propertyName: string, descriptor: PropertyDescriptor) => {
    const method = descriptor.value;
    const cache = CacheFactory.getMediumLivedCache();
    const { keyGenerator, ...cacheOptions } = options;

    descriptor.value = async function (...args: any[]) {
      const key = keyGenerator
        ? keyGenerator(...args)
        : `${target.constructor.name}:${propertyName}:${JSON.stringify(args)}`;

      return cache.getOrSet(key, () => method.apply(this, args), cacheOptions);
    };

    return descriptor;
  };
}

export { CacheManager as Cache };
