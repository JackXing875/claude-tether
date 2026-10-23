import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import {
  BridgeError,
  createSessionSchema,
  helloSchema,
  MAX_MESSAGE_BYTES,
  resultSchema,
  sessionIdSchema,
  submitSchema,
  turnIdSchema,
  workspaceSchema,
  PROTOCOL_VERSION,
  failure,
} from '../protocol/index.js';
import type { Binding, Operation, RelayEvent } from '../protocol/index.js';
import { RpcPeer } from '../transport/index.js';
import { FakeAgent } from '../runtime-adapter/fake.js';
import type { AgentRuntime } from '../runtime-adapter/types.js';
import { RelayStore } from './store.js';

interface Connection {
  device: string;
  peer: RpcPeer;
  socket: WebSocket;
  session?: Binding;
  hello: boolean;
}
export interface RelayOptions {
  statePath: string;
  runtime?: AgentRuntime;
  tls?: { cert: string | Buffer; key: string | Buffer };
}

export class RelayServer {
  readonly store: RelayStore;
  private readonly runtime: AgentRuntime;
  private readonly http;
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  private readonly connections = new Set<Connection>();
  private active?: {
    turn: string;
    session: string;
    connection: Connection;
    controller: AbortController;
    done: Promise<void>;
  };
  private readonly heartbeat: NodeJS.Timeout;
  private closing?: Promise<void>;
  constructor(private readonly options: RelayOptions) {
    this.store = new RelayStore(options.statePath);
    this.runtime = options.runtime ?? new FakeAgent();
    this.http = options.tls ? createTlsServer(options.tls) : createServer();
    this.http.on('request', (req, res) => {
      if (req.method === 'GET' && req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    this.http.on('upgrade', (req, socket, head) => {
      const device = this.store.authenticate(req.headers.authorization);
      // No browser interface in P1; reject Origins to avoid ambient browser access.
      if (
        req.url !== '/v1/bridge' ||
        !device ||
        req.headers.origin ||
        this.connections.size >= 16
      ) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws, device));
    });
    this.heartbeat = setInterval(() => {
      for (const connection of this.connections) {
        if (!this.store.isActive(connection.device))
          connection.socket.close(1008, 'Device revoked');
        else connection.socket.ping();
      }
    }, 15_000);
    this.heartbeat.unref();
  }
  async listen(port = 0, host = '127.0.0.1'): Promise<string> {
    if (!this.options.tls && !['127.0.0.1', '::1'].includes(host)) {
      throw new BridgeError('TLS_REQUIRED', 'Plain WebSocket binding is restricted to loopback.');
    }
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(port, host, () => {
        this.http.off('error', reject);
        resolve();
      });
    });
    const address = this.http.address();
    if (!address || typeof address === 'string') throw new Error('Invalid listening address');
    return (
      (this.options.tls ? 'wss://' : 'ws://') +
      (host.includes(':') ? '[' + host + ']' : host) +
      ':' +
      address.port +
      '/v1/bridge'
    );
  }
  private connect(socket: WebSocket, device: string): void {
    const peer = new RpcPeer(socket);
    const connection: Connection = { device, peer, socket, hello: false };
    this.connections.add(connection);
    const helloTimeout = setTimeout(() => socket.close(1008, 'Hello required'), 5000);
    let lastPong = Date.now();
    socket.on('pong', () => {
      lastPong = Date.now();
    });
    const watchdog = setInterval(() => {
      if (Date.now() - lastPong > 45_000) socket.terminate();
    }, 15_000);
    watchdog.unref();
    const handle = (name: string, fn: (raw: unknown) => unknown) =>
      peer.handle(name, (raw) => {
        if (!this.store.isActive(device))
          throw new BridgeError('DEVICE_REVOKED', 'Device is revoked.');
        if (!connection.hello)
          throw new BridgeError('PROTOCOL_MISMATCH', 'Complete connection.hello first.');
        return fn(raw);
      });
    peer.handle('connection.hello', (raw) => {
      const value = helloSchema.safeParse(raw);
      if (!value.success)
        throw new BridgeError(
          'PROTOCOL_MISMATCH',
          'Unsupported protocol version or hello payload.',
        );
      if (connection.hello || value.data.device_id !== device)
        throw new BridgeError(
          'DEVICE_MISMATCH',
          'Device does not match the authenticated connection.',
        );
      connection.hello = true;
      clearTimeout(helloTimeout);
      return {
        protocol_version: PROTOCOL_VERSION,
        runtime: this.runtime.kind,
        max_message_bytes: MAX_MESSAGE_BYTES,
      };
    });
    handle('session.create', (raw) => {
      if (connection.session)
        throw new BridgeError('SESSION_BUSY', 'This connection is already bound.');
      const workspace = createSessionSchema.parse(raw);
      if (workspace.device_id !== device)
        throw new BridgeError('DEVICE_MISMATCH', 'Device binding differs.');
      connection.session = this.store.create(workspace);
      return connection.session;
    });
    handle('session.list', (raw) => {
      const workspace = workspaceSchema.parse(raw);
      if (workspace.device_id !== device)
        throw new BridgeError('DEVICE_MISMATCH', 'Device binding differs.');
      return this.store.sessions(workspace).map((session) => ({
        ...session,
        connected: [...this.connections].some(
          (other) => other.session?.session_id === session.session_id,
        ),
      }));
    });
    handle('session.resume', async (raw) => {
      if (connection.session)
        throw new BridgeError('SESSION_BUSY', 'This connection is already bound.');
      const request = workspaceSchema
        .extend({ session_id: sessionIdSchema.shape.session_id })
        .strict()
        .parse(raw);
      let binding = this.store.session(request.session_id, device);
      for (const key of Object.keys(
        workspaceSchema.shape,
      ) as (keyof typeof workspaceSchema.shape)[]) {
        if (binding[key] !== request[key])
          throw new BridgeError(
            'WORKSPACE_MISMATCH',
            'Resume requires the original device and workspace.',
          );
      }
      if (
        [...this.connections].some(
          (other) => other !== connection && other.session?.session_id === binding.session_id,
        )
      ) {
        throw new BridgeError('SESSION_BUSY', 'Another connection owns this session.');
      }
      if (this.active?.session === binding.session_id)
        throw new BridgeError('SESSION_BUSY', 'Previous turn is still stopping.');
      for (const operation of this.store.pending(binding.session_id)) {
        const result = resultSchema.safeParse(
          await peer.request('operation.status', {
            operation_id: operation.operation_id,
            session_id: binding.session_id,
          }),
        );
        if (
          !result.success ||
          result.data.operation_id !== operation.operation_id ||
          result.data.status === 'UNKNOWN'
        ) {
          throw new BridgeError(
            'RECONCILIATION_REQUIRED',
            'An earlier local operation needs inspection; no turn will be replayed.',
          );
        }
        this.store.result(result.data);
      }
      binding = this.store.bump(binding);
      connection.session = binding;
      return binding;
    });
    handle('session.describe', (raw) => {
      const { session_id } = sessionIdSchema.parse(raw);
      return {
        binding: this.store.session(session_id, device),
        unresolved_operations: this.store.pending(session_id).length,
      };
    });
    handle('events.resume', (raw) => {
      const { session_id, cursor } = sessionIdSchema
        .extend({ cursor: z.number().int().min(0) })
        .strict()
        .parse(raw);
      this.store.session(session_id, device);
      return this.store.events(session_id, cursor);
    });
    handle('turn.submit', (raw) => {
      const request = submitSchema.parse(raw);
      const binding = this.requireSession(connection, request.session_id);
      if (this.active)
        throw new BridgeError('SESSION_BUSY', 'Only one active model turn is supported.');
      if (this.store.pending(binding.session_id).length)
        throw new BridgeError(
          'RECONCILIATION_REQUIRED',
          'Resolve pending operations before a new turn.',
        );
      const turn = this.store.turn(binding.session_id, request.client_message_id, request.prompt);
      if (!turn.created) return turn;
      const controller = new AbortController();
      // Defer until the request handler has returned; the client still handles event/response races.
      const done = Promise.resolve().then(() =>
        this.run(connection, binding, turn.turn_id, request.prompt, controller),
      );
      this.active = {
        turn: turn.turn_id,
        session: binding.session_id,
        connection,
        controller,
        done,
      };
      return turn;
    });
    handle('turn.cancel', (raw) => {
      const request = turnIdSchema.parse(raw);
      this.requireSession(connection, request.session_id);
      if (this.active?.turn === request.turn_id && this.active.connection === connection) {
        this.active.controller.abort();
        peer.notify('operation.cancel_turn', request);
      }
      return { cancel_requested: true };
    });
    socket.on('close', () => {
      clearTimeout(helloTimeout);
      clearInterval(watchdog);
      this.connections.delete(connection);
      if (this.active?.connection === connection) this.active.controller.abort();
    });
  }
  private requireSession(connection: Connection, session: string): Binding {
    if (connection.session?.session_id !== session)
      throw new BridgeError('SESSION_NOT_FOUND', 'Connection is not bound to this session.');
    return connection.session;
  }
  private async run(
    connection: Connection,
    binding: Binding,
    turn: string,
    prompt: string,
    controller: AbortController,
  ): Promise<void> {
    const emit = (type: RelayEvent['type'], data: unknown) => {
      const event = this.store.event({ session_id: binding.session_id, turn_id: turn, type, data });
      try {
        connection.peer.notify('event.emit', event);
      } catch {
        /* Durable event is available for replay. */
      }
    };
    try {
      await this.runtime.run({
        binding,
        turnId: turn,
        prompt,
        signal: controller.signal,
        text: (text) => emit('text', { text }),
        cancelTools: () => {
          try {
            connection.peer.notify('operation.cancel_turn', {
              session_id: binding.session_id,
              turn_id: turn,
            });
          } catch {
            /* Disconnect already cancels local work. */
          }
        },
        execute: async (tool, input) => {
          if (controller.signal.aborted)
            throw new BridgeError('CANCELLED', 'Turn cancelled before dispatch.');
          const operation: Operation = {
            ...binding,
            turn_id: turn,
            operation_id: randomUUID(),
            tool,
            input,
          };
          this.store.dispatch(operation);
          const result = resultSchema.parse(
            await connection.peer.request('tool.execute', operation),
          );
          if (result.operation_id !== operation.operation_id)
            throw new BridgeError('OPERATION_CONFLICT', 'Tool response ID differs.');
          this.store.result(result);
          emit('tool', {
            tool,
            operation_id: result.operation_id,
            status: result.status,
            error: result.error,
          });
          return result;
        },
      });
      if (controller.signal.aborted) throw new BridgeError('CANCELLED', 'Turn cancelled.');
      this.store.finishTurn(turn, 'COMPLETED');
      emit('completed', {});
    } catch (error) {
      const state = controller.signal.aborted ? 'CANCELLED' : 'FAILED';
      this.store.finishTurn(turn, state);
      emit(state === 'CANCELLED' ? 'cancelled' : 'failed', failure(error));
    } finally {
      if (this.active?.turn === turn) this.active = undefined;
    }
  }
  revoke(device: string): void {
    this.store.revoke(device);
    for (const connection of this.connections)
      if (connection.device === device) connection.socket.close(1008, 'Device revoked');
  }
  close(): Promise<void> {
    return (this.closing ??= this.shutdown());
  }
  private async shutdown(): Promise<void> {
    clearInterval(this.heartbeat);
    this.active?.controller.abort();
    for (const connection of this.connections) {
      connection.peer.close();
      connection.socket.terminate();
    }
    await this.active?.done;
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    if (this.http.listening) await new Promise<void>((resolve) => this.http.close(() => resolve()));
    this.store.close();
  }
}
