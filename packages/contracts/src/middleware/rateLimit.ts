import { TRPCError } from '@trpc/server';
import type { Context } from '../types';

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (ctx: Context) => string;
  message?: string;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
}

interface RateLimitEntry {
  count: number;
  resetTime: number;
  lastRequest: number;
}

class RateLimiter {
  private storage = new Map<string, RateLimitEntry>();
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Clean up expired entries every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000);
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.storage.entries()) {
      if (now > entry.resetTime) {
        this.storage.delete(key);
      }
    }
  }

  consume(
    key: string,
    config: RateLimitConfig,
  ): {
    allowed: boolean;
    remaining: number;
    resetTime: number;
    retryAfter?: number;
  } {
    const now = Date.now();
    const _windowStart = now - config.windowMs;

    let entry = this.storage.get(key);

    if (!entry || now > entry.resetTime) {
      // First request or window expired
      entry = {
        count: 1,
        resetTime: now + config.windowMs,
        lastRequest: now,
      };
      this.storage.set(key, entry);

      return {
        allowed: true,
        remaining: config.maxRequests - 1,
        resetTime: entry.resetTime,
      };
    }

    // Update existing entry
    entry.count++;
    entry.lastRequest = now;

    if (entry.count > config.maxRequests) {
      const retryAfter = Math.ceil((entry.resetTime - now) / 1000);

      return {
        allowed: false,
        remaining: 0,
        resetTime: entry.resetTime,
        retryAfter,
      };
    }

    return {
      allowed: true,
      remaining: config.maxRequests - entry.count,
      resetTime: entry.resetTime,
    };
  }

  // Get current status for a key
  getStatus(key: string): {
    count: number;
    remaining: number;
    resetTime: number;
  } | null {
    const entry = this.storage.get(key);
    if (!entry) {
      return null;
    }

    const now = Date.now();
    if (now > entry.resetTime) {
      this.storage.delete(key);
      return null;
    }

    return {
      count: entry.count,
      remaining: Math.max(0, 100 - entry.count), // Assuming 100 as max
      resetTime: entry.resetTime,
    };
  }

  // Reset limit for a key
  reset(key: string): void {
    this.storage.delete(key);
  }

  // Get all current entries (for monitoring)
  getAllEntries(): Array<{ key: string; entry: RateLimitEntry }> {
    const now = Date.now();
    const entries: Array<{ key: string; entry: RateLimitEntry }> = [];

    for (const [key, entry] of this.storage.entries()) {
      if (now <= entry.resetTime) {
        entries.push({ key, entry });
      }
    }

    return entries;
  }

  // Destroy the rate limiter
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.storage.clear();
  }
}

// Global rate limiter instance
const globalRateLimiter = new RateLimiter();

// Graceful shutdown
process.on('SIGINT', () => {
  globalRateLimiter.destroy();
});

process.on('SIGTERM', () => {
  globalRateLimiter.destroy();
});

export function createRateLimitMiddleware(config: RateLimitConfig) {
  const {
    // windowMs is configured but not used directly here
    maxRequests,
    keyGenerator,
    message,
    skipSuccessfulRequests = false,
    skipFailedRequests = false,
  } = config;

  return async ({ ctx, next }: { ctx: Context; next: any }) => {
    const key = keyGenerator?.(ctx) || ctx.ip || 'anonymous';
    const result = globalRateLimiter.consume(key, config);

    // Add rate limit headers to response
    if (ctx.res) {
      ctx.res.set({
        'X-RateLimit-Limit': maxRequests.toString(),
        'X-RateLimit-Remaining': result.remaining.toString(),
        'X-RateLimit-Reset': new Date(result.resetTime).toISOString(),
      });

      if (!result.allowed && result.retryAfter) {
        ctx.res.set('Retry-After', result.retryAfter.toString());
      }
    }

    if (!result.allowed) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: message || `Rate limit exceeded. Try again in ${result.retryAfter} seconds.`,
      });
    }

    try {
      const response = await next();

      // Skip counting successful requests if configured
      if (skipSuccessfulRequests) {
        globalRateLimiter.consume(key, {
          ...config,
          maxRequests: config.maxRequests + 1,
        });
      }

      return response;
    } catch (error) {
      // Skip counting failed requests if configured
      if (skipFailedRequests) {
        globalRateLimiter.consume(key, {
          ...config,
          maxRequests: config.maxRequests + 1,
        });
      }

      throw error;
    }
  };
}

// Predefined rate limit configurations
export const RateLimits = {
  // Public API endpoints
  public: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 100,
    message: 'Too many requests from this IP, please try again in 15 minutes',
  },

  // Authenticated users
  user: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 1000,
    keyGenerator: (ctx: Context) => ctx.user?.userId || ctx.ip || 'anonymous',
    message: 'Too many requests, please try again in 15 minutes',
  },

  // Trading operations (more restrictive)
  trading: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 60,
    keyGenerator: (ctx: Context) => ctx.user?.userId || ctx.ip || 'anonymous',
    message: 'Too many trading requests, please try again in 1 minute',
  },

  // Sensitive operations (very restrictive)
  sensitive: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 5,
    keyGenerator: (ctx: Context) => ctx.user?.userId || ctx.ip || 'anonymous',
    message: 'Too many sensitive operations, please try again in 1 minute',
  },

  // Authentication endpoints
  auth: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 10,
    keyGenerator: (ctx: Context) => ctx.ip || 'anonymous',
    message: 'Too many authentication attempts, please try again in 15 minutes',
    skipSuccessfulRequests: true, // Don't count successful logins
  },

  // WebSocket connections
  websocket: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 30,
    keyGenerator: (ctx: Context) => ctx.ip || 'anonymous',
    message: 'Too many WebSocket connection attempts',
  },
};

// Convenience middleware functions
export const rateLimitPublic = createRateLimitMiddleware(RateLimits.public);
export const rateLimitUser = createRateLimitMiddleware(RateLimits.user);
export const rateLimitTrading = createRateLimitMiddleware(RateLimits.trading);
export const rateLimitSensitive = createRateLimitMiddleware(RateLimits.sensitive);
export const rateLimitAuth = createRateLimitMiddleware(RateLimits.auth);
export const rateLimitWebSocket = createRateLimitMiddleware(RateLimits.websocket);

// Rate limit utilities
export const RateLimitUtils = {
  getUsage: (key: string) => globalRateLimiter.getStatus(key),
  resetLimit: (key: string) => globalRateLimiter.reset(key),
  getAllUsage: () => globalRateLimiter.getAllEntries(),

  // Create custom key generator based on multiple factors
  createKeyGenerator: (factors: {
    ip?: boolean;
    user?: boolean;
    userAgent?: boolean;
    custom?: (ctx: Context) => string;
  }) => {
    return (ctx: Context): string => {
      const parts: string[] = [];

      if (factors.ip && ctx.ip) {
        parts.push(`ip:${ctx.ip}`);
      }

      if (factors.user && ctx.user?.userId) {
        parts.push(`user:${ctx.user.userId}`);
      }

      if (factors.userAgent && ctx.userAgent) {
        // Hash user agent to avoid long keys
        parts.push(`ua:${Buffer.from(ctx.userAgent).toString('base64').slice(0, 16)}`);
      }

      if (factors.custom) {
        parts.push(factors.custom(ctx));
      }

      return parts.length > 0 ? parts.join(':') : 'anonymous';
    };
  },
};

// Export for testing
export { globalRateLimiter as rateLimiter };
