import { TRPCError } from '@trpc/server';
import { ZodError } from 'zod';

export class HyperDashError extends TRPCError {
  constructor(
    code: TRPCError['code'],
    message: string,
    public readonly details?: any,
    public readonly errorCode?: string,
    public readonly timestamp: string = new Date().toISOString(),
  ) {
    super({ code, message, cause: details });
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      errorCode: this.errorCode,
      details: this.details,
      timestamp: this.timestamp,
    };
  }
}

export class NotFoundError extends HyperDashError {
  constructor(
    resource: string,
    identifier?: string,
    public readonly resourceType?: string,
  ) {
    super(
      'NOT_FOUND',
      `${resource}${identifier ? ` with ID ${identifier}` : ''} not found`,
      { resource, identifier, resourceType },
      'RESOURCE_NOT_FOUND',
    );
  }
}

export class ValidationError extends HyperDashError {
  constructor(
    message: string,
    field?: string,
    public readonly value?: any,
  ) {
    super('BAD_REQUEST', message, { field, value }, 'VALIDATION_ERROR');
  }
}

export class AuthenticationError extends HyperDashError {
  constructor(
    message: string = 'Authentication required',
    public readonly authType?: string,
  ) {
    super('UNAUTHORIZED', message, { authType }, 'AUTHENTICATION_ERROR');
  }
}

export class AuthorizationError extends HyperDashError {
  constructor(
    message: string = 'Access denied',
    public readonly requiredPermission?: string,
  ) {
    super('FORBIDDEN', message, { requiredPermission }, 'AUTHORIZATION_ERROR');
  }
}

export class RateLimitError extends HyperDashError {
  constructor(
    message: string = 'Rate limit exceeded',
    public readonly retryAfter?: number,
  ) {
    super('TOO_MANY_REQUESTS', message, { retryAfter }, 'RATE_LIMIT_ERROR');
  }
}

export class DatabaseError extends HyperDashError {
  constructor(
    message: string = 'Database operation failed',
    public readonly operation?: string,
  ) {
    super('INTERNAL_SERVER_ERROR', message, { operation }, 'DATABASE_ERROR');
  }
}

export class ExternalServiceError extends HyperDashError {
  constructor(
    service: string,
    message: string = 'External service error',
    public readonly serviceCode?: string,
  ) {
    super(
      'INTERNAL_SERVER_ERROR',
      `${service}: ${message}`,
      { service, serviceCode },
      'EXTERNAL_SERVICE_ERROR',
    );
  }
}

export class BusinessLogicError extends HyperDashError {
  constructor(
    message: string,
    public readonly businessRule?: string,
  ) {
    super('BAD_REQUEST', message, { businessRule }, 'BUSINESS_LOGIC_ERROR');
  }
}

export class ConfigurationError extends HyperDashError {
  constructor(
    message: string,
    public readonly configKey?: string,
  ) {
    super('INTERNAL_SERVER_ERROR', message, { configKey }, 'CONFIGURATION_ERROR');
  }
}

export class NetworkError extends HyperDashError {
  constructor(
    message: string = 'Network error',
    public readonly endpoint?: string,
  ) {
    super('INTERNAL_SERVER_ERROR', message, { endpoint }, 'NETWORK_ERROR');
  }
}

export class TimeoutError extends HyperDashError {
  constructor(
    message: string = 'Operation timed out',
    public readonly timeout?: number,
  ) {
    super('INTERNAL_SERVER_ERROR', message, { timeout }, 'TIMEOUT_ERROR');
  }
}

export class ConcurrencyError extends HyperDashError {
  constructor(
    message: string = 'Concurrency conflict',
    public readonly resource?: string,
  ) {
    super('CONFLICT', message, { resource }, 'CONCURRENCY_ERROR');
  }
}

// Error handling utilities
export class ErrorHandler {
  static handleDatabaseError(error: any): never {
    console.error('Database error:', error);

    if (error.code === '23505') {
      // Unique violation
      throw new ValidationError('Resource already exists', undefined, error.detail);
    }

    if (error.code === '23503') {
      // Foreign key violation
      throw new ValidationError('Referenced resource does not exist', undefined, error.detail);
    }

    if (error.code === '23502') {
      // Not null violation
      throw new ValidationError('Required field is missing', error.column);
    }

    if (error.code === '23514') {
      // Check violation
      throw new ValidationError('Data constraint violation', undefined, error.detail);
    }

    if (error.code === '40P01') {
      // Deadlock detected
      throw new ConcurrencyError('Database deadlock detected, please retry');
    }

    if (error.code === '55P03') {
      // Lock not available
      throw new ConcurrencyError('Resource is locked, please try again later');
    }

    // Generic database error
    throw new DatabaseError(error.message, error.code);
  }

  static handleValidationError(error: ZodError): never {
    const fieldErrors = error.issues.map((err) => ({
      field: err.path.join('.'),
      message: err.message,
      code: err.code,
    }));

    throw new ValidationError('Validation failed', fieldErrors[0]?.field, {
      validationErrors: fieldErrors,
      originalError: error.message,
    });
  }

