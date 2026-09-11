import { TRPCError } from '@trpc/server';
import { jwtVerify, SignJWT } from 'jose';
import type { AuthContext, Context } from '../types';

export interface JWTPayload {
  userId: string;
  walletAddr: string;
  kycLevel: number;
  email?: string;
  permissions: string[];
  iat: number;
  exp: number;
}

// JWT token management
class TokenManager {
  private secret: Uint8Array;
  private issuer: string;
  private audience: string;

  constructor() {
    const secret = process.env.JWT_SECRET || process.env.JWT_SECRET_KEY;
    if (!secret) {
      throw new Error('JWT_SECRET environment variable is required');
    }

    this.secret = new TextEncoder().encode(secret);
    this.issuer = process.env.JWT_ISSUER || 'hyperdash-platform';
    this.audience = process.env.JWT_AUDIENCE || 'hyperdash-users';
  }

  async generateToken(payload: Omit<JWTPayload, 'iat' | 'exp'>): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const fullPayload: JWTPayload = {
      ...payload,
      iat: now,
      exp: now + 24 * 60 * 60, // 24 hours
    };

    return await new SignJWT(fullPayload as any)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt(fullPayload.iat)
      .setExpirationTime(fullPayload.exp)
      .sign(this.secret);
  }

  async verifyToken(token: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: this.issuer,
        audience: this.audience,
      });

      return payload as unknown as JWTPayload;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Invalid token: ${error.message}`);
      }
      throw new Error('Invalid token');
    }
  }

  async refreshToken(token: string): Promise<string> {
    const payload = await this.verifyToken(token);
    const now = Math.floor(Date.now() / 1000);

    // Check if token is still valid (not expired)
    if (payload.exp < now) {
      throw new Error('Token expired');
    }

    // Issue new token with fresh expiration
    const refreshedPayload: Omit<JWTPayload, 'iat' | 'exp'> = {
      userId: payload.userId,
      walletAddr: payload.walletAddr,
      kycLevel: payload.kycLevel,
      email: payload.email,
      permissions: payload.permissions,
    };

    return this.generateToken(refreshedPayload);
  }
}

/**
 * Lazy singleton — avoids a hard crash at import time when JWT_SECRET is not
 * set (e.g. feed-only gateway deployments that never touch the legacy JWT
 * auth paths). The error surfaces on first actual use instead.
 */
let tokenManager: TokenManager | null = null;
function getTokenManager(): TokenManager {
  if (!tokenManager) {
    tokenManager = new TokenManager();
  }
  return tokenManager;
}

export async function createAuthContext(token: string): Promise<AuthContext> {
  const payload = await getTokenManager().verifyToken(token);

  return {
    userId: payload.userId,
    walletAddr: payload.walletAddr,
    kycLevel: payload.kycLevel,
    email: payload.email,
    permissions: payload.permissions,
  };
}

export function createAuthMiddleware(
  options: { required?: boolean; minKycLevel?: number; permissions?: string[] } = {},
) {
  const { required = false, minKycLevel = 0, permissions = [] } = options;

  return async ({ ctx, next }: { ctx: Context; next: any }) => {
    const authHeader = ctx.req?.headers.authorization;
    const token = authHeader?.replace('Bearer ', '');

    if (!token) {
      if (required) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      return next({
        ctx: {
          ...ctx,
          user: null,
        },
      });
    }

    try {
      const authContext = await createAuthContext(token);

      // Check KYC level requirement
      if (authContext.kycLevel < minKycLevel) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `KYC level ${minKycLevel} required. Current level: ${authContext.kycLevel}`,
        });
      }

      // Check permissions requirement
      if (permissions.length > 0) {
        const hasRequiredPermissions = permissions.every((permission) =>
          authContext.permissions.includes(permission),
        );

        if (!hasRequiredPermissions) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: `Required permissions: [${permissions.join(', ')}]`,
          });
        }
      }

      return next({
        ctx: {
          ...ctx,
          user: authContext,
        },
      });
    } catch (error) {
      if (required) {
        const message = error instanceof Error ? error.message : 'Invalid authentication token';
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message,
        });
      }
      return next({
        ctx: {
          ...ctx,
          user: null,
        },
      });
    }
  };
}

// Convenience middleware functions
export const requireAuth = createAuthMiddleware({ required: true });
export const requireKYC1 = createAuthMiddleware({ required: true, minKycLevel: 1 });
export const requireKYC2 = createAuthMiddleware({ required: true, minKycLevel: 2 });
export const requireTrading = createAuthMiddleware({
  required: true,
  permissions: ['trading'],
});
export const requireWithdrawal = createAuthMiddleware({
  required: true,
  permissions: ['withdrawal'],
});
export const requireAdmin = createAuthMiddleware({
  required: true,
  permissions: ['admin'],
});

// Token utilities
export const TokenUtils = {
  generateToken: (payload: Omit<JWTPayload, 'iat' | 'exp'>) =>
    getTokenManager().generateToken(payload),
  verifyToken: (token: string) => getTokenManager().verifyToken(token),
  refreshToken: (token: string) => getTokenManager().refreshToken(token),
};
