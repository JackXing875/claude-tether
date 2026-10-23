import { DatabaseSync } from 'node:sqlite';
import { chmodSync, lstatSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { BridgeError } from '../protocol/index.js';

/** One live process per state database, enforced by a separate SQLite lease.
 * OS locks disappear after a crash; operation rows are recovered separately.
 */
export class StateDatabase {
  readonly db: DatabaseSync;
  private lease?: DatabaseSync;
  private closed = false;
  constructor(path: string) {
    if (path !== ':memory:') {
      const parent = dirname(path);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      const st = lstatSync(parent);
      if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0) {
        throw new BridgeError('STATE_PERMISSIONS', 'State directory must be private (0700).');
      }
      for (const target of [path, path + '.lease']) {
        try {
          closeSync(openSync(target, 'wx', 0o600));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
        if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) {
          throw new BridgeError('STATE_PERMISSIONS', 'State database must be a regular file.');
        }
        chmodSync(target, 0o600);
      }
      this.lease = new DatabaseSync(path + '.lease');
      try {
        this.lease.exec('BEGIN EXCLUSIVE');
      } catch {
        this.lease.close();
        throw new BridgeError('STATE_IN_USE', 'Another process already owns this state database.');
      }
    }
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;',
    );
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    this.lease?.exec('ROLLBACK');
    this.lease?.close();
  }
}
