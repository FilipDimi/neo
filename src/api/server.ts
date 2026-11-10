import fs from 'node:fs';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { paths as pathsOf } from '../db/dataDir.ts';
import type { Db } from '../db/open.ts';
import type { Supervisor } from '../supervisor/supervisor.ts';
import { routes } from './routes.ts';
import { guard, loadToken } from './security.ts';
import { eventStream } from './ws.ts';

export const DEFAULT_PORT = 4317;
const PLAIN_PAGE = new URL('./plain.html', import.meta.url);

export type ServerOptions = { db: Db; dataDir: string; supervisor: Supervisor; port?: number; replayCap?: number };

/** The page with the per-install token in it. Only a request to our own Host ever gets this far. */
export function withToken(html: string, token: string): string {
  return html.replace('<meta name="vs-token" content="">', `<meta name="vs-token" content="${token}">`);
}

export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  // Closing the server closes its connections too: an open event stream must not keep a stopped engine alive.
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, forceCloseConnections: true });
  const token = loadToken(pathsOf(options.dataDir).token);
  guard(app, { token, port: options.port ?? DEFAULT_PORT });
  await app.register(websocket);
  eventStream(app, { db: options.db, token, replayCap: options.replayCap ?? 5000 });
  routes(app, options);
  app.get('/', async (_request, reply) => reply.header('cache-control', 'no-store').type('text/html; charset=utf-8').send(withToken(fs.readFileSync(PLAIN_PAGE, 'utf8'), token)));
  await app.ready();
  return app;
}
