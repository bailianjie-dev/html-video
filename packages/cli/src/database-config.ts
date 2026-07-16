import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import type { DbClient, DbQueryResult, TransactionalDbClient } from '@html-video/core';

export interface DatabaseConfig {
  enabled: boolean;
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
  poolMinSize: number;
  poolMaxSize: number;
  poolTimeout: number;
  connectTimeout: number;
  sourcePath: string;
}

export interface PgClientHandle {
  db: TransactionalDbClient;
  close(): Promise<void>;
}

export function loadDatabaseConfig(projectRoot: string): DatabaseConfig | null {
  const candidates = [
    join(projectRoot, '.html-video', 'database.toml'),
    join(projectRoot, 'database.toml'),
  ];
  const sourcePath = candidates.find((path) => existsSync(path));
  if (!sourcePath) return null;
  const parsed = parseDatabaseToml(readFileSync(sourcePath, 'utf8'));
  if (!parsed) return null;
  return { ...parsed, sourcePath };
}

export function createPgClient(config: DatabaseConfig): PgClientHandle {
  const poolConfig: PoolConfig = {
    host: config.host,
    port: config.port,
    database: config.name,
    user: config.user,
    password: config.password,
    min: config.poolMinSize,
    max: config.poolMaxSize,
    idleTimeoutMillis: config.poolTimeout * 1000,
    connectionTimeoutMillis: config.connectTimeout * 1000,
  };
  const pool = new Pool(poolConfig);
  const query = async <T = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<T>> => {
    const result = await pool.query(sql, params ? [...params] : undefined);
    const rows = Array.isArray(result.rows) ? result.rows as T[] : [];
    return { rows, rowCount: result.rowCount ?? rows.length };
  };
  return {
    db: {
      query,
      async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn({
            async query<R = unknown>(sql: string, params?: readonly unknown[]): Promise<DbQueryResult<R>> {
              const queried = await client.query(sql, params ? [...params] : undefined);
              const rows = Array.isArray(queried.rows) ? queried.rows as R[] : [];
              return { rows, rowCount: queried.rowCount ?? rows.length };
            },
          });
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      },
    },
    close: () => pool.end(),
  };
}

export function maskedDatabaseConfig(config: DatabaseConfig): Record<string, unknown> {
  return {
    enabled: config.enabled,
    host: maskHost(config.host),
    port: config.port,
    name: maskName(config.name),
    user: config.user,
    pool_min_size: config.poolMinSize,
    pool_max_size: config.poolMaxSize,
    pool_timeout: config.poolTimeout,
    connect_timeout: config.connectTimeout,
    source_path: config.sourcePath,
  };
}

function parseDatabaseToml(raw: string): Omit<DatabaseConfig, 'sourcePath'> | null {
  let inDatabase = false;
  const values: Record<string, string | number | boolean> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.replace(/#.*$/, '').trim();
    if (!trimmed) continue;
    const section = /^\[([^\]]+)\]$/.exec(trimmed);
    if (section) {
      inDatabase = section[1] === 'database';
      continue;
    }
    if (!inDatabase) continue;
    const match = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(trimmed);
    if (!match) continue;
    values[match[1]!] = parseTomlValue(match[2]!.trim());
  }

  const host = asString(values.host);
  const name = asString(values.name);
  const user = asString(values.user);
  const password = asString(values.password);
  if (!host || !name || !user || !password) return null;

  return {
    enabled: asBoolean(values.enabled, false),
    host,
    port: asNumber(values.port, 5432),
    name,
    user,
    password,
    poolMinSize: asNumber(values.pool_min_size, 0),
    poolMaxSize: asNumber(values.pool_max_size, 10),
    poolTimeout: asNumber(values.pool_timeout, 30),
    connectTimeout: asNumber(values.connect_timeout, 10),
  };
}

function parseTomlValue(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const quoted = /^"([\s\S]*)"$/.exec(value);
  if (quoted) return quoted[1]!.replace(/\\"/g, '"');
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function maskHost(host: string): string {
  const parts = host.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.*`;
  return host.length <= 4 ? '****' : `${host.slice(0, 2)}***${host.slice(-2)}`;
}

function maskName(name: string): string {
  if (name.length <= 4) return '****';
  return `${name.slice(0, 3)}***${name.slice(-2)}`;
}
