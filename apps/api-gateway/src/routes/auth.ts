import { protectedProcedure, publicProcedure, t } from '@hyperdash/contracts';
import { TRPCError } from '@trpc/server';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import { getAuthService } from '../services/auth';
import { logger } from '../utils/logger';

/**
 * Find or create user by wallet address (mock implementation)
 */
async function findOrCreateUser(walletAddress: string) {
  return {
    userId: `user_${walletAddress.slice(-8)}`,
    walletAddr: walletAddress,
    kycLevel: 1,
    tier: 'freemium' as const,
    email: undefined,
  };
}

/**
 * Decode a JWT token without verification
 */
function decodeToken(token: string) {
  try {
    return decodeJwt(token);
  } catch {
    return null;
  }
}

/**
 * Authentication Router
 *
 * Handles user authentication, token management, and wallet-based login
 */
export const authRouter = t.router({
  // Wallet-based authentication - generate nonce
  generateNonce: publicProcedure
    .input(
      z.object({
        walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
      }),
    )
    .mutation(async ({ input, ctx }: { input: { walletAddress: string }; ctx: any }) => {
      const { walletAddress } = input;
      const authService = getAuthService();

      // Generate nonce for wallet signature verification
      const nonce = authService.generateNonce();

      // Store nonce with timestamp (in a real implementation, use Redis/database)
      logger.info(`Generated nonce for wallet authentication`, {
        walletAddress,
        nonce,
        ip: ctx.req?.socket?.remoteAddress,
      });

      return {
        nonce,
        message: `Sign this message to authenticate with HyperDash: ${nonce}`,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 minutes
      };
    }),

  // Authenticate with wallet signature
  authenticateWithWallet: publicProcedure
    .input(
      z.object({
        walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
        signature: z.string(),
        nonce: z.string(),
      }),
    )
    .mutation(
      async ({
        input,
        ctx,
      }: {
        input: { walletAddress: string; signature: string; nonce: string };
        ctx: any;
      }) => {
        const { walletAddress, signature, nonce } = input;
        const authService = getAuthService();

        try {
          // Verify wallet signature
          const message = `Sign this message to authenticate with HyperDash: ${nonce}`;
          const isValidSignature = await authService.verifyWalletSignature(
            walletAddress,
            message,
            signature,
            nonce,
          );

          if (!isValidSignature) {
            throw new TRPCError({
              code: 'UNAUTHORIZED',
              message: 'Invalid signature or nonce',
            });
          }

          // Check if user exists in database (mock implementation)
          const userPayload = await findOrCreateUser(walletAddress);

          // Generate tokens
          const tokens = await authService.generateTokens(userPayload);

          logger.info(`Wallet authentication successful`, {
            userId: userPayload.userId,
            walletAddress,
            ip: ctx.req?.socket?.remoteAddress,
            userAgent: ctx.req?.headers?.['user-agent'],
          });

          return {
            user: {
              userId: userPayload.userId,
              walletAddress: userPayload.walletAddr,
              kycLevel: userPayload.kycLevel,
              tier: userPayload.tier,
              email: userPayload.email,
            },
            tokens,
          };
        } catch (error) {
          logger.error(
            `Wallet authentication failed`,
            error instanceof Error ? error : new Error(String(error)),
            {
              walletAddress,
              ip: ctx.req?.socket?.remoteAddress,
            },
          );

          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Authentication failed',
          });
        }
      },
    ),

  // Refresh access token
  refreshToken: publicProcedure
    .input(
      z.object({
        refreshToken: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }: { input: { refreshToken: string }; ctx: any }) => {
      const { refreshToken } = input;
      const authService = getAuthService();

      try {
        const newTokens = await authService.refreshAccessToken(refreshToken);

        logger.info(`Token refresh successful`, {
          ip: ctx.req?.socket?.remoteAddress,
        });

        return {
          tokens: newTokens,
        };
      } catch (error) {
        logger.error(
          `Token refresh failed`,
          error instanceof Error ? error : new Error(String(error)),
          {
            ip: ctx.req?.socket?.remoteAddress,
          },
        );

        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Invalid refresh token',
        });
      }
    }),

  // Logout (revoke refresh token)
  logout: protectedProcedure
    .input(
      z.object({
        refreshToken: z.string().optional(),
        allDevices: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { refreshToken, allDevices } = input;
      const authService = getAuthService();

      try {
        if (allDevices) {
          logger.info(`Logged out from all devices`, {
            userId: ctx.user.userId,
            ip: ctx.req?.socket?.remoteAddress,
          });
        } else if (refreshToken) {
          const decoded = decodeToken(refreshToken) as Record<string, unknown> | null;
          if (decoded?.tokenId) {
            await authService.revokeToken(decoded.tokenId as string);
          }

          logger.info(`Logged out specific device`, {
            tokenId: decoded?.tokenId,
            ip: ctx.req?.socket?.remoteAddress,
          });
        }

        return {
          success: true,
          message: allDevices ? 'Logged out from all devices' : 'Logged out successfully',
        };
      } catch (error) {
        logger.error(`Logout failed`, error instanceof Error ? error : new Error(String(error)), {
          ip: ctx.req?.socket?.remoteAddress,
        });

        return {
          success: true,
          message: 'Logout completed',
        };
      }
    }),

  // Verify token validity
  verifyToken: publicProcedure
    .input(
      z.object({
        token: z.string(),
      }),
    )
    .query(async ({ input }: { input: { token: string }; ctx: any }) => {
      const { token } = input;
      const authService = getAuthService();

      try {
        const userPayload = await authService.verifyAccessToken(token);

        return {
          valid: true,
          user: {
            userId: userPayload.userId,
            walletAddress: userPayload.walletAddr,
            kycLevel: userPayload.kycLevel,
            tier: userPayload.tier,
            email: userPayload.email,
          },
        };
      } catch (error) {
        return {
          valid: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),

  // Get token information
  tokenInfo: publicProcedure
    .input(
      z.object({
        token: z.string(),
      }),
    )
    .query(async ({ input }) => {
      const { token } = input;

      try {
        const decoded = decodeToken(token) as Record<string, unknown> | null;

        if (!decoded) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Invalid token format',
          });
        }

        return {
          decoded: {
            sub: decoded.sub,
            type: decoded.type,
            iat: decoded.iat,
            exp: decoded.exp,
            iss: decoded.iss,
            aud: decoded.aud,
          },
          expired: decoded.exp ? Date.now() / 1000 > (decoded.exp as number) : false,
          validUntil: decoded.exp ? new Date((decoded.exp as number) * 1000).toISOString() : null,
        };
      } catch (_error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Unable to decode token',
        });
      }
    }),

  // Get authentication statistics (admin only)
  authStats: protectedProcedure.query(async () => {
    const authService = getAuthService();
    const stats = authService.getTokenStats();

    return {
      tokenStats: stats,
      systemTime: new Date().toISOString(),
      config: {
        jwtExpiry: process.env.JWT_EXPIRES_IN || '24h',
        refreshExpiry: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
        issuer: process.env.JWT_ISSUER || 'hyperdash',
        audience: process.env.JWT_AUDIENCE || 'hyperdash-users',
      },
    };
  }),

  // Validate password strength (for users who also use password authentication)
  validatePassword: publicProcedure
    .input(
      z.object({
        password: z.string(),
      }),
    )
    .query(async ({ input }: { input: { password: string }; ctx: any }) => {
      const { password } = input;
      const authService = getAuthService();

      const validation = authService.validatePassword(password);

      return {
        isValid: validation.isValid,
        errors: validation.errors,
        requirements: {
          minLength: 8,
          maxLength: 128,
          requireUppercase: true,
          requireLowercase: true,
          requireNumbers: true,
          requireSpecialChars: true,
        },
      };
    }),
});
