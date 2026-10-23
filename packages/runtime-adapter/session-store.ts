import { randomUUID } from 'node:crypto';
import { BridgeError, digest } from '../protocol/index.js';
import type { Binding } from '../protocol/index.js';
import { StateDatabase } from '../storage/index.js';

interface SessionRow {
  runtime_id: string;
  binding_hash: string;
  initialized: number;
  state: string;
  epoch: number;
}
export class RuntimeSessionStore {
  private readonly storage: StateDatabase;
  constructor(path: string) {
    this.storage = new StateDatabase(path);
    this.storage.db.exec(
      [
        'CREATE TABLE IF NOT EXISTS runtime_sessions (session_id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL UNIQUE,',
        'binding_hash TEXT NOT NULL, initialized INTEGER NOT NULL, state TEXT NOT NULL, epoch INTEGER NOT NULL) STRICT;',
        "UPDATE runtime_sessions SET state='INTERRUPTED' WHERE state='RUNNING';",
      ].join(' '),
    );
  }
  begin(binding: Binding): { runtimeId: string; resume: boolean } {
    return this.storage.transaction(() => {
      const { worker_epoch: _epoch, ...identity } = binding;
      const hash = digest(identity);
      const row = this.storage.db
        .prepare('SELECT * FROM runtime_sessions WHERE session_id=?')
        .get(binding.session_id) as unknown as SessionRow | undefined;
      if (row) {
        if (row.binding_hash !== hash || binding.worker_epoch < row.epoch)
          throw new BridgeError('WORKSPACE_MISMATCH', 'Runtime session binding changed.');
        if (row.state === 'RUNNING')
          throw new BridgeError('SESSION_BUSY', 'Runtime session is already running.');
        if (!row.initialized)
          throw new BridgeError(
            'RUNTIME_RECONCILIATION_REQUIRED',
            'Earlier runtime startup was not confirmed. Inspect the transcript before starting a new bridge session.',
          );
        if (row.state === 'INTERRUPTED' && binding.worker_epoch <= row.epoch)
          throw new BridgeError(
            'RUNTIME_RECONCILIATION_REQUIRED',
            'Interrupted runtime requires explicit session reconnect and tool reconciliation.',
          );
        this.storage.db
          .prepare("UPDATE runtime_sessions SET state='RUNNING', epoch=? WHERE session_id=?")
          .run(binding.worker_epoch, binding.session_id);
        return { runtimeId: row.runtime_id, resume: true };
      }
      if (
        Number(this.storage.db.prepare('SELECT count(*) AS n FROM runtime_sessions').get()!.n) >=
        128
      )
        throw new BridgeError('RESOURCE_LIMIT', 'Runtime session limit reached.');
      const runtimeId = randomUUID();
      this.storage.db
        .prepare('INSERT INTO runtime_sessions VALUES (?, ?, ?, 0, ?, ?)')
        .run(binding.session_id, runtimeId, hash, 'RUNNING', binding.worker_epoch);
      return { runtimeId, resume: false };
    });
  }
  initialized(sessionId: string): void {
    this.storage.db
      .prepare("UPDATE runtime_sessions SET initialized=1 WHERE session_id=? AND state='RUNNING'")
      .run(sessionId);
  }
  finish(sessionId: string, success: boolean): void {
    this.storage.db
      .prepare('UPDATE runtime_sessions SET state=? WHERE session_id=?')
      .run(success ? 'READY' : 'INTERRUPTED', sessionId);
  }
  close(): void {
    this.storage.close();
  }
}
