import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { Logger } from 'winston';

export interface JWTConfig {
  secret: string;
  expiresIn: string;
  issuer: string;
  audience: string;
  refreshExpiresIn: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  tokenType: 'Bearer';
}

export interface UserPayload {
  userId: string;
  walletAddr: string;
  kycLevel: number;
  email?: string;
  tier: 'freemium' | 'premium' | 'enterprise';
}

export interface RefreshTokenData {
  userId: string;
  tokenId: string;
  expiresAt: Date;
  isRevoked: boolean;
}

export class AuthService {
  private jwtConfig: JWTConfig;
  private logger: Logger;
  private refreshTokens = new Map<string, RefreshTokenData>();

  constructor(config: JWTConfig, logger: Logger) {
    this.jwtConfig = config;
    this.logger = logger;

    // Validate JWT configuration
    this.validateConfig();

    // Clean up expired refresh tokens periodically
    setInterval(() => this.cleanupExpiredTokens(), 15 * 60 * 1000); // Every 15 minutes
  }

  private validateConfig(): void {
    if (!this.jwtConfig.secret) {
      throw new Error('JWT secret is required');
    }

    if (this.jwtConfig.secret.length < 32) {
      this.logger.warn('JWT secret should be at least 32 characters long for better security');
    }

    try {
      // Test JWT signing to ensure configuration is valid
      jwt.sign({ test: true }, this.jwtConfig.secret, { expiresIn: '1s' });
    } catch (error) {
      throw new Error(`Invalid JWT configuration: ${error}`);
    }
  }

  /**
   * Generate access and refresh tokens for a user
   */
  async generateTokens(user: UserPayload): Promise<AuthTokens> {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = new Date(now + this.parseExpiration(this.jwtConfig.expiresIn) * 1000);

    // Generate access token
    const accessToken = jwt.sign(
      {
        sub: user.userId,
        walletAddr: user.walletAddr,
        kycLevel: user.kycLevel,
        tier: user.tier,
        email: user.email,
        type: 'access',
      },
      this.jwtConfig.secret,
      {
        expiresIn: this.jwtConfig.expiresIn,
        issuer: this.jwtConfig.issuer,
        audience: this.jwtConfig.audience,
        algorithm: 'HS256',
        header: {
          typ: 'JWT',
          alg: 'HS256',
        },
      },
    );

    // Generate refresh token
    const tokenId = crypto.randomUUID();
    const refreshToken = jwt.sign(
      {
        sub: user.userId,
        tokenId,
        type: 'refresh',
      },
      this.jwtConfig.secret,
      {
        expiresIn: this.jwtConfig.refreshExpiresIn,
        issuer: this.jwtConfig.issuer,
        audience: this.jwtConfig.audience,
        algorithm: 'HS256',
      },
    );

    // Store refresh token data
    const refreshExpiresAt = new Date(
      now + this.parseExpiration(this.jwtConfig.refreshExpiresIn) * 1000,
    );
    this.refreshTokens.set(tokenId, {
      userId: user.userId,
      tokenId,
      expiresAt: refreshExpiresAt,
      isRevoked: false,
    });

    this.logger.info(`Generated tokens for user ${user.userId}`, {
      userId: user.userId,
      walletAddr: user.walletAddr,
      tokenId,
      expiresAt,
    });

    return {
      accessToken,
      refreshToken,
      expiresAt,
      tokenType: 'Bearer',
    };
  }

  /**
   * Verify and decode access token
   */
  async verifyAccessToken(token: string): Promise<UserPayload> {
    try {
      const decoded = jwt.verify(token, this.jwtConfig.secret, {
        issuer: this.jwtConfig.issuer,
        audience: this.jwtConfig.audience,
        algorithms: ['HS256'],
      }) as any;

      if (decoded.type !== 'access') {
        throw new Error('Invalid token type');
      }

      return {
        userId: decoded.sub,
        walletAddr: decoded.walletAddr,
        kycLevel: decoded.kycLevel,
        email: decoded.email,
        tier: decoded.tier || 'freemium',
      };
    } catch (error) {
      this.logger.warn('Access token verification failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Invalid access token');
    }
  }

  /**
   * Verify refresh token and generate new access token
   */
  async refreshAccessToken(refreshToken: string): Promise<AuthTokens> {
    try {
      const decoded = jwt.verify(refreshToken, this.jwtConfig.secret, {
        issuer: this.jwtConfig.issuer,
        audience: this.jwtConfig.audience,
        algorithms: ['HS256'],
      }) as any;

      if (decoded.type !== 'refresh') {
        throw new Error('Invalid refresh token type');
      }

      // Check if refresh token is still valid
      const tokenData = this.refreshTokens.get(decoded.tokenId);
      if (!tokenData || tokenData.isRevoked || tokenData.expiresAt < new Date()) {
        throw new Error('Refresh token expired or revoked');
      }

      // Get user data (in a real implementation, this would query the database)
      const userPayload: UserPayload = {
        userId: decoded.sub,
        walletAddr: '', // This would come from database
        kycLevel: 0, // This would come from database
        tier: 'freemium',
      };

      // Generate new tokens
      const newTokens = await this.generateTokens(userPayload);

      // Revoke old refresh token
      tokenData.isRevoked = true;

      this.logger.info(`Refreshed access token for user ${userPayload.userId}`, {
        userId: userPayload.userId,
        oldTokenId: decoded.tokenId,
        newTokenId: this.extractTokenId(newTokens.refreshToken),
      });

      return newTokens;
    } catch (error) {
      this.logger.warn('Refresh token verification failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Invalid refresh token');
    }
  }

