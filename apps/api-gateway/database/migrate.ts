import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { logger } from '../utils/logger';

export interface Migration {
  id: string;
  name: string;
  sql: string;
  hash: string;
}

export class MigrationRunner {
  private pool: Pool;
  private migrationsPath: string;

  constructor(pool: Pool, migrationsPath: string = './database/migrations') {
    this.pool = pool;
    this.migrationsPath = migrationsPath;
  }

  async createMigrationsTable(): Promise<void> {
    const sql = `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `;

    await this.pool.query(sql);
    logger.info('Migrations table created or verified');
  }

  private calculateHash(sql: string): string {
    const crypto = require('node:crypto');
    return crypto.createHash('sha256').update(sql).digest('hex');
  }

  private loadMigrations(): Migration[] {
    try {
      const files = readdirSync(this.migrationsPath)
        .filter((file) => file.endsWith('.sql'))
        .sort();

      return files.map((file) => {
        const sql = readFileSync(join(this.migrationsPath, file), 'utf8');
        return {
          id: file.replace('.sql', ''),
          name: file,
          sql,
          hash: this.calculateHash(sql),
        };
      });
    } catch (error) {
      logger.error('Failed to load migrations:', error);
      throw error;
    }
  }

  private async getExecutedMigrations(): Promise<Set<string>> {
    const result = await this.pool.query('SELECT id FROM schema_migrations');
    return new Set(result.rows.map((row) => row.id));
  }

  async migrate(): Promise<void> {
    await this.createMigrationsTable();

    const migrations = this.loadMigrations();
    const executed = await this.getExecutedMigrations();

    const pendingMigrations = migrations.filter((m) => !executed.has(m.id));

    if (pendingMigrations.length === 0) {
      logger.info('No pending migrations');
      return;
    }

    logger.info(`Running ${pendingMigrations.length} pending migrations`);

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      for (const migration of pendingMigrations) {
        logger.info(`Running migration: ${migration.name}`);

        try {
          await client.query(migration.sql);

          await client.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [
            migration.id,
            migration.name,
          ]);

          logger.info(`Migration ${migration.name} completed`);
        } catch (error) {
          logger.error(`Migration ${migration.name} failed:`, error);
          throw error;
        }
      }

      await client.query('COMMIT');
      logger.info('All migrations completed successfully');
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Migration failed, rolled back:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async rollback(targetId?: string): Promise<void> {
    const executed = await this.getExecutedMigrations();
    const migrations = this.loadMigrations().reverse();

    let targetIndex = migrations.length;
    if (targetId) {
      targetIndex = migrations.findIndex((m) => m.id === targetId);
      if (targetIndex === -1) {
        throw new Error(`Migration ${targetId} not found`);
      }
    }

    const toRollback = migrations.filter(
      (m) => executed.has(m.id) && migrations.indexOf(m) >= targetIndex,
    );

    if (toRollback.length === 0) {
      logger.info('No migrations to rollback');
      return;
    }

    logger.info(`Rolling back ${toRollback.length} migrations`);

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      for (const migration of toRollback) {
        logger.info(`Rolling back migration: ${migration.name}`);

        // Note: This would require rollback migrations to be implemented
        // For now, we'll just remove the migration record
        await client.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);

        logger.info(`Migration ${migration.name} rolled back`);
      }

      await client.query('COMMIT');
      logger.info('Rollback completed');
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Rollback failed:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async status(): Promise<void> {
    const migrations = this.loadMigrations();
    const executed = await this.getExecutedMigrations();

    logger.info('Migration Status:');
    logger.info('==================');

    for (const migration of migrations) {
      const status = executed.has(m.id) ? '✓' : 'pending';
      logger.info(`${status} ${migration.name} (${migration.id})`);
    }
  }
}

export async function runMigrations(pool: Pool): Promise<void> {
  const runner = new MigrationRunner(pool);
  await runner.migrate();
}
