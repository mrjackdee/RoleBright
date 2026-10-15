import type { PoolOptions } from 'mysql2/promise';
export class StagingDatabaseError extends Error {
  constructor(message = 'Staging database unavailable; no fallback was attempted.') { super(message); }
}
export function stagingDatabaseOptions(env: Record<string, string | undefined> = process.env): PoolOptions {
  if (env.APP_ENV !== 'staging' || env.STAGING_STORAGE !== 'mysql') throw new StagingDatabaseError('Staging requires explicit STAGING_STORAGE=mysql configuration.');
  const host = env.DB_HOST;
  const database = env.DB_NAME;
  const user = env.DB_USER;
  const password = env.DB_PASSWORD;
  const port = Number(env.DB_PORT ?? '3306');
  if (!host || !/^[a-zA-Z0-9.-]+$/.test(host) || !database || !/^[a-zA-Z0-9_]*staging[a-zA-Z0-9_]*$/.test(database) || !user || /[\s\x00]/.test(user) || !password || !Number.isInteger(port) || port < 1 || port > 65535 || env.DB_TLS !== 'required') throw new StagingDatabaseError('Staging database configuration is missing or invalid.');
  return { host, port, database, user, password, ssl: { rejectUnauthorized: true, ...(env.DB_CA ? { ca: env.DB_CA } : {}) },
    connectionLimit: 4, maxIdle: 2, idleTimeout: 60000, waitForConnections: false, queueLimit: 0,
    connectTimeout: 5000, enableKeepAlive: true, multipleStatements: false, charset: 'utf8mb4',
    supportBigNumbers: true, bigNumberStrings: true };
}