  static handleExternalServiceError(service: string, error: any): never {
    console.error(`External service error (${service}):`, error);

    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;

      if (status === 401) {
        throw new ExternalServiceError(service, 'Service authentication failed', 'AUTH_ERROR');
      }

      if (status === 403) {
        throw new ExternalServiceError(service, 'Service access forbidden', 'ACCESS_DENIED');
      }

      if (status === 429) {
        const retryAfter = error.response.headers['retry-after'];
        throw new RateLimitError(
          `${service} rate limit exceeded`,
          retryAfter ? parseInt(retryAfter, 10) : undefined,
        );
      }

      if (status >= 500) {
        throw new ExternalServiceError(service, 'Service temporarily unavailable', 'SERVICE_ERROR');
      }

      // Client error from external service
      throw new ExternalServiceError(
        service,
        data?.message || `Service returned error ${status}`,
        `HTTP_${status}`,
      );
    }

    if (error.code === 'ECONNREFUSED') {
      throw new NetworkError(`${service} service is unreachable`, service);
    }

    if (error.code === 'ETIMEDOUT') {
      throw new TimeoutError(`${service} service request timed out`);
    }

    // Generic external service error
    throw new ExternalServiceError(service, error.message || 'Unknown service error');
  }

  static handleKafkaError(error: any): never {
    console.error('Kafka error:', error);

    if (error.type === 'UNKNOWN_MEMBER_ID') {
      throw new ExternalServiceError('Kafka', 'Consumer group rebalancing', 'REBALANCING');
    }

    if (error.type === 'NOT_COORDINATOR_FOR_GROUP') {
      throw new ExternalServiceError(
        'Kafka',
        'Group coordinator not available',
        'COORDINATOR_UNAVAILABLE',
      );
    }

    if (error.type === 'GROUP_AUTHENTICATION_FAILED') {
      throw new ExternalServiceError('Kafka', 'Group authentication failed', 'AUTH_FAILED');
    }

    throw new ExternalServiceError('Kafka', error.message || 'Kafka operation failed');
  }

  static handleRedisError(error: any): never {
    console.error('Redis error:', error);

    if (error.code === 'ECONNREFUSED') {
      throw new ExternalServiceError('Redis', 'Cache service unavailable', 'CONNECTION_REFUSED');
    }

    if (error.code === 'NOAUTH') {
      throw new ExternalServiceError('Redis', 'Cache authentication failed', 'AUTH_FAILED');
    }

    if (error.message?.includes('WRONGTYPE')) {
      throw new ValidationError('Invalid data type in cache operation');
    }

    throw new ExternalServiceError('Redis', error.message || 'Cache operation failed');
  }

  static handleWebSocketError(error: any): never {
    console.error('WebSocket error:', error);

    if (error.code === 'ECONNRESET') {
      throw new NetworkError('WebSocket connection reset');
    }

    if (error.message?.includes('Unexpected server response')) {
      throw new NetworkError('Invalid WebSocket server response');
    }

    throw new NetworkError(error.message || 'WebSocket connection error');
  }

  // Generic error handler that routes to specific handlers
  static handleError(error: any, context?: string): never {
    // Log the error with context
    console.error(`Error in ${context || 'unknown context'}:`, error);

    // tRPC errors should be re-thrown as-is
    if (error instanceof TRPCError && !(error instanceof HyperDashError)) {
      throw error;
    }

    // Zod validation errors
    if (error instanceof ZodError) {
      return ErrorHandler.handleValidationError(error);
    }

    // Database errors
    if (error.code && typeof error.code === 'string' && error.code.startsWith('23')) {
      return ErrorHandler.handleDatabaseError(error);
    }

    // Network/timeout errors
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
      throw new NetworkError(error.message);
    }

    // Generic HyperDash errors should be re-thrown
    if (error instanceof HyperDashError) {
      throw error;
    }

    // Unknown errors
    throw new HyperDashError(
      'INTERNAL_SERVER_ERROR',
      error.message || 'An unexpected error occurred',
      { originalError: error, context },
      'UNKNOWN_ERROR',
    );
  }
}

// Error response formatter for consistent API responses
export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: any;
    timestamp: string;
    requestId?: string;
  };
}

export function formatErrorResponse(error: any, requestId?: string): ErrorResponse {
  if (error instanceof HyperDashError) {
    return {
      success: false,
      error: {
        code: error.errorCode || 'UNKNOWN_ERROR',
        message: error.message,
        details: error.details,
        timestamp: error.timestamp,
        requestId,
      },
    };
  }

  if (error instanceof TRPCError) {
    return {
      success: false,
      error: {
        code: error.code,
        message: error.message,
        timestamp: new Date().toISOString(),
        requestId,
      },
    };
  }

  return {
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
      timestamp: new Date().toISOString(),
      requestId,
    },
  };
}

// Error logging utility
export class ErrorLogger {
  static log(
    error: any,
    context?: {
      userId?: string;
      ip?: string;
      userAgent?: string;
      requestId?: string;
      path?: string;
      method?: string;
    },
  ) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      message: error.message || 'Unknown error',
      error: {
        name: error.name,
        code: error.code,
        errorCode: error.errorCode,
        stack: error.stack,
        details: error.details,
      },
      context,
    };

    if (process.env.NODE_ENV === 'production') {
      // In production, use structured logging
      console.error(JSON.stringify(logEntry));
    } else {
      // In development, use pretty logging
      console.error('🔥 Error:', logEntry);
    }
  }
}

// Re-export all error classes - already exported at declaration
// Legacy exports for backward compatibility
export function handleDatabaseError(error: any): never {
  return ErrorHandler.handleDatabaseError(error);
}
