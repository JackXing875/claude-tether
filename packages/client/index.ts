import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  assertBinding,
  bindingSchema,
  BridgeError,
  eventSchema,
  id,
  PROTOCOL_VERSION,
  resultSchema,
  sessionSummarySchema,
} from '../protocol/index.js';
import type { Binding, RelayEvent, SessionSummary, WorkspaceIdentity } from '../protocol/index.js';
import { RpcPeer } from '../transport/index.js';
import { LocalHost } from '../local-host/index.js';
import { z } from 'zod';

export interface SessionListOptions {
  url: string;
  token: string;
  workspace: WorkspaceIdentity;
  allowInsecureLoopback?: boolean;
  ca?: string | Buffer;
}
export interface ClientOptions extends SessionListOptions {
  host: LocalHost;
  resumeSession?: string;
  onEvent?: (event: RelayEvent) => void;
}
const receiptSchema = z.object({ turn_id: id, state: z.string(), created: z.boolean() }).strict();
const helloResponseSchema = z
  .object({
    protocol_version: z.literal(PROTOCOL_VERSION),
    runtime: z.enum(['fake', 'claude']),
    max_message_bytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024),
  })
  .strict();

async function openSocket(options: SessionListOptions): Promise<WebSocket> {
  const url = new URL(options.url);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/v1/bridge') {
    throw new BridgeError(
      'INVALID_URL',
      'Use a bridge URL without embedded credentials or query parameters.',
    );
  }
  if (
    url.protocol !== 'wss:' &&
    !(
      url.protocol === 'ws:' &&
      options.allowInsecureLoopback &&
      ['127.0.0.1', '[::1]'].includes(url.hostname)
    )
  ) {
    throw new BridgeError(
      'TLS_REQUIRED',
      'Use WSS, or explicitly enable a numeric loopback URL for a local demo/SSH tunnel.',
    );
  }
  const socket = new WebSocket(url, {
    headers: { Authorization: 'Bearer ' + options.token },
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
    handshakeTimeout: 8000,
    ca: options.ca,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      socket.off('error', reject);
      resolve();
    });
    socket.once('error', reject);
  });
  return socket;
}

