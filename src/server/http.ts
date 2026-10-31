// HTTP API (SPEC §5.4). Every endpoint except /healthz goes through one auth check.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** #22 adds the login cookie here. Hashing gives equal lengths, which timingSafeEqual needs. */
function isAuthorized(req: IncomingMessage, token: string): boolean {
  return timingSafeEqual(sha256(req.headers.authorization ?? ''), sha256(`Bearer ${token}`));
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

async function route(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
  const path = req.url?.split('?')[0] ?? '';
  const key = `${req.method} ${path}`;

  if (key === 'GET /healthz') {
    pingDb();
    send(res, 200, { ok: true });
    return;
  }

  if (!isAuthorized(req, token)) throw new HttpError(401, 'Unauthorized');

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

export function createApp(token: string): Server {
  return createServer((req, res) => void route(req, res, token).catch((e) => sendFailure(res, e)));
}
