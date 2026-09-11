// Main tRPC router and middleware exports

// Note: For AppRouter type, import directly from source in the API gateway:
//   import type { AppRouter } from '@hyperdash/api-gateway/src/routes';
// Or import from the built dist after building api-gateway:
//   import type { AppRouter } from '@hyperdash/api-gateway';
export { createAuthContext, createAuthMiddleware } from './middleware/auth';
export { createRateLimitMiddleware } from './middleware/rateLimit';
export { createValidationMiddleware } from './middleware/validation';
// Router exports
export { marketRouter } from './routers/market';
export { default as t, kycProcedure, protectedProcedure, publicProcedure, router } from './trpc';
export type { AuthContext } from './types';
export { type AsyncContext, type Context, createContext } from './types';
export {
  AuthenticationError,
  AuthorizationError,
  DatabaseError,
  ExternalServiceError,
  HyperDashError,
  handleDatabaseError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from './utils/errors';

// Additional routers will be exported here as they are created