async function hello(peer: RpcPeer, deviceId: string) {
  return helloResponseSchema.parse(
    await peer.request('connection.hello', {
      protocol_version: PROTOCOL_VERSION,
      device_id: deviceId,
    }),
  );
}
interface TurnWaiter {
  resolve: (event: RelayEvent) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

export class BridgeClient {
  readonly peer: RpcPeer;
  binding?: Binding;
  runtime?: 'fake' | 'claude';
  private events = new Map<string, RelayEvent>();
  private waiters = new Map<string, Set<TurnWaiter>>();
  private connected = true;
  private constructor(
    private readonly options: ClientOptions,
    private readonly socket: WebSocket,
  ) {
    this.peer = new RpcPeer(socket);
    this.peer.handle('tool.execute', (raw) => options.host.execute(raw));
    this.peer.handle('operation.status', (raw) => {
      const request = z.object({ operation_id: id, session_id: id }).strict().parse(raw);
      const expected = this.binding?.session_id ?? options.resumeSession;
      if (request.session_id !== expected)
        throw new BridgeError('SESSION_NOT_FOUND', 'Operation query is for another session.');
      const row = options.host.journal.get(request.operation_id);
      if (!row || row.session_id !== request.session_id || !row.result) {
        throw new BridgeError(
          'RECONCILIATION_REQUIRED',
          'No durable local result is available yet.',
        );
      }
      return resultSchema.parse(JSON.parse(row.result));
    });
    this.peer.handle('operation.cancel_turn', (raw) => {
      const request = z.object({ session_id: id, turn_id: id }).strict().parse(raw);
      if (request.session_id !== this.binding?.session_id)
        throw new BridgeError('SESSION_NOT_FOUND', 'Cancellation has the wrong binding.');
      options.host.cancelTurn(request.turn_id);
      return { cancel_requested: true };
    });
    this.peer.handle('event.emit', (raw) => this.receive(eventSchema.parse(raw)));
    socket.on('close', () => this.disconnect());
    socket.on('error', () => this.disconnect());
  }
  private disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.options.host.cancelAll();
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(
          new BridgeError(
            'WORKSPACE_OFFLINE',
            'Disconnected; resume the explicit session and reconcile.',
          ),
        );
      }
    }
    this.waiters.clear();
  }
  static async connect(options: ClientOptions): Promise<BridgeClient> {
    const socket = await openSocket(options);
    const client = new BridgeClient(options, socket);
    try {
      client.runtime = (await hello(client.peer, options.workspace.device_id)).runtime;
      const binding = bindingSchema.parse(
        await client.peer.request(
          options.resumeSession ? 'session.resume' : 'session.create',
          options.resumeSession
            ? { ...options.workspace, session_id: options.resumeSession }
            : options.workspace,
        ),
      );
      assertBinding(binding, {
        ...options.workspace,
        session_id: binding.session_id,
        worker_epoch: binding.worker_epoch,
      });
      client.binding = binding;
      options.host.bind(binding);
      if (options.resumeSession) await client.replay();
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }
  /** Query this exact workspace without binding a host, creating a session or running tools. */
  static async listSessions(options: SessionListOptions): Promise<SessionSummary[]> {
    const socket = await openSocket(options);
    const peer = new RpcPeer(socket);
    try {
      await hello(peer, options.workspace.device_id);
      return z
        .array(sessionSummarySchema)
        .max(128)
        .parse(await peer.request('session.list', options.workspace));
    } finally {
      peer.close();
      socket.terminate();
    }
  }
  private receive(event: RelayEvent): void {
    if (event.session_id !== this.binding?.session_id)
      throw new BridgeError('SESSION_NOT_FOUND', 'Event has the wrong session.');
    if (!this.options.host.journal.recordEvent(event)) return;
    if (['completed', 'failed', 'cancelled'].includes(event.type)) {
      this.events.set(event.turn_id, event);
      if (this.events.size > 256) this.events.delete(this.events.keys().next().value!);
      const waiters = this.waiters.get(event.turn_id);
      if (waiters) {
        this.waiters.delete(event.turn_id);
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(event);
        }
      }
    }
    this.options.onEvent?.(event);
  }
  async replay(): Promise<void> {
    if (!this.binding) throw new BridgeError('SESSION_NOT_FOUND', 'Client is not bound.');
    let cursor = this.options.host.journal.cursor(this.binding.session_id);
    while (true) {
      const batch = z
        .array(eventSchema)
        .parse(
          await this.peer.request('events.resume', { session_id: this.binding.session_id, cursor }),
        );
      if (!batch.length) return;
      for (const event of batch) this.receive(event);
      cursor = batch.at(-1)!.cursor;
    }
  }
  async submit(
    prompt: string,
    messageId: string = randomUUID(),
  ): Promise<{ turn_id: string; state: string; created: boolean }> {
    if (!this.binding) throw new BridgeError('SESSION_NOT_FOUND', 'Client is not bound.');
    return receiptSchema.parse(
      await this.peer.request('turn.submit', {
        session_id: this.binding.session_id,
        client_message_id: messageId,
        prompt,
      }),
    );
  }
  waitTurn(turnId: string, timeoutMs = 120_000): Promise<RelayEvent> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
      return Promise.reject(
        new BridgeError(
          'INVALID_ARGUMENT',
          'Turn wait timeout must be an integer from 1 to 2147483647 milliseconds.',
        ),
      );
    const event =
      this.events.get(turnId) ??
      (this.binding &&
        this.options.host.journal
          .events(this.binding.session_id)
          .find(
            (entry) =>
              entry.turn_id === turnId && ['completed', 'failed', 'cancelled'].includes(entry.type),
          ));
    if (event) return Promise.resolve(event);
    if (!this.connected)
      return Promise.reject(new BridgeError('WORKSPACE_OFFLINE', 'Connection is closed.'));
    if ([...this.waiters.values()].reduce((count, waiters) => count + waiters.size, 0) >= 64)
      return Promise.reject(new BridgeError('RESOURCE_LIMIT', 'Too many outstanding turn waits.'));
    const waiters = this.waiters.get(turnId) ?? new Set<TurnWaiter>();
    this.waiters.set(turnId, waiters);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        if (!waiters.size) this.waiters.delete(turnId);
        reject(
          new BridgeError(
            'TURN_TIMEOUT',
            'No final event received; do not resubmit automatically.',
          ),
        );
      }, timeoutMs);
      const waiter = { resolve, reject, timer };
      waiters.add(waiter);
    });
  }
  async cancel(turnId: string): Promise<void> {
    this.options.host.cancelTurn(turnId);
    await this.peer.request('turn.cancel', {
      session_id: this.binding!.session_id,
      turn_id: turnId,
    });
  }
  close(): void {
    this.disconnect();
    this.peer.close();
    this.socket.terminate();
  }
}
