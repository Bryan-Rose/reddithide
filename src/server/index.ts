// Server entry point. Configured by SERVER_TOKEN, and optionally DB_PATH, HOST and PORT.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { publishBlockSet } from './blockset';
import { openDb } from './db';
import { createApp } from './http';
import { tick } from './pipeline';

const MIN_TOKEN_LENGTH = 32;
const TICK_MS = 60_000;

const token = process.env.SERVER_TOKEN ?? '';
if (token.length < MIN_TOKEN_LENGTH) {
  console.error(`SERVER_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters long.`);
  process.exit(1);
}

const dbPath = process.env.DB_PATH ?? 'data/reddithide.db';
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);

mkdirSync(dirname(dbPath), { recursive: true });
openDb(dbPath);
publishBlockSet(true);

createApp(token).listen(port, host, () => console.info(`[RedditHide] listening on ${host}:${port}`));
tick();
setInterval(tick, TICK_MS);
