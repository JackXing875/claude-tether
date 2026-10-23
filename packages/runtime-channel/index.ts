import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { z } from 'zod';
import {
  assertBinding,
  bindingSchema,
  BridgeError,
  id,
  MAX_MESSAGE_BYTES,
  resultSchema,
  toolName,
  toolSchemas,
} from '../protocol/index.js';
import type { Binding, OperationResult, ToolName } from '../protocol/index.js';
import { RpcPeer } from '../transport/index.js';

export const channelConfigSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'ws:' &&
          url.hostname === '127.0.0.1' &&
          url.pathname === '/v1/runtime' &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    binding: bindingSchema,
    turn_id: id,
  })
  .strict();
export type ChannelConfig = z.infer<typeof channelConfigSchema>;
const callSchema = z
  .object({ binding: bindingSchema, turn_id: id, tool: toolName, input: z.unknown() })
  .strict();

/** One ephemeral capability per runtime turn. Never exposed beyond numeric loopback. */
export class RuntimeChannel {
  private readonly token = randomBytes(32).toString('base64url');
  private readonly http = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  private peer?: RpcPeer;
  private accepted = false;
  private activated = false;
  private closing?: Promise<void>;
  private readonly pending = new Set<Promise<OperationResult>>();
  constructor(
    private readonly options: {
      binding: Binding;
      turnId: string;
      signal: AbortSignal;
      execute(tool: ToolName, input: unknown): Promise<OperationResult>;
      disconnected(): void;
    },
  ) {
    this.http.on('upgrade', (req, socket, head) => {
      const provided = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from('Bearer ' + this.token);
      if (
        req.url !== '/v1/runtime' ||
        req.headers.origin ||
        this.accepted ||
        this.closing ||
        provided.length !== expected.length ||
        !timingSafeEqual(provided, expected)
      ) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      this.accepted = true;
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.peer = new RpcPeer(ws);
        this.peer.handle('tool.call', async (raw) => {
          const call = callSchema.parse(raw);
          assertBinding(call.binding, this.options.binding);
          if (call.turn_id !== this.options.turnId)
            throw new BridgeError('STALE_WORKER', 'Runtime turn does not match this capability.');
          if (!this.activated)
            throw new BridgeError(
              'RUNTIME_NOT_READY',
              'Runtime initialization has not been verified.',
            );
          if (this.closing || this.options.signal.aborted)
            throw new BridgeError('CANCELLED', 'Runtime turn is stopping.');
          const input = toolSchemas[call.tool].parse(call.input);
          const operation = Promise.resolve().then(() => this.options.execute(call.tool, input));
          this.pending.add(operation);
          try {
            return await operation;
          } finally {
            this.pending.delete(operation);
          }
        });
        ws.once('close', () => {
          // Normal CLI teardown can close an idle MCP connection before its terminal event.
          // A dropped in-flight call is uncertain and must stop the turn, never reconnect/replay.
          if (!this.closing && this.pending.size) this.options.disconnected();
        });
      });
    });
  }
  async listen(): Promise<ChannelConfig> {
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(0, '127.0.0.1', () => {
        this.http.off('error', reject);
        resolve();
      });
    });
    const address = this.http.address();
    if (!address || typeof address === 'string')
      throw new BridgeError('RUNTIME_START_FAILED', 'Cannot bind runtime channel.');
    return {
      url: `ws://127.0.0.1:${address.port}/v1/runtime`,
      token: this.token,
      binding: this.options.binding,
      turn_id: this.options.turnId,
    };
  }
  activate(): void {
    this.activated = true;
  }
  close(): Promise<void> {
    return (this.closing ??= this.shutdown());
  }
  private async shutdown(): Promise<void> {
    this.activated = false;
    this.peer?.close();
    this.peer?.socket.terminate();
    await Promise.allSettled([...this.pending]);
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    if (this.http.listening) await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}

export async function connectRuntimeChannel(raw: unknown): Promise<{
  peer: RpcPeer;
  execute(tool: ToolName, input: unknown): Promise<OperationResult>;
  close(): void;
}> {
  const config = channelConfigSchema.parse(raw);
  const socket = new WebSocket(config.url, {
    headers: { Authorization: 'Bearer ' + config.token },
    maxPayload: MAX_MESSAGE_BYTES,
    handshakeTimeout: 8000,
    perMessageDeflate: false,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      socket.off('error', reject);
      resolve();
    });
    socket.once('error', reject);
  });
  const peer = new RpcPeer(socket);
  return {
    peer,
    execute: async (tool, input) =>
      resultSchema.parse(
        await peer.request('tool.call', {
          binding: config.binding,
          turn_id: config.turn_id,
          tool,
          input,
        }),
      ),
    close: () => {
      peer.close();
      socket.terminate();
    },
  };
}
