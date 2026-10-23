import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import WebSocket from 'ws';
import { BridgeError, failure, MAX_MESSAGE_BYTES } from '../protocol/index.js';

const rpcId = z.string().min(1).max(128);
const requestSchema = z.object({
  jsonrpc: z.literal('2.0'), id: rpcId.optional(),
  method: z.string().min(1).max(100), params: z.unknown(),
}).strict();
const responseSchema = z.union([
  z.object({ jsonrpc: z.literal('2.0'), id: rpcId, result: z.unknown() }).strict(),
  z.object({
    jsonrpc: z.literal('2.0'), id: rpcId,
    error: z.object({ code: z.number().int(), message: z.string().max(1024), data: z.object({ code: z.string().max(100) }).strict() }).strict(),
  }).strict(),
]);
type Handler = (params: unknown) => unknown | Promise<unknown>;
interface Pending { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }

export class RpcPeer {
  private handlers = new Map<string, Handler>();
  private pending = new Map<string, Pending>();
  private active = 0;
  private closed = false;
  constructor(readonly socket: WebSocket) {
    socket.on('message', (data, binary) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (binary || bytes.length > MAX_MESSAGE_BYTES) { socket.close(1009, 'Invalid frame'); return; }
      void this.receive(bytes.toString('utf8')).catch(() => socket.close(1008, 'Invalid protocol'));
    });
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }
  handle(method: string, handler: Handler): void { this.handlers.set(method, handler); }
  private send(message: unknown): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw new BridgeError('WORKSPACE_OFFLINE', 'Connection is closed.');
    const encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded) > MAX_MESSAGE_BYTES || this.socket.bufferedAmount > MAX_MESSAGE_BYTES) {
      this.socket.close(1009, 'Resource limit');
      throw new BridgeError('RESOURCE_LIMIT', 'Connection buffer or message exceeded its limit.');
    }
    this.socket.send(encoded);
  }
  request(method: string, params: unknown, timeoutMs = 100_000): Promise<unknown> {
    if (this.pending.size >= 64) return Promise.reject(new BridgeError('RESOURCE_LIMIT', 'Too many outstanding RPCs.'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new BridgeError('RPC_TIMEOUT', 'Delivery timed out; this does not establish the operation outcome.'));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.send({ jsonrpc: '2.0', id: requestId, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  notify(method: string, params: unknown): void { this.send({ jsonrpc: '2.0', method, params }); }
  private async receive(raw: string): Promise<void> {
    const value: unknown = JSON.parse(raw);
    const response = responseSchema.safeParse(value);
    if (response.success) {
      const message = response.data, pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if ('result' in message) pending.resolve(message.result);
      else pending.reject(new BridgeError(message.error.data.code, message.error.message));
      return;
    }
    const message = requestSchema.parse(value);
    const handler = this.handlers.get(message.method);
    this.active++;
    try {
      if (this.active > 16) throw new BridgeError('RESOURCE_LIMIT', 'Too many concurrent incoming RPCs.');
      if (!handler) throw new BridgeError('METHOD_NOT_FOUND', 'Unsupported bridge method.');
      const result = await handler(message.params);
      if (message.id) this.send({ jsonrpc: '2.0', id: message.id, result: result ?? null });
    } catch (error) {
      if (message.id && !this.closed && this.socket.readyState === WebSocket.OPEN) {
        const details = failure(error);
        this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: details.message, data: { code: details.code } } });
      }
    } finally { this.active--; }
  }
  private finish(): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeError('WORKSPACE_OFFLINE', 'Connection lost. Operation outcome may need reconciliation.'));
    }
    this.pending.clear();
  }
  close(): void { this.finish(); this.socket.close(); }
}
