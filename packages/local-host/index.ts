import {
  assertBinding,
  bindingSchema,
  BridgeError,
  digest,
  failure,
  mutatingTools,
  operationSchema,
  toolSchemas,
} from '../protocol/index.js';
import type { Binding, Operation, OperationResult, ToolName } from '../protocol/index.js';
import { OperationJournal } from '../operation-journal/index.js';
import { LocalTools } from '../local-tools/index.js';

export interface Approval {
  readonly operation_id: string;
  readonly tool: ToolName;
  readonly input_digest: string;
  readonly preview: string;
}
export type Approver = (request: Readonly<Approval>, signal: AbortSignal) => Promise<boolean>;
export interface HostOptions {
  root: string;
  journalPath: string;
  policy?: 'ask' | 'read-only' | 'accept-edits';
  approve?: Approver;
  approvalTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export class LocalHost {
  readonly tools: LocalTools;
  readonly journal: OperationJournal;
  private binding?: Binding;
  private tail = Promise.resolve();
  private inflight = new Map<
    string,
    { digest: string; promise: Promise<OperationResult>; controller: AbortController; turn: string }
  >();
  constructor(private readonly options: HostOptions) {
    this.tools = new LocalTools(options.root, options.env);
    this.journal = new OperationJournal(options.journalPath);
  }
  bind(binding: Binding): void {
    if (this.inflight.size)
      throw new BridgeError(
        'SESSION_BUSY',
        'Cannot change binding while local operations are running.',
      );
    this.binding = bindingSchema.parse(binding);
  }
  execute(raw: unknown): Promise<OperationResult> {
    const operation = operationSchema.parse(structuredClone(raw));
    operation.input = toolSchemas[operation.tool].parse(operation.input);
    if (!this.binding)
      throw new BridgeError('WORKSPACE_MISMATCH', 'Local host is not bound to a session.');
    assertBinding(operation, this.binding);
    const inputDigest = digest(operation);
    const pending = this.inflight.get(operation.operation_id);
    if (pending) {
      if (pending.digest !== inputDigest)
        throw new BridgeError('OPERATION_CONFLICT', 'Operation ID has different parameters.');
      return pending.promise;
    }
    if (this.inflight.size >= 16)
      throw new BridgeError('RESOURCE_LIMIT', 'Local operation queue is full.');
    const previous = this.journal.accept(operation);
    if (previous) return Promise.resolve(previous);
    const controller = new AbortController();
    const promise = this.tail.then(() => this.perform(operation, controller));
    this.tail = promise.then(
      () => undefined,
      () => undefined,
    );
    this.inflight.set(operation.operation_id, {
      digest: inputDigest,
      promise,
      controller,
      turn: operation.turn_id,
    });
    void promise.finally(() => this.inflight.delete(operation.operation_id)).catch(() => {});
    return promise;
  }
  private async approve(
    operation: Operation,
    preview: string,
    controller: AbortController,
  ): Promise<void> {
    const signal = controller.signal;
    if (signal.aborted) throw new BridgeError('CANCELLED', 'Operation cancelled.');
    this.journal.setState(operation.operation_id, 'WAITING_APPROVAL');
    const approval = Object.freeze({
      operation_id: operation.operation_id,
      tool: operation.tool,
      input_digest: digest(operation),
      preview,
    });
    const timeout = setTimeout(
      () => controller.abort(new BridgeError('APPROVAL_EXPIRED', 'Local approval timed out.')),
      this.options.approvalTimeoutMs ?? 30_000,
    );
    let onAbort: () => void = () => {};
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () =>
          reject(
            signal.reason instanceof BridgeError
              ? signal.reason
              : new BridgeError('CANCELLED', 'Operation cancelled.'),
          );
        signal.addEventListener('abort', onAbort, { once: true });
      });
      const decision = await Promise.race([
        this.options.approve?.(approval, signal) ?? Promise.resolve(false),
        aborted,
      ]);
      if (decision !== true)
        throw new BridgeError('PERMISSION_DENIED', 'User denied the local operation.');
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    }
  }
  private async perform(
    operation: Operation,
    controller: AbortController,
  ): Promise<OperationResult> {
    let started = false;
    let result: OperationResult;
    try {
      if (controller.signal.aborted) throw new BridgeError('CANCELLED', 'Operation cancelled.');
      assertBinding(operation, this.binding!);
      const mutates = mutatingTools.has(operation.tool);
      if (mutates && this.journal.hasUncertain()) {
        throw new BridgeError(
          'OUTCOME_UNKNOWN',
          'An earlier local effect is unresolved. Inspect the journal before new effects.',
        );
      }
      if (mutates && this.options.policy === 'read-only')
        throw new BridgeError('PERMISSION_DENIED', 'Read-only policy forbids this tool.');
      const prepared = await this.tools.prepare(operation.tool, operation.input);
      if (
        mutates &&
        !(this.options.policy === 'accept-edits' && operation.tool !== 'run_command')
      ) {
        await this.approve(operation, prepared.preview, controller);
      }
      if (controller.signal.aborted)
        throw new BridgeError('CANCELLED', 'Operation cancelled before execution.');
      assertBinding(operation, this.binding!);
      this.journal.setState(operation.operation_id, 'RUNNING');
      started = true;
      const output = await prepared.execute(controller.signal);
      result = { operation_id: operation.operation_id, status: 'SUCCEEDED', output };
      if (operation.tool === 'run_command') {
        const command = output as {
          exit_code: number | null;
          cancelled: boolean;
          timed_out: boolean;
        };
        if (command.cancelled || command.exit_code !== 0) {
          result.status = command.cancelled && !command.timed_out ? 'CANCELLED' : 'FAILED';
          result.error = {
            code: command.timed_out
              ? 'PROCESS_TIMEOUT'
              : command.cancelled
                ? 'CANCELLED'
                : 'PROCESS_EXIT_NONZERO',
            message: 'Local process stopped; effects already performed are not rolled back.',
          };
        }
      }
    } catch (error) {
      const details = failure(error);
      result = {
        operation_id: operation.operation_id,
        status:
          details.code === 'PERMISSION_DENIED' || details.code === 'APPROVAL_EXPIRED'
            ? 'DENIED'
            : details.code === 'CANCELLED'
              ? 'CANCELLED'
              : started && !(error instanceof BridgeError)
                ? 'UNKNOWN'
                : 'FAILED',
        error: details,
      };
    }
    this.journal.finish(result);
    return result;
  }
  cancelTurn(turn: string): void {
    for (const entry of this.inflight.values()) if (entry.turn === turn) entry.controller.abort();
  }
  cancelAll(): void {
    for (const entry of this.inflight.values()) entry.controller.abort();
  }
  async close(): Promise<void> {
    this.cancelAll();
    await this.tail;
    this.journal.close();
  }
}
