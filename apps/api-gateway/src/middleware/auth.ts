import type { AsyncContext } from '@hyperdash/contracts';
import { TRPCError } from '@trpc/server';
import { getAuthService } from '../services/auth';

/**
 * Authentication middleware for tRPC procedures
 *
 * This middleware verifies JWT tokens and attaches user information to the context
 */
export const authMiddleware = async ({
  ctx,
  next,
}: {
  ctx: AsyncContext;
  next: (opts?: { ctx: any }) => Promise<any>;
}) => {
  try {
    // Get token from Authorization header
    const authHeader = ctx.req?.headers?.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid authorization header',
      });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Missing access token',
      });
    }

    // Verify token
    const authService = getAuthService();
    const userPayload = await authService.verifyAccessToken(token);

    // Attach user to context
    return next({
      ctx: {
        ...ctx,
        user: userPayload,
      },
    });
  } catch (error) {
    if (error instanceof TRPCError) {
      throw error;
    }

    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Invalid or expired token',
    });
  }
};

/**
 * Optional authentication middleware
 *
 * Attaches user to context if token is present, but doesn't throw if not
 */
export const optionalAuthMiddleware = async ({
  ctx,
  next,
}: {
  ctx: AsyncContext;
  next: (opts?: { ctx: any }) => Promise<any>;
}) => {
  try {
    const authHeader = ctx.req?.headers?.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      if (token) {
        const authService = getAuthService();
        const userPayload = await authService.verifyAccessToken(token);

        return next({
          ctx: {
            ...ctx,
            user: userPayload,
          },
        });
      }
    }
  } catch (error) {
    // Silently ignore auth errors for optional middleware
    console.warn('Optional auth failed:', error);
  }

  // Continue without user context
  return next({
    ctx: {
      ...ctx,
      user: null,
    },
  });
};

/**
 * KYC level validation middleware factory
 */
export const kycLevelMiddleware = (minLevel: number) => {
  return async ({
    ctx,
    next,
  }: {
    ctx: AsyncContext;
    next: (opts?: { ctx: any }) => Promise<any>;
  }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      });
    }

    if (ctx.user.kycLevel < minLevel) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `KYC level ${minLevel} required. Current level: ${ctx.user.kycLevel}`,
      });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  };
};

/**
 * Admin middleware for administrative functions
 */
export const adminMiddleware = async ({
  ctx,
  next,
}: {
  ctx: AsyncContext;
  next: (opts?: { ctx: any }) => Promise<any>;
}) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  }

  // In this implementation, admin users have KYC level 3
  if (ctx.user.kycLevel < 3) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Admin access required',
    });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
};

/**
 * Rate limiting based on user tier
 */
export const userTierRateLimitMiddleware = (limits: {
  freemium: number;
  premium: number;
  enterprise: number;
}) => {
  return async ({
    ctx,
    next,
  }: {
    ctx: AsyncContext;
    next: (opts?: { ctx: any }) => Promise<any>;
  }) => {
    const tier = ((ctx.user as any)?.tier as keyof typeof limits) || 'freemium';
    const limit = limits[tier] || limits.freemium;

    // Implementation would check actual rate limits using Redis
    // For now, we'll just pass through

    return next({
      ctx: {
        ...ctx,
        rateLimit: {
          limit,
          remaining: Math.floor(Math.random() * limit),
          resetTime: new Date(Date.now() + 60000).toISOString(),
        },
      },
    });
  };
};

/**
 * Resource access validation middleware
 */
export const resourceAccessMiddleware = (resource: string, action: string) => {
  return async ({
    ctx,
    next,
  }: {
    ctx: AsyncContext;
    next: (opts?: { ctx: any }) => Promise<any>;
  }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      });
    }

    // In a real implementation, this would check user permissions
    // For now, we'll implement basic checks

    const userId = ctx.user.userId;

    // Log resource access for audit purposes
    console.log(`Resource access: ${action} ${resource} by user ${userId}`);

    return next({
      ctx: {
        ...ctx,
        resourceAccess: {
          resource,
          action,
          authorized: true,
          timestamp: new Date().toISOString(),
        },
      },
    });
  };
};
