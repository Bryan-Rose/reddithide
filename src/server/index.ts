// Server entry point. Configured by SERVER_TOKEN, PUBLIC_ORIGIN, and optionally DB_PATH, HOST and PORT.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { errorMessage } from '../shared/util';
import { runBackup } from './backup';
import { publishBlockSet } from './blockset';
import { readConfig } from './config';
import { openDb } from './db';
import { createApp } from './http';
import { tick } from './pipeline';

const TICK_MS = 60_000;
const BACKUP_CHECK_MS = 60 * 60_000;

let config: ReturnType<typeof readConfig>;
try {
  config = readConfig(process.env);
} catch (e) {
  console.error(errorMessage(e));
  process.exit(1);
}

const dbPath = process.env.DB_PATH ?? 'data/reddithide.db';
const backupDir = join(dirname(dbPath), 'backups');
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);

// The database and backups hold API keys.
process.umask(0o077);
// As PID 1 in a container, Node would otherwise ignore these and docker stop would have to kill it.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));

mkdirSync(dirname(dbPath), { recursive: true });
openDb(dbPath);
publishBlockSet(true);

createApp({ ...config, publicDir: join(import.meta.dirname, 'public') }).listen(port, host, () =>
  console.info(`[RedditHide] listening on ${host}:${port}`),
);
tick();
setInterval(tick, TICK_MS);
runBackup(backupDir);
setInterval(() => runBackup(backupDir), BACKUP_CHECK_MS);
