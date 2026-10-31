// Backups and restore against real database files, plus the settings the server refuses to start without.
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runBackup } from '../src/server/backup';
import { publishBlockSet } from '../src/server/blockset';
import { readConfig } from '../src/server/config';
import { addUsage, getAllRecords, getAllUsage, getKv, openDb, setKv, updateRecord } from '../src/server/db';
import { newRecord } from '../src/server/ingest';
import { getRuntime } from '../src/server/runtime';
import { BLOCKSET_KEY } from '../src/shared/settings';
import type { BlockSet } from '../src/shared/types';

const TOKEN = 'x'.repeat(32);
const ORIGIN = 'https://reddithide.example.ts.net';
const day = (d: number) => new Date(Date.UTC(2026, 9, d, 3));

let dir = '';
let backups = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reddithide-'));
  backups = join(dir, 'backups');
  openDb(join(dir, 'live.db'));
});
afterEach(() => {
  openDb(':memory:');
  rmSync(dir, { recursive: true });
});

describe('runBackup', () => {
  it('gives back identical data when restored onto an empty server', () => {
    updateRecord('pics', () => ({ ...newRecord('pics', 'Pics', 1), seenCount: 5 }));
    addUsage({ at: 1, profileId: 'p', model: 'm', inputTokens: 2, outputTokens: 3, ok: true });
    setKv('settings.example', { a: 1 });
    const before = { records: getAllRecords(), usage: getAllUsage() };

    runBackup(backups, day(31));

    const restored = join(dir, 'restored.db');
    openDb(restored);
    expect(getAllRecords()).toEqual([]);
    openDb(':memory:');
    copyFileSync(join(backups, 'reddithide-2026-10-31.db'), restored);
    openDb(restored);
    expect({ records: getAllRecords(), usage: getAllUsage() }).toEqual(before);
    expect(getKv('settings.example')).toEqual({ a: 1 });
  });

  it('gives a restored block set a newer updatedAt on start', () => {
    const backedUp = publishBlockSet();
    runBackup(backups, day(31));
    openDb(join(backups, 'reddithide-2026-10-31.db'));
    expect(publishBlockSet(true).updatedAt).toBeGreaterThan(backedUp.updatedAt);
    expect(getKv<BlockSet>(BLOCKSET_KEY)?.updatedAt).toBeGreaterThan(backedUp.updatedAt);
  });

  it('makes one copy a day and keeps the newest 7', () => {
    for (let d = 1; d <= 9; d++) runBackup(backups, day(d));
    runBackup(backups, day(9));
    expect(readdirSync(backups).sort()).toEqual(
      [3, 4, 5, 6, 7, 8, 9].map((d) => `reddithide-2026-10-0${d}.db`),
    );
  });

  it('replaces a partial copy left by a crash', () => {
    runBackup(backups, day(1));
    writeFileSync(join(backups, 'reddithide-2026-10-02.db.tmp'), 'partial');
    runBackup(backups, day(2));
    expect(readdirSync(backups).sort()).toEqual(['reddithide-2026-10-01.db', 'reddithide-2026-10-02.db']);
  });

  it('reports a failure and clears it after the next success', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(backups, 'a file where the folder should be');
    expect(() => runBackup(backups, day(1))).not.toThrow();
    expect(getRuntime().errors.map((e) => e.kind)).toEqual(['backup']);
    expect(error).toHaveBeenCalled();

    rmSync(backups);
    runBackup(backups, day(1));
    expect(existsSync(join(backups, 'reddithide-2026-10-01.db'))).toBe(true);
    expect(getRuntime().errors).toEqual([]);
    error.mockRestore();
  });
});

describe('readConfig', () => {
  it('accepts a long token and an origin', () => {
    expect(readConfig({ SERVER_TOKEN: TOKEN, PUBLIC_ORIGIN: ORIGIN })).toEqual({ token: TOKEN });
    expect(readConfig({ SERVER_TOKEN: TOKEN, PUBLIC_ORIGIN: 'http://localhost:8787' })).toBeTruthy();
  });

  it('refuses a missing or short token', () => {
    expect(() => readConfig({ PUBLIC_ORIGIN: ORIGIN })).toThrow('SERVER_TOKEN');
    expect(() => readConfig({ SERVER_TOKEN: 'x'.repeat(31), PUBLIC_ORIGIN: ORIGIN })).toThrow('SERVER_TOKEN');
  });

  it.each([undefined, '', 'reddithide.example.ts.net', `${ORIGIN}/`, `${ORIGIN}/path`])(
    'refuses PUBLIC_ORIGIN %s',
    (origin) => {
      expect(() => readConfig({ SERVER_TOKEN: TOKEN, PUBLIC_ORIGIN: origin })).toThrow('PUBLIC_ORIGIN');
    },
  );
});
