import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { StateDatabase } from '../storage/index.js';
import { bindingSchema, BridgeError, digest, id, workspaceSchema } from '../protocol/index.js';
import type {
  Binding,
  Operation,
  OperationResult,
  RelayEvent,
  SessionSummary,
  WorkspaceIdentity,
} from '../protocol/index.js';

export class RelayStore {
  private readonly storage: StateDatabase;
  constructor(path: string) {
    this.storage = new StateDatabase(path);
    this.storage.db.exec(
      [
        'CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, hash TEXT NOT NULL, revoked INTEGER NOT NULL) STRICT;',
        'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, binding TEXT NOT NULL) STRICT;',
        'CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, client_id TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL, UNIQUE(session_id, client_id)) STRICT;',
        'CREATE TABLE IF NOT EXISTS dispatches (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, request TEXT NOT NULL, result TEXT) STRICT;',
        'CREATE TABLE IF NOT EXISTS events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, payload TEXT NOT NULL) STRICT;',
        'CREATE TABLE IF NOT EXISTS event_retention (session_id TEXT PRIMARY KEY, removed_through INTEGER NOT NULL) STRICT;',
        "UPDATE turns SET state='INTERRUPTED' WHERE state='RUNNING';",
      ].join('\n'),
    );
  }
  provision(deviceId: string = randomUUID()): { device_id: string; token: string } {
    id.parse(deviceId);
    const secret = randomBytes(32).toString('base64url');
    this.storage.db
      .prepare('INSERT INTO devices VALUES (?, ?, 0)')
      .run(deviceId, createHash('sha256').update(secret).digest('hex'));
    return { device_id: deviceId, token: deviceId + '.' + secret };
  }
  authenticate(header: string | undefined): string | undefined {
    const parts = /^Bearer ([a-zA-Z0-9_-]{1,128})\.([a-zA-Z0-9_-]{43})$/.exec(header ?? '');
    if (!parts) return;
    const row = this.storage.db
      .prepare('SELECT hash FROM devices WHERE id=? AND revoked=0')
      .get(parts[1]!);
    const actual = createHash('sha256').update(parts[2]!).digest();
    const expected = row ? Buffer.from(String(row.hash), 'hex') : Buffer.alloc(32);
    return timingSafeEqual(actual, expected) && row ? parts[1] : undefined;
  }
  isActive(device: string): boolean {
    return !!this.storage.db.prepare('SELECT id FROM devices WHERE id=? AND revoked=0').get(device);
  }
  revoke(device: string): void {
    this.storage.db.prepare('UPDATE devices SET revoked=1 WHERE id=?').run(device);
  }
  create(workspace: WorkspaceIdentity): Binding {
    if (Number(this.storage.db.prepare('SELECT count(*) AS n FROM sessions').get()!.n) >= 128) {
      throw new BridgeError(
        'RESOURCE_LIMIT',
        'Session limit reached; archive state deliberately before continuing.',
      );
    }
    const binding: Binding = { ...workspace, session_id: randomUUID(), worker_epoch: 1 };
    this.storage.db
      .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
      .run(binding.session_id, binding.device_id, JSON.stringify(binding));
    return binding;
  }
  session(sessionId: string, device: string): Binding {
    const row = this.storage.db
      .prepare('SELECT binding FROM sessions WHERE id=? AND device_id=?')
      .get(sessionId, device);
    if (!row)
      throw new BridgeError('SESSION_NOT_FOUND', 'Session is not available to this device.');
    return bindingSchema.parse(JSON.parse(String(row.binding)));
  }
  sessions(workspace: WorkspaceIdentity): Omit<SessionSummary, 'connected'>[] {
    return this.storage.db
      .prepare(
        [
          'SELECT s.binding,',
          "COALESCE((SELECT state FROM turns WHERE session_id=s.id ORDER BY rowid DESC LIMIT 1), 'NEW') AS latest_turn_state,",
          "(SELECT count(*) FROM dispatches WHERE session_id=s.id AND (result IS NULL OR json_extract(result, '$.status')='UNKNOWN')) AS unresolved_operations",
          'FROM sessions s WHERE s.device_id=? ORDER BY s.rowid DESC LIMIT 128',
        ].join(' '),
      )
      .all(workspace.device_id)
      .flatMap((row) => {
        const binding = bindingSchema.parse(JSON.parse(String(row.binding)));
        if (
          (Object.keys(workspaceSchema.shape) as (keyof WorkspaceIdentity)[]).some(
            (key) => binding[key] !== workspace[key],
          )
        )
          return [];
        return [
          {
            session_id: binding.session_id,
            worker_epoch: binding.worker_epoch,
            latest_turn_state: row.latest_turn_state as SessionSummary['latest_turn_state'],
            unresolved_operations: Number(row.unresolved_operations),
          },
        ];
      });
  }
  bump(binding: Binding): Binding {
    const next = { ...binding, worker_epoch: binding.worker_epoch + 1 };
    this.storage.db
      .prepare('UPDATE sessions SET binding=? WHERE id=?')
      .run(JSON.stringify(next), binding.session_id);
    return next;
  }
  turn(
    sessionId: string,
    clientId: string,
    prompt: string,
  ): { turn_id: string; state: string; created: boolean } {
    return this.storage.transaction(() => {
      const old = this.storage.db
        .prepare('SELECT * FROM turns WHERE session_id=? AND client_id=?')
        .get(sessionId, clientId);
      if (old) {
        if (old.digest !== digest(prompt))
          throw new BridgeError(
            'MESSAGE_CONFLICT',
            'client_message_id was reused with different content.',
          );
        return { turn_id: String(old.id), state: String(old.state), created: false };
      }
      if (Number(this.storage.db.prepare('SELECT count(*) AS n FROM turns').get()!.n) >= 10_000) {
        throw new BridgeError('RESOURCE_LIMIT', 'Turn journal limit reached.');
      }
      const turnId = randomUUID();
      this.storage.db
        .prepare('INSERT INTO turns VALUES (?, ?, ?, ?, ?)')
        .run(turnId, sessionId, clientId, digest(prompt), 'RUNNING');
      return { turn_id: turnId, state: 'RUNNING', created: true };
    });
  }
  finishTurn(turnId: string, state: string): void {
    this.storage.db.prepare('UPDATE turns SET state=? WHERE id=?').run(state, turnId);
  }
  dispatch(operation: Operation): void {
    if (
      Number(this.storage.db.prepare('SELECT count(*) AS n FROM dispatches').get()!.n) >= 10_000
    ) {
      throw new BridgeError(
        'RESOURCE_LIMIT',
        'Dispatch journal is full; inspect/archive state before continuing.',
      );
    }
    this.storage.db
      .prepare('INSERT INTO dispatches VALUES (?, ?, ?, NULL)')
      .run(operation.operation_id, operation.session_id, JSON.stringify(operation));
  }
  result(result: OperationResult): void {
    this.storage.db
      .prepare('UPDATE dispatches SET result=? WHERE id=? AND result IS NULL')
      .run(JSON.stringify(result), result.operation_id);
  }
  pending(sessionId: string): Operation[] {
    return this.storage.db
      .prepare(
        "SELECT request FROM dispatches WHERE session_id=? AND (result IS NULL OR json_extract(result, '$.status')='UNKNOWN')",
      )
      .all(sessionId)
      .map((row) => JSON.parse(String(row.request)) as Operation);
  }
  event(event: Omit<RelayEvent, 'cursor'>): RelayEvent {
    return this.storage.transaction(() => {
      const encoded = JSON.stringify(event);
      if (Buffer.byteLength(encoded) > 256 * 1024)
        throw new BridgeError('RESOURCE_LIMIT', 'Event exceeds limit.');
      const inserted = this.storage.db
        .prepare('INSERT INTO events(session_id, payload) VALUES (?, ?)')
        .run(event.session_id, encoded);
      const removed = this.storage.db
        .prepare(
          [
            'DELETE FROM events WHERE cursor NOT IN (SELECT cursor FROM events ORDER BY cursor DESC LIMIT 512)',
            'OR (session_id=? AND cursor NOT IN (SELECT cursor FROM events WHERE session_id=? ORDER BY cursor DESC LIMIT 256))',
            'RETURNING session_id, cursor',
          ].join(' '),
        )
        .all(event.session_id, event.session_id);
      for (const row of removed) {
        this.storage.db
          .prepare(
            [
              'INSERT INTO event_retention VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET',
              'removed_through=max(removed_through, excluded.removed_through)',
            ].join(' '),
          )
          .run(row.session_id!, row.cursor!);
      }
      return { ...event, cursor: Number(inserted.lastInsertRowid) };
    });
  }
  events(sessionId: string, cursor: number): RelayEvent[] {
    const rows = this.storage.db
      .prepare('SELECT * FROM events WHERE session_id=? ORDER BY cursor')
      .all(sessionId);
    const removedThrough = Number(
      this.storage.db
        .prepare('SELECT removed_through FROM event_retention WHERE session_id=?')
        .get(sessionId)?.removed_through ?? 0,
    );
    if (cursor > 0 && cursor < removedThrough) {
      throw new BridgeError(
        'CURSOR_EXPIRED',
        'Older events have expired; request a fresh retained history.',
      );
    }
    // One page is bounded below the RPC frame cap.
    let bytes = 0;
    return rows
      .filter((row) => Number(row.cursor) > cursor)
      .filter((row) => {
        bytes += Buffer.byteLength(String(row.payload));
        return bytes <= 512 * 1024;
      })
      .map(
        (row) => ({ ...JSON.parse(String(row.payload)), cursor: Number(row.cursor) }) as RelayEvent,
      );
  }
  close(): void {
    this.storage.close();
  }
}
