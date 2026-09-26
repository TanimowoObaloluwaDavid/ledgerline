import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * The web app, served from disk.
 *
 * The app in `public/` is plain ES modules with no build step, so there is no
 * bundler output to serve and no plugin to install. What it does need is a
 * decision about *which* files may be read, and this is it: every path is
 * matched against a fixed list before it reaches the filesystem. A request for
 * `..%2f..%2f.env` finds no entry in the table and is a 404, rather than
 * something that depends on how the path was normalised.
 *
 * A deliberate cost: adding a file to the app means adding it to `WEB_ASSETS`.
 * That is fine for an app this size, and it is the reason there is no path
 * traversal here to get wrong.
 */

interface WebAsset {
  /** Path relative to the web root, e.g. `assets/app.css`. */
  readonly file: string;
  readonly type: string;
}

const WEB_ASSETS: Readonly<Record<string, WebAsset>> = Object.freeze({
  '/app/assets/app.css': { file: 'assets/app.css', type: 'text/css; charset=utf-8' },
  '/app/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app/lib/api.js': { file: 'lib/api.js', type: 'text/javascript; charset=utf-8' },
  '/app/lib/dom.js': { file: 'lib/dom.js', type: 'text/javascript; charset=utf-8' },
  '/app/lib/money.js': { file: 'lib/money.js', type: 'text/javascript; charset=utf-8' },
});

/**
 * Content-Security-Policy for the app.
 *
 * The app ships no inline script and no inline style, so it can afford a policy
 * that forbids both. The chart bars are SVG attributes and the indentation is a
 * class name precisely so that this header can stay this strict.
 */
const WEB_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export interface WebOptions {
  /** Directory holding `index.html`, `app.js` and `assets/`. */
  readonly root: string;
  /** Serve `index.html` at `/app`. Defaults to true. */
  readonly enabled?: boolean;
}

/** True when `candidate` stays inside `root` once normalised. */
export function isInside(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = isAbsolute(candidate) ? candidate : join(base, candidate);
  const normalised = normalize(target);
  return normalised === base || normalised.startsWith(base + sep);
}

/** The file an asset URL maps to, or `null` when the URL is not on the list. */
export function assetPathFor(url: string): string | null {
  const path = (url.split('?')[0] ?? url).replace(/\/+$/, '');
  if (path === '/app' || path === '/app/index.html') {
    return 'index.html';
  }
  return WEB_ASSETS[path]?.file ?? null;
}

export function typeFor(url: string): string {
  const path = (url.split('?')[0] ?? url).replace(/\/+$/, '');
  if (path === '/app' || path === '/app/index.html') {
    return 'text/html; charset=utf-8';
  }
  return WEB_ASSETS[path]?.type ?? 'application/octet-stream';
}

export function registerWeb(app: FastifyInstance, options: WebOptions): void {
  if (options.enabled === false) {
    return;
  }
  const root = resolve(options.root);

  app.get('/app', async (_request, reply) => {
    void reply
      .header('content-security-policy', WEB_CSP)
      .header('cache-control', 'no-cache')
      .type('text/html; charset=utf-8')
      .send(await readFile(join(root, 'index.html')));
  });

  app.get('/app/*', async (request, reply) => {
    const url = request.url;
    const file = assetPathFor(url);
    if (file === null || !isInside(root, file)) {
      void reply.status(404).send({
        error: { code: 'VALIDATION_FAILED', message: `No web asset for ${url}.`, details: {} },
      });
      return;
    }
    let body: Buffer;
    try {
      body = await readFile(join(root, file));
    } catch {
      void reply.status(404).send({
        error: { code: 'VALIDATION_FAILED', message: `No web asset for ${url}.`, details: {} },
      });
      return;
    }
    // Assets are named without hashes, so a stale cached copy would be a bug
    // report. Revalidate every time; the files are a few kilobytes.
    void reply
      .header('content-security-policy', WEB_CSP)
      .header('cache-control', 'no-cache')
      .type(typeFor(url))
      .send(body);
  });
}
