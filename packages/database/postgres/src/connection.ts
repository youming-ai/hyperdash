import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { PostgresError } from 'postgres';
import * as schema from './schema';

export interface DatabaseConfig {
  connectionString: string;
  maxConnections?: number;
  idleTimeout?: number;
  connectTimeout?: number;
  maxLifetime?: number;
  prepare?: boolean;
}

export class DatabaseConnection {
  private client: postgres.Sql | null = null;
  private db: PostgresJsDatabase<typeof schema> | null = null;
  private isInitialized = false;
  private config: DatabaseConfig;

  constructor(config: DatabaseConfig) {
    this.config = {
      maxConnections: 10,
      idleTimeout: 30000,
      connectTimeout: 10000,
      maxLifetime: 60 * 30,
      prepare: true,
      ...config,
    };
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      console.log('Initializing PostgreSQL connection...');

      this.client = postgres(this.config.connectionString, {
        max: this.config.maxConnections,
        idle_timeout: this.config.idleTimeout,
        connect_timeout: this.config.connectTimeout,
        max_lifetime: this.config.maxLifetime,
        prepare: this.config.prepare,
        ssl: process.env.NODE_ENV === 'production' ? 'require' : false,
        // Connection validation
        onnotice: (notice) => {
          console.warn('PostgreSQL notice:', notice);
        },
        // Error handling
        onparameter: (key, value) => {
          if (key === 'server_version') {
            console.log(`Connected to PostgreSQL version: ${value}`);
          }
        },
      });

      this.db = drizzle(this.client, {
        schema,
        logger: process.env.NODE_ENV === 'development',
      });

      // Test the connection
      await this.client`SELECT 1 as test`;
      console.log('✅ PostgreSQL connection established successfully');

      this.isInitialized = true;
    } catch (error) {
      console.error('❌ Failed to initialize PostgreSQL connection:', error);
      throw new Error(
        `Database connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  getDatabase(): PostgresJsDatabase<typeof schema> {
    if (!this.db || !this.isInitialized) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  getClient(): postgres.Sql {
    if (!this.client || !this.isInitialized) {
      throw new Error('Database client not initialized. Call initialize() first.');
    }
    return this.client;
  }

  async healthCheck(): Promise<{
    status: 'healthy' | 'unhealthy';
    latency?: number;
    error?: string;
  }> {
    try {
      if (!this.client) {
        return { status: 'unhealthy', error: 'Client not initialized' };
      }

      const startTime = Date.now();
      await this.client`SELECT 1 as health_check`;
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
      if (this.client) {
        await this.client.end();
        this.client = null;
        this.db = null;
        this.isInitialized = false;
        console.log('✅ PostgreSQL connection closed');
      }
    } catch (error) {
      console.error('❌ Error closing PostgreSQL connection:', error);
      throw error;
    }
  }

  // Transaction helper
  async transaction<T>(
    callback: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
  ): Promise<T> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      return await this.db.transaction(callback);
    } catch (error) {
      console.error('❌ Transaction failed:', error);

      // Handle specific database errors
      if (error instanceof PostgresError) {
        switch (error.code) {
          case '23505': // Unique violation
            throw new Error('Resource already exists');
          case '23503': // Foreign key violation
            throw new Error('Referenced resource does not exist');
          case '23502': // Not null violation
            throw new Error('Required field is missing');
          case '23514': // Check violation
            throw new Error('Data constraint violation');
          default:
            throw new Error(`Database error: ${error.message}`);
        }
      }

      throw error;
    }
  }

  // Connection pool status
  async getPoolStatus(): Promise<{
    totalConnections: number;
    idleConnections: number;
    waitingClients: number;
  }> {
    // This is a simplified version - actual implementation would depend on the postgres.js library
    return {
      totalConnections: this.config.maxConnections || 10,
      idleConnections: this.config.maxConnections ? this.config.maxConnections - 1 : 9,
      waitingClients: 0,
    };
  }
}

// Singleton instance for the application
let dbInstance: DatabaseConnection | null = null;

export function createDatabaseConnection(config?: DatabaseConfig): DatabaseConnection {
  if (!dbInstance) {
    const defaultConfig: DatabaseConfig = {
      connectionString:
        process.env.DATABASE_URL ||
        'postgresql://hyperdash:hyperdash_password@localhost:5432/hyperdash',
      maxConnections: parseInt(process.env.DATABASE_MAX_CONNECTIONS || '10', 10),
      idleTimeout: parseInt(process.env.DATABASE_IDLE_TIMEOUT || '30000', 10),
      connectTimeout: parseInt(process.env.DATABASE_CONNECT_TIMEOUT || '10000', 10),
      ...config,
    };

    dbInstance = new DatabaseConnection(defaultConfig);
  }
  return dbInstance;
}

export function getDatabaseConnection(): DatabaseConnection {
  if (!dbInstance) {
    throw new Error('Database connection not initialized. Call createDatabaseConnection() first.');
  }
  return dbInstance;
}

// Graceful shutdown handler
process.on('SIGINT', async () => {
  console.log('Received SIGINT, closing database connection...');
  if (dbInstance) {
    await dbInstance.close();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, closing database connection...');
  if (dbInstance) {
    await dbInstance.close();
  }
  process.exit(0);
});

// Alias for consistency with the package exports
export {
  createDatabaseConnection as createPostgresConnection,
  DatabaseConnection as PostgresConnection,
};
