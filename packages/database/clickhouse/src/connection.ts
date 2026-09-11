import { type ClickHouseClient, createClient } from '@clickhouse/client';

export interface ClickHouseConfig {
  url: string;
  database: string;
  username?: string;
  password?: string;
  maxOpenConnections?: number;
  requestTimeout?: number;
  compression?: boolean;
}

export class ClickHouseConnection {
  private client: ClickHouseClient | null = null;
  private isInitialized = false;
  private config: ClickHouseConfig;

  constructor(config: ClickHouseConfig) {
    this.config = {
      username: 'default',
      password: '',
      maxOpenConnections: 10,
      requestTimeout: 30000,
      compression: true,
      ...config,
    };
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      console.log('Initializing ClickHouse connection...');

      this.client = createClient({
        url: this.config.url,
        database: this.config.database,
        username: this.config.username,
        password: this.config.password,
        request_timeout: this.config.requestTimeout,
        clickhouse_settings: {
          async_insert: 1,
          wait_for_async_insert: 1,
          max_threads: 4,
          max_insert_threads: '2',
          max_memory_usage: '10000000000', // 10GB
        },
        compression: {
          response: this.config.compression ?? true,
          request: this.config.compression ?? true,
        },
      });

      // Test the connection
      await this.client.ping();
      console.log('✅ ClickHouse connection established successfully');

      this.isInitialized = true;
    } catch (error) {
      console.error('❌ Failed to initialize ClickHouse connection:', error);
      throw new Error(
        `ClickHouse connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  getClient(): ClickHouseClient {
    if (!this.client || !this.isInitialized) {
      throw new Error('ClickHouse client not initialized. Call initialize() first.');
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
      await this.client.ping();
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
        await this.client.close();
        this.client = null;
        this.isInitialized = false;
        console.log('✅ ClickHouse connection closed');
      }
    } catch (error) {
      console.error('❌ Error closing ClickHouse connection:', error);
      throw error;
    }
  }

  // Execute a query with error handling
  async query({
    query,
    format = 'JSONEachRow',
    clickhouse_settings = {},
    query_params = {},
  }: {
    query: string;
    format?: string;
    clickhouse_settings?: Record<string, any>;
    query_params?: Record<string, any>;
  }) {
    if (!this.client) {
      throw new Error('ClickHouse client not initialized');
    }

    try {
      const result = await this.client.query({
        query,
        format: format as any,
        clickhouse_settings: {
          max_execution_time: 60,
          max_result_rows: '1000000',
          max_result_bytes: '1000000000',
          ...clickhouse_settings,
        },
        query_params,
      });

      return result;
    } catch (error: any) {
      console.error('❌ ClickHouse query failed:', error);

      // Handle specific ClickHouse errors
      if (error.code) {
        switch (error.code) {
          case 60: // DATABASE_NOT_FOUND
            throw new Error(`Database not found: ${this.config.database}`);
          case 81: // TABLE_NOT_FOUND
            throw new Error('Table not found in query');
          case 62: // SYNTAX_ERROR
            throw new Error(`SQL syntax error: ${error.message}`);
          case 210: // DUPLICATE_KEY
            throw new Error('Duplicate key violation');
          case 164: // MEMORY_LIMIT_EXCEEDED
            throw new Error('Query memory limit exceeded');
          default:
            throw new Error(`ClickHouse error (${error.code}): ${error.message}`);
        }
      }

      throw new Error(`Query failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Insert data efficiently
  async insert({
    table,
    values,
    format = 'JSONEachRow',
  }: {
    table: string;
    values: any[] | string;
    format?: string;
  }) {
    if (!this.client) {
      throw new Error('ClickHouse client not initialized');
    }

    try {
      const _insertQuery = `INSERT INTO ${table} FORMAT ${format}`;

      await this.client.insert({
        table,
        values: values as any,
        format: format as any,
      });

      console.log(`✅ Inserted ${Array.isArray(values) ? values.length : 1} rows into ${table}`);
    } catch (error) {
      console.error(`❌ Failed to insert into ${table}:`, error);
      throw error;
    }
  }

  // Batch insert with retry logic
  async batchInsert({
    table,
    values,
    batchSize = 10000,
    maxRetries = 3,
  }: {
    table: string;
    values: any[];
    batchSize?: number;
    maxRetries?: number;
  }) {
    if (!values.length) {
      return;
    }

    console.log(`Starting batch insert of ${values.length} rows into ${table}...`);

    for (let i = 0; i < values.length; i += batchSize) {
      const batch = values.slice(i, i + batchSize);
      let retries = 0;

      while (retries <= maxRetries) {
        try {
          await this.insert({
            table,
            values: batch,
            format: 'JSONEachRow',
          });
          break;
        } catch (error) {
          retries++;
          if (retries > maxRetries) {
            console.error(
              `❌ Failed to insert batch ${i / batchSize + 1} after ${maxRetries} retries:`,
              error,
            );
            throw error;
          }

          const delay = 2 ** retries * 1000; // Exponential backoff
          console.warn(
            `⚠️ Batch insert failed, retrying in ${delay}ms... (attempt ${retries}/${maxRetries})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    console.log(`✅ Successfully inserted ${values.length} rows into ${table}`);
  }

  // Get table information
  async getTableInfo(tableName: string) {
    const result = await this.query({
      query: `DESCRIBE TABLE ${tableName}`,
      format: 'JSONEachRow',
    });

    return result.json;
  }

  // Get database size
  async getDatabaseSize() {
    const result = await this.query({
      query: `
        SELECT
          database,
          sum(bytes) as size_bytes,
          formatReadableSize(sum(bytes)) as size_readable
        FROM system.parts
        WHERE database = '${this.config.database}'
          AND active = 1
        GROUP BY database
      `,
      format: 'JSONEachRow',
    });

    const rows = await result.json();
    return (rows as any[])[0] || { size_bytes: 0, size_readable: '0 B' };
  }
}

// Singleton instance for the application
let chInstance: ClickHouseConnection | null = null;

export function createClickHouseConnection(config?: ClickHouseConfig): ClickHouseConnection {
  if (!chInstance) {
    const defaultConfig: ClickHouseConfig = {
      url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
      database: process.env.CLICKHOUSE_DB || 'hyperdash_analytics',
      username: process.env.CLICKHOUSE_USER || 'default',
      password: process.env.CLICKHOUSE_PASSWORD || '',
      maxOpenConnections: parseInt(process.env.CLICKHOUSE_MAX_CONNECTIONS || '10', 10),
      requestTimeout: parseInt(process.env.CLICKHOUSE_REQUEST_TIMEOUT || '30000', 10),
      compression: process.env.CLICKHOUSE_COMPRESSION !== 'false',
      ...config,
    };

    chInstance = new ClickHouseConnection(defaultConfig);
  }
  return chInstance;
}

export function getClickHouseConnection(): ClickHouseConnection {
  if (!chInstance) {
    throw new Error(
      'ClickHouse connection not initialized. Call createClickHouseConnection() first.',
    );
  }
  return chInstance;
}

// Graceful shutdown handler
process.on('SIGINT', async () => {
  console.log('Received SIGINT, closing ClickHouse connection...');
  if (chInstance) {
    await chInstance.close();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, closing ClickHouse connection...');
  if (chInstance) {
    await chInstance.close();
  }
  process.exit(0);
});
