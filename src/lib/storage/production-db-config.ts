import { isIP } from 'node:net';
import type { PoolOptions } from 'mysql2/promise';
import { DatabaseError } from './database-error';

type Environment = Record<string, string | undefined>;
// Approved resource names are an application guard, not proof of effective grants.
export const productionTarget = Object.freeze({
  database: 'u761630263_rb_prod', user: 'u761630263_rb_prodapp',
});

export function productionStorageSelected(env: Environment = process.env): boolean {
  const mode = env.PRODUCTION_STORAGE;
  if (!mode) return false;
  if (mode !== 'mysql' || env.APP_ENV !== 'production') {
    throw new DatabaseError('Invalid production storage selection.');
  }
  return true;
}

export function productionDatabaseOptions(env: Environment = process.env): PoolOptions {
  if (!productionStorageSelected(env)) throw new DatabaseError('Production MySQL activation is required.');
  const host = env.PROD_DB_HOST;
  const port = Number(env.PROD_DB_PORT ?? '3306');
  if (!host || isIP(host) !== 0 || !/^[a-zA-Z0-9.-]+$/.test(host) ||
      env.PROD_DB_NAME !== productionTarget.database || env.PROD_DB_USER !== productionTarget.user ||
      !env.PROD_DB_PASSWORD || env.PROD_DB_TLS !== 'required' ||
      !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DatabaseError('Production database configuration is missing or invalid.');
  }
  return {
    host, port, database: env.PROD_DB_NAME, user: env.PROD_DB_USER, password: env.PROD_DB_PASSWORD,
    ssl: { rejectUnauthorized: true, verifyIdentity: true, ...(env.PROD_DB_CA ? { ca: env.PROD_DB_CA } : {}) },
    connectionLimit: 4, maxIdle: 2, idleTimeout: 60000, waitForConnections: false, queueLimit: 0,
    connectTimeout: 5000, enableKeepAlive: true, multipleStatements: false, charset: 'utf8mb4',
    supportBigNumbers: true, bigNumberStrings: true,
  };
}
