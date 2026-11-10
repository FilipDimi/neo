import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadToken } from '../../src/api/security.ts';
import { buildServer } from '../../src/api/server.ts';
import { scripted } from '../fixtures/scriptedLink.ts';
import { tempDir, world, type World } from '../helpers.ts';

let open: World | undefined;
afterEach(async () => {
  await open?.sup.stop();
  open = undefined;
});

async function server() {
  const w = (open = world(scripted().spawn));
  const app = await buildServer({ db: w.db, dataDir: w.dir, supervisor: w.sup, port: 4317 });
  const token = loadToken(path.join(w.dir, 'token'));
  const ok = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', authorization: `Bearer ${token}` };
  return { w, app, token, ok };
}

describe('the local API is closed to everyone but its own page', () => {
  it('creates the token file with mode 0600, and keeps it', () => {
    const file = path.join(tempDir(), 'token');
    const token = loadToken(file);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(loadToken(file)).toBe(token);
  });

  it('answers a request from its own page', async () => {
    const { app, ok } = await server();
    expect((await app.inject({ method: 'GET', url: '/api/snapshot', headers: ok })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/snapshot', headers: { ...ok, host: 'localhost:4317' } })).statusCode).toBe(200);
  });

  it('refuses a request with a foreign Host, which is what DNS rebinding looks like', async () => {
    const { app, ok } = await server();
    for (const host of ['evil.example:4317', '127.0.0.1:9999', 'localhost']) expect((await app.inject({ method: 'GET', url: '/api/snapshot', headers: { ...ok, host } })).statusCode, host).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/', headers: { host: 'evil.example:4317' } })).statusCode).toBe(403);
  });

  it('refuses a write with a foreign or missing Origin', async () => {
    const { app, ok } = await server();
    const post = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/api/chat', headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify({ text: 'hi' }) });
    expect((await post({ ...ok, origin: 'https://evil.example' })).statusCode).toBe(403);
    const { origin: _origin, ...noOrigin } = ok;
    expect((await post(noOrigin)).statusCode).toBe(403);
  });

  it('refuses a request without the token', async () => {
    const { app, ok } = await server();
    const { authorization: _authorization, ...noToken } = ok;
    expect((await app.inject({ method: 'GET', url: '/api/snapshot', headers: noToken })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/snapshot', headers: { ...ok, authorization: 'Bearer wrong' } })).statusCode).toBe(401);
  });

  it('refuses a body that is not JSON', async () => {
    const { app, ok } = await server();
    const form = await app.inject({ method: 'POST', url: '/api/chat', headers: { ...ok, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'text=hi' });
    const text = await app.inject({ method: 'POST', url: '/api/chat', headers: { ...ok, 'content-type': 'text/plain' }, payload: '{"text":"hi"}' });
    expect([form.statusCode, text.statusCode]).toEqual([415, 415]);
  });

  it('sends no CORS headers, even when asked', async () => {
    const { app, ok } = await server();
    const response = await app.inject({ method: 'GET', url: '/api/snapshot', headers: ok });
    const preflight = await app.inject({ method: 'OPTIONS', url: '/api/chat', headers: { host: ok.host, origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    for (const r of [response, preflight]) expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control'))).toEqual([]);
    expect(preflight.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('serves its page, with the token in it, only to its own host', async () => {
    const { app, token } = await server();
    const page = await app.inject({ method: 'GET', url: '/', headers: { host: '127.0.0.1:4317' } });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain(`<meta name="vs-token" content="${token}">`);
  });
});
