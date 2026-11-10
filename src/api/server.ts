import fs from 'node:fs';
import path from 'node:path';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { paths as pathsOf } from '../db/dataDir.ts';
import type { Db } from '../db/open.ts';
import type { Supervisor } from '../supervisor/supervisor.ts';
import { routes } from './routes.ts';
import { guard, loadToken } from './security.ts';
import { WEB_DIST } from './webBuild.ts';
import { eventStream } from './ws.ts';

export const DEFAULT_PORT = 4317;
const PLAIN_PAGE = new URL('./plain.html', import.meta.url);

export type ServerOptions = { db: Db; dataDir: string; supervisor: Supervisor; port?: number; replayCap?: number; /** Where the built app is. Default: web/dist. */ webDir?: string };

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** A file of the built app, or null: only a real file inside the build, whatever the address tries. */
function builtFile(root: string, address: string): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(address.split('?')[0]!);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  const file = path.join(root, pathname);
  if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  // A link inside the build must not lead out of it.
  return fs.realpathSync(file).startsWith(`${fs.realpathSync(root)}${path.sep}`) ? file : null;
}

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

  // The screen. The built app when there is one, the plain page when there is not; looked up on
  // every request, so building while the engine runs is enough. The page carries the token and is never cached.
  const webDir = options.webDir ?? WEB_DIST;
  const page = (reply: FastifyReply, html: string) => reply.header('cache-control', 'no-store').type('text/html; charset=utf-8').send(withToken(html, token));
  const screen = async (request: FastifyRequest, reply: FastifyReply) => {
    const pathname = request.url.split('?')[0]!;
    if (pathname.startsWith('/api/')) return reply.code(404).send({ error: 'There is no such address.' });
    const index = path.join(webDir, 'index.html');
    const built = fs.existsSync(index);
    if (pathname === '/') return page(reply, fs.readFileSync(built ? index : PLAIN_PAGE, 'utf8'));
    const file = built ? builtFile(webDir, request.url) : null;
    if (file && file !== index) {
      // Vite names the files under assets after their contents, so those may be kept for ever.
      const cache = pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
      return reply.header('cache-control', cache).type(TYPES[path.extname(file)] ?? 'application/octet-stream').send(fs.readFileSync(file));
    }
    // Any other address is the app's to interpret, unless it names a file that is not there.
    if (!built || path.extname(pathname) !== '') return reply.code(404).send({ error: 'There is no such file.' });
    return page(reply, fs.readFileSync(index, 'utf8'));
  };
  app.get('/', screen);
  app.get('/*', screen);
  await app.ready();
  return app;
}
