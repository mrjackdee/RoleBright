import { readFileSync } from 'node:fs';
import { connect as connectTcp, type Socket } from 'node:net';
// @vitest-environment node
import { createRequire } from 'node:module';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ConnectionOptions, PeerCertificate, TLSSocket } from 'node:tls';
import type { PoolOptions } from 'mysql2/promise';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { productionDatabaseOptions } from '@/lib/storage/production-db-config';

const require = createRequire(import.meta.url);
const tls: typeof import('node:tls') = require('node:tls');
const driverRoot = path.dirname(require.resolve('mysql2/package.json'));
const PoolConfig: new (options: PoolOptions) => { connectionConfig: { host: string; ssl: { rejectUnauthorized: boolean; verifyIdentity: boolean } } } = require(path.join(driverRoot, 'lib/pool_config.js'));
const Connection: { prototype: { startTLS: (this: unknown, callback: (error?: Error) => void) => void } } = require(path.join(driverRoot, 'lib/base/connection.js'));
const env = { APP_ENV: 'production', PRODUCTION_STORAGE: 'mysql', PROD_DB_HOST: 'db.example.invalid', PROD_DB_NAME: 'u761630263_rb_prod', PROD_DB_USER: 'u761630263_rb_prodapp', PROD_DB_PASSWORD: 'synthetic', PROD_DB_TLS: 'required' };
afterEach(() => vi.restoreAllMocks());

// Exercise the PINNED DRIVER'S actual startTLS code without a socket, server or credentials.
// Chain trust/handshake completion are simulated; hostname validation is Node's real function.
function handshake(subjectaltname: string) {
  const config = new PoolConfig(productionDatabaseOptions(env)).connectionConfig;
  const secure = vi.fn(); let connected!: () => void; let captured!: ConnectionOptions;
  const socket = Object.assign(new EventEmitter(), {
    authorized: true,
    isSessionReused: () => false,
    getPeerCertificate: () => ({ subjectaltname }) as PeerCertificate,
  });
  vi.spyOn(tls, 'connect').mockImplementation((...args: unknown[]) => {
    captured = args[0] as ConnectionOptions; connected = args[1] as () => void;
    return socket as TLSSocket;
  });
  Connection.prototype.startTLS.call({ config, stream: new EventEmitter() }, secure);
  connected();
  return { config, captured, secure };
}

describe('pinned mysql2 TLS identity regression (no network)', () => {
  it('enables both checks through real PoolConfig and selects the real Node identity checker', () => {
    const { config, captured, secure } = handshake('DNS:db.example.invalid');
    expect(config.ssl).toMatchObject({ rejectUnauthorized: true, verifyIdentity: true });
    expect(captured.rejectUnauthorized).toBe(true);
    expect(captured.checkServerIdentity).toBe(tls.checkServerIdentity);
    expect(captured.servername).toBe('db.example.invalid');
    expect(secure).toHaveBeenCalledWith();
  });
  it('rejects a wrong-host certificate after simulated successful chain verification', () => {
    const { captured, secure } = handshake('DNS:other.example.invalid');
    expect(captured.checkServerIdentity!('db.example.invalid', { subjectaltname: 'DNS:other.example.invalid' } as PeerCertificate)).toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    expect(secure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }));
  });
  it.each(['127.0.0.1', '192.0.2.1', '::1'])('denies IP endpoint %s before driver construction', host => {
    // mysql2 omits servername and its post-handshake identity check for IP hosts.
    // Do not assume the TLS socket's implicit host matches the configured IP.
    expect(() => productionDatabaseOptions({ ...env, PROD_DB_HOST: host })).toThrow('invalid');
  });
  it('does not accept environment attempts to disable either certificate check', () => {
    const options = productionDatabaseOptions({ ...env, PROD_DB_TLS_VERIFY_IDENTITY: 'false', PROD_DB_TLS_REJECT_UNAUTHORIZED: 'false', NODE_TLS_REJECT_UNAUTHORIZED: '0' });
    expect(new PoolConfig(options).connectionConfig.ssl).toMatchObject({ rejectUnauthorized: true, verifyIdentity: true });
  });
});

describe('real TLS over disposable loopback (no MySQL server)', () => {
  it.each(['db.example.invalid', 'wrong.example.invalid'])('validates a trusted synthetic certificate against %s', async host => {
    const key = readFileSync(new URL('./fixtures/synthetic-tls-key.pem', import.meta.url));
    const cert = readFileSync(new URL('./fixtures/synthetic-tls-cert.pem', import.meta.url));
    const peers = new Set<Socket>();
    const server = tls.createServer({ key, cert });
    server.on('connection', socket => { peers.add(socket); socket.on('close', () => peers.delete(socket)); });
    server.on('tlsClientError', () => { /* Expected when the client rejects identity. */ });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing synthetic listener');
    const stream = connectTcp(address.port, '127.0.0.1');
    const context = {
      config: new PoolConfig(productionDatabaseOptions({ ...env, PROD_DB_HOST: host, PROD_DB_CA: cert.toString() })).connectionConfig,
      stream: stream as Socket,
      packetParser: { execute: () => undefined },
      _handleNetworkError: () => undefined,
    };
    try {
      const error = await new Promise<Error | undefined>(resolve => Connection.prototype.startTLS.call(context, resolve));
      if (host === 'db.example.invalid') {
        expect(error).toBeUndefined();
        expect((context.stream as TLSSocket).authorized).toBe(true);
      } else {
        expect(error).toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
      }
    } finally {
      context.stream.destroy(); stream.destroy(); for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
