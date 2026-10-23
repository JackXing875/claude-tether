import { createHash } from 'node:crypto';
import { z } from 'zod';

export const PROTOCOL_VERSION = '1.0' as const;
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const MAX_FILE_BYTES = 128 * 1024;
export const MAX_OUTPUT_BYTES = 64 * 1024;
export const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const revision = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const path = z.string().min(1).max(4096).refine((v) => !v.includes('\0'));
const text = z.string().max(MAX_FILE_BYTES).refine((v) => Buffer.byteLength(v) <= MAX_FILE_BYTES);
const position = z.number().int().min(1).max(1_000_000);

export const toolSchemas = {
  workspace_info: z.object({}).strict(),
  read_file: z.object({
    path, start_line: position.default(1), end_line: position.optional(),
  }).strict().refine((v) => v.end_line === undefined || v.end_line >= v.start_line),
  list_files: z.object({
    path: path.default('.'), limit: z.number().int().min(1).max(1000).default(100),
  }).strict(),
  search_text: z.object({
    path: path.default('.'), query: z.string().min(1).max(1024),
    limit: z.number().int().min(1).max(500).default(100),
  }).strict(),
  edit_text: z.object({
    path, expected_revision: revision, old_text: text.refine((v) => v.length > 0),
    new_text: text, expected_matches: z.number().int().min(1).max(1000).default(1),
  }).strict(),
  write_file: z.object({
    path, content: text, expected_revision: revision.nullable(),
  }).strict(),
  run_command: z.object({
    cwd: path.default('.'), program: path, args: z.array(z.string().max(8192)).max(128).default([]),
    timeout_ms: z.number().int().min(1).max(60_000).default(10_000),
  }).strict(),
};
export type ToolName = keyof typeof toolSchemas;
export const toolNames = Object.keys(toolSchemas) as ToolName[];
export const toolName = z.enum(toolNames as [ToolName, ...ToolName[]]);
export const mutatingTools = new Set<ToolName>(['edit_text', 'write_file', 'run_command']);

export const workspaceSchema = z.object({
  device_id: id, workspace_id: id, workspace_generation: z.number().int().positive(),
  execution_target_id: id, policy_revision: z.number().int().positive(),
}).strict();
export const bindingSchema = workspaceSchema.extend({
  session_id: id, worker_epoch: z.number().int().positive(),
}).strict();
export type WorkspaceIdentity = z.infer<typeof workspaceSchema>;
export type Binding = z.infer<typeof bindingSchema>;
export const operationSchema = bindingSchema.extend({
  operation_id: id, turn_id: id, tool: toolName, input: z.unknown(),
}).strict();
export type Operation = z.infer<typeof operationSchema>;
export const resultSchema = z.object({
  operation_id: id,
  status: z.enum(['SUCCEEDED', 'FAILED', 'DENIED', 'CANCELLED', 'UNKNOWN']),
  output: z.unknown().optional(),
  error: z.object({ code: z.string().max(100), message: z.string().max(1024) }).strict().optional(),
}).strict();
export type OperationResult = z.infer<typeof resultSchema>;
export type OperationState = OperationResult['status'] | 'RECEIVED' | 'WAITING_APPROVAL' | 'RUNNING';

export class BridgeError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
export function failure(error: unknown): { code: string; message: string } {
  if (error instanceof BridgeError) return { code: error.code, message: error.message };
  if (error instanceof z.ZodError) return { code: 'INVALID_PARAMS', message: 'Request does not match the protocol schema.' };
  // Raw filesystem, spawn and network errors may contain private paths or values.
  return { code: 'INTERNAL_ERROR', message: 'Operation failed; inspect local state before retrying.' };
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort().map((k) => JSON.stringify(k) + ':' + canonical(record[k])).join(',') + '}';
}
export function digest(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonical(value)).digest('hex');
}
export function contentRevision(bytes: Uint8Array): string {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}
export function assertBinding(actual: Binding, expected: Binding): void {
  for (const key of Object.keys(bindingSchema.shape) as (keyof Binding)[]) {
    if (actual[key] !== expected[key]) {
      throw new BridgeError(key === 'worker_epoch' ? 'STALE_WORKER' : key === 'policy_revision' ? 'POLICY_CHANGED' : 'WORKSPACE_MISMATCH',
        'Request binding does not match this local session.');
    }
  }
}
export const helloSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION), device_id: id,
}).strict();
export const createSessionSchema = workspaceSchema;
export const submitSchema = z.object({
  session_id: id, client_message_id: id, prompt: z.string().min(1).max(16_384),
}).strict();
export const sessionIdSchema = z.object({ session_id: id }).strict();
export const turnIdSchema = sessionIdSchema.extend({ turn_id: id }).strict();
export const eventSchema = z.object({
  session_id: id, turn_id: id, cursor: z.number().int().positive(),
  type: z.enum(['text', 'tool', 'completed', 'failed', 'cancelled']),
  data: z.unknown(),
}).strict();
export type RelayEvent = z.infer<typeof eventSchema>;
