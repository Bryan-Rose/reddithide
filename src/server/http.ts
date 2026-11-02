// HTTP API and pages (SPEC §5.4). Everything except /healthz, the login page and its stylesheet goes through one auth check.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { z } from 'zod';
import { summarizeZodError } from '../classify/schema';
import type { ServerRpcMethod } from '../shared/messages';
import { errorMessage } from '../shared/util';
import { getBlockSet } from './blockset';
import { pingDb } from './db';
import { ingestMeta, ingestSeen } from './ingest';
import { schedulePump } from './pipeline';
import { handleRpc } from './router';
import { metaSchema, rpcParams, seenSchema } from './schemas';

const MAX_BODY_BYTES = 1024 * 1024;
const RPC_PREFIX = '/api/rpc/';
const COOKIE = 'reddithide_login';
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
const LOGIN_ERROR_SLOT = '<!-- error -->';

// The pages show untrusted Reddit and LLM text, and they lost the extension CSP when they moved here.
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

// A fixed list, so no request path ever reaches the filesystem.
const PAGES: Record<string, string> = {
  '/': 'review.html',
  '/review.html': 'review.html',
  '/options.html': 'options.html',
};
const ASSETS = ['review.js', 'options.js', 'common.css', 'review.css', 'options.css'];
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

export interface AppConfig {
  token: string;
  /** PUBLIC_ORIGIN. */
  origin: string;
  /** Built pages. */
  publicDir: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** Hashing gives equal lengths, which timingSafeEqual needs. */
const safeEqual = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

/** Derived, so a stolen cookie can't be used as the token. Changing SERVER_TOKEN signs out every browser. */
const cookieValue = (token: string) => createHmac('sha256', token).update(COOKIE).digest('hex');

function readCookie(req: IncomingMessage): string {
  for (const part of req.headers.cookie?.split(';') ?? []) {
    const [k, v] = part.trim().split('=');
    if (k === COOKIE) return v ?? '';
  }
  return '';
}

/** The one auth check: the extension sends the token, and browsers send the login cookie. */
function authenticate(req: IncomingMessage, { token }: AppConfig): 'bearer' | 'cookie' | undefined {
  if (safeEqual(req.headers.authorization ?? '', `Bearer ${token}`)) return 'bearer';
  return safeEqual(readCookie(req), cookieValue(token)) ? 'cookie' : undefined;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** Stops keeping data past the limit but drains the rest, so the client can read the 413. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      else reject(new HttpError(413, 'Body too large'));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Returns undefined for an empty body, which is how methods without params are called. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  if (!body.length) return undefined;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

async function sendFile(res: ServerResponse, status: number, dir: string, file: string): Promise<void> {
  const body = await readFile(join(dir, file));
  res.writeHead(status, { 'content-type': CONTENT_TYPES[extname(file)]!, 'cache-control': 'no-cache' });
  res.end(body);
}

/** A page load without a login gets this as its 401, so there's no redirect or return address to handle. */
async function sendLogin(res: ServerResponse, status: number, dir: string, error = ''): Promise<void> {
  const html = await readFile(join(dir, 'login.html'), 'utf8');
  res.writeHead(status, { 'content-type': CONTENT_TYPES['.html']! });
  res.end(html.replace(LOGIN_ERROR_SLOT, error));
}

async function login(req: IncomingMessage, res: ServerResponse, config: AppConfig): Promise<void> {
  const body = await readBody(req);
  const token = new URLSearchParams(body.toString('utf8')).get('token')?.trim() ?? '';
  if (!safeEqual(token, config.token)) {
    await sendLogin(res, 401, config.publicDir, '<p class="error" role="alert">That token is not right.</p>');
    return;
  }
  res.writeHead(303, {
    location: '/',
    'set-cookie': `${COOKIE}=${cookieValue(config.token)}; Max-Age=${COOKIE_MAX_AGE_S}; Path=/; HttpOnly; SameSite=Strict; Secure`,
  });
  res.end();
}

async function route(req: IncomingMessage, res: ServerResponse, config: AppConfig): Promise<void> {
  const path = req.url?.split('?')[0] ?? '';
  const key = `${req.method} ${path}`;

  if (key === 'GET /healthz') {
    pingDb();
    send(res, 200, { ok: true });
    return;
  }

  if (key === 'POST /login') return login(req, res, config);
  if (key === 'GET /login') return sendLogin(res, 200, config.publicDir);
  if (key === 'GET /login.css') return sendFile(res, 200, config.publicDir, 'login.css');

  const auth = authenticate(req, config);
  const read = req.method === 'GET' || req.method === 'HEAD';
  if (!auth) {
    if (read && Object.hasOwn(PAGES, path)) return sendLogin(res, 401, config.publicDir);
    throw new HttpError(401, 'Unauthorized');
  }
  // Forwarded headers are not trusted, and SameSite covers cross-site reads.
  if (auth === 'cookie' && !read && req.headers.origin !== config.origin) {
    throw new HttpError(403, 'Bad origin');
  }

  const file = Object.hasOwn(PAGES, path) ? PAGES[path] : ASSETS.find((f) => path === `/${f}`);
  if (read && file) return sendFile(res, 200, config.publicDir, file);

  if (key === 'POST /api/seen') {
    if (ingestSeen(seenSchema.parse(await readJson(req)))) schedulePump();
    send(res, 200, { ok: true });
  } else if (key === 'POST /api/meta') {
    ingestMeta(metaSchema.parse(await readJson(req)));
    schedulePump();
    send(res, 200, { ok: true });
  } else if (key === 'GET /api/blockset') {
    const blockSet = getBlockSet();
    const etag = `"${blockSet.updatedAt}"`;
    if (req.headers['if-none-match'] === etag) res.writeHead(304, { etag }).end();
    else send(res, 200, blockSet, { etag });
  } else if (req.method === 'POST' && path.startsWith(RPC_PREFIX)) {
    const method = path.slice(RPC_PREFIX.length);
    if (!Object.hasOwn(rpcParams, method)) throw new HttpError(404, `Unknown method ${method}`);
    await callRpc(res, method as ServerRpcMethod, await readJson(req));
  } else {
    throw new HttpError(404, 'Not found');
  }
}

async function callRpc(res: ServerResponse, method: ServerRpcMethod, raw: unknown): Promise<void> {
  const params = rpcParams[method].parse(raw);
  try {
    send(res, 200, { ok: true, result: await handleRpc(method, params as never) });
  } catch (e) {
    send(res, 500, { ok: false, error: errorMessage(e) });
  }
}

function sendFailure(res: ServerResponse, e: unknown): void {
  if (e instanceof HttpError) {
    send(res, e.status, { ok: false, error: e.message }, e.status === 413 ? { connection: 'close' } : {});
  } else if (e instanceof z.ZodError) {
    send(res, 400, { ok: false, error: summarizeZodError(e) });
  } else {
    // /healthz has no auth, so unexpected errors never reach the response.
    console.error('[RedditHide] request failed', e);
    send(res, 500, { ok: false, error: 'Internal error' });
  }
}

export function createApp(config: AppConfig): Server {
  return createServer((req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    void route(req, res, config).catch((e) => sendFailure(res, e));
  });
}
