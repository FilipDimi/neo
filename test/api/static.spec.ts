import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadToken } from '../../src/api/security.ts';
import { buildServer } from '../../src/api/server.ts';
import { webIsStale } from '../../src/api/webBuild.ts';
import { scripted } from '../fixtures/scriptedLink.ts';
import { tempDir, world, type World } from '../helpers.ts';

let open: World | undefined;
afterEach(async () => {
  await open?.sup.stop();
  open = undefined;
});

const PAGE = '<!doctype html><html><head><meta name="vs-token" content=""><meta name="vs-screen" content=""><title>Virtual startup</title></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>';

/** A built app as Vite leaves it: an index and hashed files under assets. */
function builtApp(): string {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), PAGE);
  fs.writeFileSync(path.join(dir, 'assets/app.js'), 'console.log("the app")');
  fs.writeFileSync(path.join(dir, 'assets/app.css'), 'body{}');
  return dir;
}

async function server(webDir: string) {
  const w = (open = world(scripted().spawn));
  const app = await buildServer({ db: w.db, dataDir: w.dir, supervisor: w.sup, port: 4317, webDir });
  const token = loadToken(path.join(w.dir, 'token'));
  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317', ...headers } });
  return { app, token, get };
}

describe('the engine serves the app', () => {
  it('serves the built app with the token in its meta tag', async () => {
    const { get, token } = await server(builtApp());
    const page = await get('/');
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body).toContain(`<meta name="vs-token" content="${token}">`);
    expect(page.body).toContain('/assets/app.js');

    const script = await get('/assets/app.js');
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toMatch(/^text\/javascript/);
    expect(script.headers['cache-control']).toMatch(/immutable/);
    expect(script.body).toBe('console.log("the app")');
    expect((await get('/assets/app.css')).headers['content-type']).toMatch(/^text\/css/);
    expect(script.body).not.toContain(token);
  });

  it('names the screen it serves, in the page and in the snapshot, and the name changes when the built app does', async () => {
    const dir = builtApp();
    const { get, token } = await server(dir);
    const snapshot = async () => (await get('/api/snapshot', { authorization: `Bearer ${token}` })).json() as { screen: string };
    const inPage = async () => /<meta name="vs-screen" content="([0-9a-f]{12})">/.exec((await get('/')).body)?.[1];
    const first = await inPage();
    expect(first).toBeDefined();
    expect((await snapshot()).screen).toBe(first);
    // A new build: the page someone still has open carries the old name, and the engine now says another.
    fs.writeFileSync(path.join(dir, 'index.html'), PAGE.replace('/assets/app.js', '/assets/app-2.js'));
    const second = (await snapshot()).screen;
    expect(second).not.toBe(first);
    expect(await inPage()).toBe(second);
  });

  it('serves the plain page when the app is not built', async () => {
    const { get, token } = await server(tempDir());
    const page = await get('/');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(`<meta name="vs-token" content="${token}">`);
    expect(page.body).toContain('class="board"');
    expect((await get('/assets/app.js')).statusCode).toBe(404);
  });

  it("serves the app's index for an unknown path that is not under /api", async () => {
    const { get, token } = await server(builtApp());
    const page = await get('/board');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(`content="${token}"`);
    expect((await get('/assets/missing.js')).statusCode).toBe(404);
    expect((await get('/api/nothing-here')).statusCode).toBe(401);
    expect((await get('/api/nothing-here', { authorization: `Bearer ${token}` })).statusCode).toBe(404);
  });

  it('never serves a file from outside the built app', async () => {
    const dir = builtApp();
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'the secret');
    fs.writeFileSync(path.join(path.dirname(dir), 'beside.txt'), 'the secret');
    fs.symlinkSync(outside, path.join(dir, 'assets/out'));
    const { get } = await server(dir);
    for (const url of ['/../beside.txt', '/%2e%2e/beside.txt', '/assets/../../beside.txt', '/assets/%2e%2e%2f%2e%2e%2fbeside.txt', '/assets/out/secret.txt', `/${path.join(outside, 'secret.txt')}`, '/assets/%00']) {
      const answer = await get(url);
      expect(answer.body, url).not.toContain('the secret');
    }
  });

  it('refuses the page itself to a foreign Host', async () => {
    const { get, token } = await server(builtApp());
    const answer = await get('/', { host: 'evil.example:4317' });
    expect(answer.statusCode).toBe(403);
    expect(answer.body).not.toContain(token);
  });
});

describe('webIsStale', () => {
  const touch = (file: string, at: Date) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
    fs.utimesSync(file, at, at);
  };

  it('is stale when there is no build, or the source is newer than it', () => {
    const web = tempDir();
    touch(path.join(web, 'index.html'), new Date('2026-11-01T10:00:00Z'));
    touch(path.join(web, 'src/office/Office.tsx'), new Date('2026-11-01T10:00:00Z'));
    expect(webIsStale(web)).toBe(true);
    touch(path.join(web, 'dist/index.html'), new Date('2026-11-01T11:00:00Z'));
    expect(webIsStale(web)).toBe(false);
    touch(path.join(web, 'src/office/art/people.ts'), new Date('2026-11-01T12:00:00Z'));
    expect(webIsStale(web)).toBe(true);
  });

  it('does not count tests and fixtures: they are not in the build', () => {
    const web = tempDir();
    touch(path.join(web, 'src/App.tsx'), new Date('2026-11-01T10:00:00Z'));
    touch(path.join(web, 'dist/index.html'), new Date('2026-11-01T11:00:00Z'));
    touch(path.join(web, 'src/App.spec.tsx'), new Date('2026-11-01T12:00:00Z'));
    touch(path.join(web, 'src/fixtures/story.json'), new Date('2026-11-01T12:00:00Z'));
    expect(webIsStale(web)).toBe(false);
  });
});
