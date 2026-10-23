import { BridgeError, digest } from '../protocol/index.js';
import type { Operation, OperationResult, OperationState } from '../protocol/index.js';
import { StateDatabase } from '../storage/index.js';

interface Row { operation_id: string; session_id: string; digest: string; state: OperationState; result: string | null; request: string | null }
export class OperationJournal {
  readonly storage: StateDatabase;
  constructor(path: string) {
    this.storage = new StateDatabase(path);
    this.storage.db.exec([
      'CREATE TABLE IF NOT EXISTS operations (operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,',
      'digest TEXT NOT NULL, state TEXT NOT NULL, result TEXT, updated_at INTEGER NOT NULL) STRICT;',
      'CREATE INDEX IF NOT EXISTS operation_session ON operations(session_id, state);',
    ].join(' '));
    if (!this.storage.db.prepare('PRAGMA table_info(operations)').all().some((column) => column.name === 'request')) {
      this.storage.db.exec('ALTER TABLE operations ADD COLUMN request TEXT');
    }
    const interrupted = this.storage.db.prepare("SELECT operation_id FROM operations WHERE result IS NULL").all();
    for (const row of interrupted) {
      this.finish({
        operation_id: String(row.operation_id), status: 'UNKNOWN',
        error: { code: 'OUTCOME_UNKNOWN', message: 'Executor restarted before a durable result. Inspect effects; do not replay.' },
      });
    }
  }
  accept(operation: Operation): OperationResult | undefined {
    return this.storage.transaction(() => {
      const existing = this.get(operation.operation_id);
      const inputDigest = digest(operation);
      if (existing) {
        if (existing.digest !== inputDigest) throw new BridgeError('OPERATION_CONFLICT', 'Operation ID was already used for different parameters or binding.');
        if (existing.result) return JSON.parse(existing.result) as OperationResult;
        throw new BridgeError('OPERATION_IN_PROGRESS', 'The original operation is still running.');
      }
      if (Number(this.storage.db.prepare('SELECT count(*) AS n FROM operations').get()!.n) >= 10_000) {
        throw new BridgeError('RESOURCE_LIMIT', 'Operation journal is full. Archive deliberately; never evict deduplication IDs automatically.');
      }
      this.storage.db.prepare('INSERT INTO operations(operation_id, session_id, digest, state, result, updated_at, request) VALUES (?, ?, ?, ?, NULL, ?, ?)').run(
        operation.operation_id, operation.session_id, inputDigest, 'RECEIVED', Date.now(), JSON.stringify(operation));
      return undefined;
    });
  }
  get(operationId: string): Row | undefined {
    return this.storage.db.prepare('SELECT * FROM operations WHERE operation_id=?').get(operationId) as unknown as Row | undefined;
  }
  setState(operationId: string, state: OperationState): void {
    const changed = this.storage.db.prepare('UPDATE operations SET state=?, updated_at=? WHERE operation_id=? AND result IS NULL')
      .run(state, Date.now(), operationId);
    if (changed.changes !== 1) throw new BridgeError('INVALID_STATE', 'Operation is already terminal or unknown.');
  }
  finish(result: OperationResult): void {
    const changed = this.storage.db.prepare('UPDATE operations SET state=?, result=?, updated_at=? WHERE operation_id=? AND result IS NULL')
      .run(result.status, JSON.stringify(result), Date.now(), result.operation_id);
    if (changed.changes !== 1) throw new BridgeError('INVALID_STATE', 'A durable operation result cannot be replaced.');
  }
  uncertain(sessionId: string): string[] {
    return this.storage.db.prepare("SELECT operation_id FROM operations WHERE session_id=? AND state='UNKNOWN'")
      .all(sessionId).map((row) => String(row.operation_id));
  }
  hasUncertain(): boolean {
    return this.storage.db.prepare("SELECT 1 FROM operations WHERE state='UNKNOWN' LIMIT 1").get() !== undefined;
  }
  close(): void { this.storage.close(); }
}
