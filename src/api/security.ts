/**
 * The local API listens on 127.0.0.1, which is not the same as private: any page open in the
 * browser can reach it. So: only our own Host (DNS rebinding arrives under another name), only
 * our own Origin on every write and on the WebSocket, and a per-install token the page gets from
 * us and nobody else. JSON bodies only, and no CORS headers at all.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';

export const EVENTS_PATH = '/api/events';

/** The per-install token, created on first use in a file only this user can read. */
export function loadToken(file: string): string {
  if (!fs.existsSync(file)) fs.writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return fs.readFileSync(file, 'utf8').trim();
}

export function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function guard(app: FastifyInstance, options: { token: string; port: number }): void {
  const port = (): number => {
    const address = app.server.address();
    return address && typeof address === 'object' ? address.port : options.port;
  };
  // Text bodies are how a cross-site form or a "simple" request smuggles a write past a preflight.
  app.removeContentTypeParser('text/plain');

  app.addHook('onRequest', async (request, reply) => {
    const upgrade = request.headers.upgrade?.toLowerCase() === 'websocket';
    const refuse = (status: number, error: string) => {
      if (!upgrade) return reply.code(status).send({ error });
      // A refused WebSocket never becomes one: answer on the raw socket and close it, so nothing is left half open.
      const socket = request.raw.socket;
      socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
      return reply.hijack();
    };
    const hosts = [`127.0.0.1:${port()}`, `localhost:${port()}`];
    if (!hosts.includes(request.headers.host ?? '')) return refuse(403, 'This server answers only on its own address.');

    const path = request.url.split('?')[0]!;
    const writes = request.method !== 'GET' && request.method !== 'HEAD';
    if ((writes || upgrade) && !hosts.map((host) => `http://${host}`).includes(request.headers.origin ?? '')) return refuse(403, 'This request did not come from the app.');

    // The token is asked for by the route that will answer, not by how the address was spelled:
    // the router decodes an address before it matches, so `/%61pi/…` is the API too.
    // A browser cannot set a header on a WebSocket, so that one proves itself in its first message instead.
    const route = request.routeOptions?.url ?? '';
    if ((route.startsWith('/api/') || path.startsWith('/api/')) && route !== EVENTS_PATH) {
      const given = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
      if (!sameToken(given, options.token)) return refuse(401, 'The token is missing or wrong.');
    }
  });
}
