import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  assertBinding, bindingSchema, BridgeError, eventSchema, id, PROTOCOL_VERSION, resultSchema,
} from '../../packages/protocol/index.js';
import type { Binding, RelayEvent, WorkspaceIdentity } from '../../packages/protocol/index.js';
import { RpcPeer } from '../../packages/transport/index.js';
import { LocalHost } from '../local-host/index.js';
import { z } from 'zod';

export interface ClientOptions {
  url: string; token: string; workspace: WorkspaceIdentity; host: LocalHost;
  allowInsecureLoopback?: boolean; ca?: string | Buffer; resumeSession?: string;
  onEvent?: (event: RelayEvent) => void;
}
const receiptSchema = z.object({ turn_id: id, state: z.string(), created: z.boolean() }).strict();

export class BridgeClient {
  readonly peer: RpcPeer;
  binding?: Binding;
  runtime?: 'fake' | 'claude';
  private events = new Map<string, RelayEvent>();
  private waiters = new Map<string, { resolve: (event: RelayEvent) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }>();
  private connected = true;
  private constructor(private readonly options: ClientOptions, private readonly socket: WebSocket) {
    this.peer = new RpcPeer(socket);
    options.host.journal.storage.db.exec([
      'CREATE TABLE IF NOT EXISTS inbox (session_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL) STRICT;',
      'CREATE TABLE IF NOT EXISTS inbox_events (cursor INTEGER NOT NULL, session_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id, cursor)) STRICT;',
    ].join(' '));
    this.peer.handle('tool.execute', (raw) => options.host.execute(raw));
    this.peer.handle('operation.status', (raw) => {
      const request = z.object({ operation_id: id, session_id: id }).strict().parse(raw);
      const expected = this.binding?.session_id ?? options.resumeSession;
      if (request.session_id !== expected) throw new BridgeError('SESSION_NOT_FOUND', 'Operation query is for another session.');
      const row = options.host.journal.get(request.operation_id);
      if (!row || row.session_id !== request.session_id || !row.result) {
        throw new BridgeError('RECONCILIATION_REQUIRED', 'No durable local result is available yet.');
      }
      return resultSchema.parse(JSON.parse(row.result));
    });
    this.peer.handle('operation.cancel_turn', (raw) => {
      const request = z.object({ session_id: id, turn_id: id }).strict().parse(raw);
      if (request.session_id !== this.binding?.session_id) throw new BridgeError('SESSION_NOT_FOUND', 'Cancellation has the wrong binding.');
      options.host.cancelTurn(request.turn_id);
      return { cancel_requested: true };
    });
    this.peer.handle('event.emit', (raw) => this.receive(eventSchema.parse(raw)));
    socket.on('close', () => {
      this.connected = false; options.host.cancelAll();
      for (const waiter of this.waiters.values()) {
        clearTimeout(waiter.timer); waiter.reject(new BridgeError('WORKSPACE_OFFLINE', 'Disconnected; resume the explicit session and reconcile.'));
      }
      this.waiters.clear();
    });
  }
  static async connect(options: ClientOptions): Promise<BridgeClient> {
    const url = new URL(options.url);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/v1/bridge') {
      throw new BridgeError('INVALID_URL', 'Use a bridge URL without embedded credentials or query parameters.');
    }
    if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && options.allowInsecureLoopback &&
      ['127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new BridgeError('TLS_REQUIRED', 'Use WSS, or explicitly enable a numeric loopback URL for a local demo/SSH tunnel.');
    }
    const socket = new WebSocket(url, {
      headers: { Authorization: 'Bearer ' + options.token }, maxPayload: 1024 * 1024,
      perMessageDeflate: false, handshakeTimeout: 8000, ca: options.ca,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => { socket.off('error', reject); resolve(); });
      socket.once('error', reject);
    });
    const client = new BridgeClient(options, socket);
    try {
      const hello = z.object({
        protocol_version: z.literal(PROTOCOL_VERSION), runtime: z.enum(['fake', 'claude']),
        max_message_bytes: z.number().int().positive().max(1024 * 1024),
      }).strict().parse(await client.peer.request('connection.hello', {
        protocol_version: PROTOCOL_VERSION, device_id: options.workspace.device_id,
      }));
      client.runtime = hello.runtime;
      const binding = bindingSchema.parse(await client.peer.request(options.resumeSession ? 'session.resume' : 'session.create',
        options.resumeSession ? { ...options.workspace, session_id: options.resumeSession } : options.workspace));
      assertBinding(binding, { ...options.workspace, session_id: binding.session_id, worker_epoch: binding.worker_epoch });
      client.binding = binding;
      options.host.bind(binding);
      if (options.resumeSession) await client.replay();
      return client;
    } catch (error) { client.close(); throw error; }
  }
  private receive(event: RelayEvent): void {
    if (event.session_id !== this.binding?.session_id) throw new BridgeError('SESSION_NOT_FOUND', 'Event has the wrong session.');
    const db = this.options.host.journal.storage.db;
    const cursor = Number(db.prepare('SELECT cursor FROM inbox WHERE session_id=?').get(event.session_id)?.cursor ?? 0);
    if (event.cursor <= cursor) return;
    this.options.host.journal.storage.transaction(() => {
      db.prepare('INSERT INTO inbox_events VALUES (?, ?, ?)').run(event.cursor, event.session_id, JSON.stringify(event));
      db.prepare('INSERT INTO inbox VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET cursor=excluded.cursor')
        .run(event.session_id, event.cursor);
      db.exec('DELETE FROM inbox_events WHERE cursor NOT IN (SELECT cursor FROM inbox_events ORDER BY cursor DESC LIMIT 256)');
    });
    if (['completed', 'failed', 'cancelled'].includes(event.type)) {
      this.events.set(event.turn_id, event);
      if (this.events.size > 256) this.events.delete(this.events.keys().next().value!);
      const waiter = this.waiters.get(event.turn_id);
      if (waiter) { clearTimeout(waiter.timer); waiter.resolve(event); this.waiters.delete(event.turn_id); }
    }
    this.options.onEvent?.(event);
  }
  async replay(): Promise<void> {
    if (!this.binding) throw new BridgeError('SESSION_NOT_FOUND', 'Client is not bound.');
    let cursor = Number(this.options.host.journal.storage.db.prepare('SELECT cursor FROM inbox WHERE session_id=?')
      .get(this.binding.session_id)?.cursor ?? 0);
    while (true) {
      const batch = z.array(eventSchema).parse(await this.peer.request('events.resume', { session_id: this.binding.session_id, cursor }));
      if (!batch.length) return;
      for (const event of batch) this.receive(event);
      cursor = batch.at(-1)!.cursor;
    }
  }
  async submit(prompt: string, messageId: string = randomUUID()): Promise<{ turn_id: string; state: string; created: boolean }> {
    if (!this.binding) throw new BridgeError('SESSION_NOT_FOUND', 'Client is not bound.');
    return receiptSchema.parse(await this.peer.request('turn.submit', {
      session_id: this.binding.session_id, client_message_id: messageId, prompt,
    }));
  }
  waitTurn(turnId: string, timeoutMs = 120_000): Promise<RelayEvent> {
    const event = this.events.get(turnId);
    if (event) return Promise.resolve(event);
    if (!this.connected) return Promise.reject(new BridgeError('WORKSPACE_OFFLINE', 'Connection is closed.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(turnId);
        reject(new BridgeError('TURN_TIMEOUT', 'No final event received; do not resubmit automatically.'));
      }, timeoutMs);
      this.waiters.set(turnId, { resolve, reject, timer });
    });
  }
  async cancel(turnId: string): Promise<void> {
    this.options.host.cancelTurn(turnId);
    await this.peer.request('turn.cancel', { session_id: this.binding!.session_id, turn_id: turnId });
  }
  close(): void { this.options.host.cancelAll(); this.peer.close(); this.socket.terminate(); }
}