  /**
   * Revoke a refresh token
   */
  async revokeToken(tokenId: string): Promise<void> {
    const tokenData = this.refreshTokens.get(tokenId);
    if (tokenData) {
      tokenData.isRevoked = true;
      this.logger.info(`Revoked refresh token`, { tokenId, userId: tokenData.userId });
    }
  }

  /**
   * Revoke all refresh tokens for a user
   */
  async revokeAllUserTokens(userId: string): Promise<void> {
    let revokedCount = 0;
    for (const [_tokenId, tokenData] of this.refreshTokens.entries()) {
      if (tokenData.userId === userId && !tokenData.isRevoked) {
        tokenData.isRevoked = true;
        revokedCount++;
      }
    }

    this.logger.info(`Revoked all refresh tokens for user`, { userId, revokedCount });
  }

  /**
   * Check if a refresh token is valid
   */
  async isRefreshTokenValid(tokenId: string): Promise<boolean> {
    const tokenData = this.refreshTokens.get(tokenId);
    return tokenData !== undefined && !tokenData.isRevoked && tokenData.expiresAt > new Date();
  }

  /**
   * Parse expiration time string to seconds
   */
  private parseExpiration(expiration: string): number {
    const match = expiration.match(/(\d+)([smhd])/);
    if (!match) {
      throw new Error(`Invalid expiration format: ${expiration}`);
    }

    const [, amount, unit] = match;
    const value = parseInt(amount, 10);

    switch (unit) {
      case 's':
        return value;
      case 'm':
        return value * 60;
      case 'h':
        return value * 3600;
      case 'd':
        return value * 86400;
      default:
        throw new Error(`Invalid expiration unit: ${unit}`);
    }
  }

  /**
   * Extract token ID from JWT
   */
  private extractTokenId(token: string): string {
    try {
      const decoded = jwt.decode(token) as any;
      return decoded?.tokenId || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Clean up expired refresh tokens
   */
  private cleanupExpiredTokens(): void {
    const now = new Date();
    let cleanedCount = 0;

    for (const [tokenId, tokenData] of this.refreshTokens.entries()) {
      if (tokenData.expiresAt < now || tokenData.isRevoked) {
        this.refreshTokens.delete(tokenId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.debug(`Cleaned up expired/revoked tokens`, { cleanedCount });
    }
  }

  /**
   * Get token statistics
   */
  getTokenStats(): {
    totalRefreshTokens: number;
    activeRefreshTokens: number;
    revokedTokens: number;
    expiredTokens: number;
  } {
    const now = new Date();
    let activeCount = 0;
    let revokedCount = 0;
    let expiredCount = 0;

    for (const tokenData of this.refreshTokens.values()) {
      if (tokenData.isRevoked) {
        revokedCount++;
      } else if (tokenData.expiresAt < now) {
        expiredCount++;
      } else {
        activeCount++;
      }
    }

    return {
      totalRefreshTokens: this.refreshTokens.size,
      activeRefreshTokens: activeCount,
      revokedTokens: revokedCount,
      expiredTokens: expiredCount,
    };
  }

  /**
   * Validate password strength
   */
  validatePassword(password: string): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (password.length < 8) {
      errors.push('Password must be at least 8 characters long');
    }

    if (password.length > 128) {
      errors.push('Password must be less than 128 characters long');
    }

    if (!/[A-Z]/.test(password)) {
      errors.push('Password must contain at least one uppercase letter');
    }

    if (!/[a-z]/.test(password)) {
      errors.push('Password must contain at least one lowercase letter');
    }

    if (!/\d/.test(password)) {
      errors.push('Password must contain at least one number');
    }

    if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password)) {
      errors.push('Password must contain at least one special character');
    }

    // Check for common passwords
    const commonPasswords = ['password', '123456', 'qwerty', 'admin', 'letmein'];
    if (commonPasswords.some((common) => password.toLowerCase().includes(common))) {
      errors.push('Password cannot contain common words');
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Hash password
   */
  async hashPassword(password: string): Promise<string> {
    const saltRounds = 12;
    return bcrypt.hash(password, saltRounds);
  }

  /**
   * Verify password
   */
  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  /**
   * Generate secure random token
   */
  generateSecureToken(length: number = 32): string {
    return crypto.randomBytes(length).toString('hex');
  }

  /**
   * Generate nonce for wallet authentication
   */
  generateNonce(): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const _expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Store nonce with expiration (in a real implementation, this would be in Redis/database)
    return nonce;
  }

  /**
   * Verify wallet signature
   */
  async verifyWalletSignature(
    address: string,
    message: string,
    signature: string,
    nonce: string,
  ): Promise<boolean> {
    try {
      // In a real implementation, this would verify the cryptographic signature
      // using the appropriate algorithm for the blockchain (e.g., Ethereum ECDSA)

      // For now, we'll do basic validation
      if (!address || !message || !signature || !nonce) {
        return false;
      }

      // Verify nonce hasn't expired
      // In a real implementation, check against stored nonce

      // Verify signature matches the message and address
      // This would involve cryptographic verification

      return true; // Placeholder
    } catch (error) {
      this.logger.error('Wallet signature verification failed', {
        address,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

// Create singleton instance
let authService: AuthService | null = null;

export function initializeAuthService(config: JWTConfig, logger: Logger): AuthService {
  if (authService) {
    return authService;
  }

  authService = new AuthService(config, logger);
  return authService;
}

export function getAuthService(): AuthService {
  if (!authService) {
    throw new Error('AuthService not initialized. Call initializeAuthService first.');
  }

  return authService;
}
