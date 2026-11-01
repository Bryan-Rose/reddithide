// Nightly copies of the database (SPEC §4).
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage } from '../shared/util';
import { vacuumInto } from './db';
import { clearErrors, reportError } from './runtime';

const KEEP = 7;
const BACKUP_NAME = /^reddithide-\d{4}-\d{2}-\d{2}\.db$/;

/** Makes the copy for this UTC day unless it exists, so a server that was down catches up. */
export function runBackup(dir: string, now = new Date()): void {
  const file = join(dir, `reddithide-${now.toISOString().slice(0, 10)}.db`);
  if (existsSync(file)) return;
  // Written under another name so a crash can't leave a partial copy that looks finished.
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    rmSync(tmp, { force: true });
    vacuumInto(tmp);
    renameSync(tmp, file);
    const backups = readdirSync(dir).filter((name) => BACKUP_NAME.test(name));
    for (const old of backups.sort().slice(0, -KEEP)) rmSync(join(dir, old));
    clearErrors(['backup']);
  } catch (e) {
    console.error('[RedditHide] backup failed', e);
    // A partial copy would hold space the database needs, and backups share its disk.
    attempt(() => rmSync(tmp, { force: true }));
    attempt(() => reportError('backup', `Backup failed: ${errorMessage(e)}`));
  }
}

/** On a full disk these fail too. Backups run on a timer, so throwing would stop the server. */
function attempt(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.error('[RedditHide] backup cleanup failed', e);
  }
}
