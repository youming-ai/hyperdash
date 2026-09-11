import Redis from 'ioredis';
import { createClient } from 'redis';

export interface RedisConfig {
  host?: string;
  port?: number;
  password?: string;
  database?: number;
  maxRetries?: number;
  retryDelayOnFailover?: number;
  lazyConnect?: boolean;
  keyPrefix?: string;
  ttl?: number; // Default TTL in seconds
}

export class RedisConnection {
  private redis: Redis | null = null;
  private redisV4: ReturnType<typeof createClient> | null = null;
  private isInitialized = false;
  private config: RedisConfig;

  constructor(config: RedisConfig = {}) {
    this.config = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      database: parseInt(process.env.REDIS_DB || '0', 10),
      maxRetries: 3,
      retryDelayOnFailover: 100,
      lazyConnect: true,
      keyPrefix: process.env.REDIS_KEY_PREFIX || 'hyperdash:',
      ttl: parseInt(process.env.REDIS_DEFAULT_TTL || '300', 10), // 5 minutes default
      ...config,
    };
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      console.log('Initializing Redis connections...');

      // Initialize ioredis (v5) for advanced features
      this.redis = new Redis({
        host: this.config.host,
        port: this.config.port,
        password: this.config.password,
        db: this.config.database,
        maxRetriesPerRequest: this.config.maxRetries,
        lazyConnect: this.config.lazyConnect,
        keyPrefix: this.config.keyPrefix,
        // Connection settings
        connectTimeout: 10000,
        commandTimeout: 5000,
        // Performance settings
        enableOfflineQueue: false,
        // Cluster settings (if needed in future)
        enableReadyCheck: true,
        // Event handlers
        reconnectOnError: (err) => {
          const targetError = 'READONLY';
          return err.message.includes(targetError);
        },
      });

      // Initialize redis v4 client for compatibility
      this.redisV4 = createClient({
        socket: {
          host: this.config.host,
          port: this.config.port,
        },
        password: this.config.password,
        database: this.config.database,
      });

      // Event handlers for ioredis
      this.redis.on('connect', () => {
        console.log('✅ Redis (ioredis) connected');
      });

      this.redis.on('ready', () => {
        console.log('✅ Redis (ioredis) ready');
      });

      this.redis.on('error', (error) => {
        console.error('❌ Redis (ioredis) error:', error);
      });

      this.redis.on('close', () => {
        console.log('🔌 Redis (ioredis) connection closed');
      });

      this.redis.on('reconnecting', () => {
        console.log('🔄 Redis (ioredis) reconnecting...');
      });

      // Event handlers for redis v4
      this.redisV4.on('error', (error) => {
        console.error('❌ Redis (v4) error:', error);
      });

      this.redisV4.on('connect', () => {
        console.log('✅ Redis (v4) connected');
      });

      // Connect to Redis
      await this.redis.connect();
      await this.redisV4.connect();

      // Test the connection
      await this.redis.ping();
      await this.redisV4.ping();

      console.log('✅ Redis connections established successfully');
      this.isInitialized = true;
    } catch (error) {
      console.error('❌ Failed to initialize Redis connections:', error);
      throw new Error(
        `Redis connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  // Get ioredis client (for advanced features)
  getIORedisClient(): Redis {
    if (!this.redis || !this.isInitialized) {
      throw new Error('Redis (ioredis) not initialized. Call initialize() first.');
    }
    return this.redis;
  }

  // Get redis v4 client (for compatibility)
  getRedisV4Client(): ReturnType<typeof createClient> {
    if (!this.redisV4 || !this.isInitialized) {
      throw new Error('Redis (v4) not initialized. Call initialize() first.');
    }
    return this.redisV4;
  }

  async healthCheck(): Promise<{
    status: 'healthy' | 'unhealthy';
    latency?: number;
    error?: string;
  }> {
    try {
      if (!this.redis || !this.redisV4) {
        return { status: 'unhealthy', error: 'Redis clients not initialized' };
      }

      const startTime = Date.now();
      await this.redis.ping();
      const latency = Date.now() - startTime;

      return { status: 'healthy', latency };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async close(): Promise<void> {
    try {
      if (this.redis) {
        await this.redis.disconnect();
        this.redis = null;
      }
      if (this.redisV4) {
        await this.redisV4.quit();
        this.redisV4 = null;
      }
      this.isInitialized = false;
      console.log('✅ Redis connections closed');
    } catch (error) {
      console.error('❌ Error closing Redis connections:', error);
      throw error;
    }
  }

  // Get Redis info
  async getInfo(): Promise<any> {
    if (!this.redis) {
      throw new Error('Redis not initialized');
    }

    try {
      const info = await this.redis.info();
      return this.parseRedisInfo(info);
    } catch (error) {
      console.error('❌ Failed to get Redis info:', error);
      throw error;
    }
  }

  // Get memory usage
  async getMemoryUsage(): Promise<{
    used: number;
    peak: number;
    overhead: number;
    readable: {
      used: string;
      peak: string;
      overhead: string;
    };
  }> {
    if (!this.redis) {
      throw new Error('Redis not initialized');
    }

    try {
      const info = await this.redis.info('memory');
      const parsed = this.parseRedisInfo(info);

      const used = parseInt(parsed.used_memory || '0', 10);
      const peak = parseInt(parsed.used_memory_peak || '0', 10);
      const overhead = parseInt(parsed.mem_fragmentation_ratio || '0', 10);

      return {
        used,
        peak,
        overhead,
        readable: {
          used: this.formatBytes(used),
          peak: this.formatBytes(peak),
          overhead: overhead.toString(),
        },
      };
    } catch (error) {
      console.error('❌ Failed to get Redis memory usage:', error);
      throw error;
    }
  }

  private parseRedisInfo(info: string): Record<string, string> {
    const lines = info.split('\r\n');
    const result: Record<string, string> = {};

    for (const line of lines) {
      if (line && !line.startsWith('#')) {
        const [key, ...values] = line.split(':');
        if (key && values.length > 0) {
          result[key] = values.join(':');
        }
      }
    }

    return result;
  }

  private formatBytes(bytes: number): string {
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 Bytes';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${Math.round((bytes / 1024 ** i) * 100) / 100} ${sizes[i]}`;
  }
}

// Singleton instance
let redisInstance: RedisConnection | null = null;

export function createRedisConnection(config?: RedisConfig): RedisConnection {
  if (!redisInstance) {
    redisInstance = new RedisConnection(config);
  }
  return redisInstance;
}

export function getRedisConnection(): RedisConnection {
  if (!redisInstance) {
    throw new Error('Redis connection not initialized. Call createRedisConnection() first.');
  }
  return redisInstance;
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Received SIGINT, closing Redis connections...');
  if (redisInstance) {
    await redisInstance.close();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, closing Redis connections...');
  if (redisInstance) {
    await redisInstance.close();
  }
  process.exit(0);
});

export { RedisConnection as Redis };
