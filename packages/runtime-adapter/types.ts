import type { Binding, OperationResult, ToolName } from '../protocol/index.js';

export interface RuntimeTurn {
  binding: Binding;
  turnId: string;
  prompt: string;
  signal: AbortSignal;
  text(value: string): void;
  execute(tool: ToolName, input: unknown): Promise<OperationResult>;
  cancelTools(): void;
}
export interface AgentRuntime {
  readonly kind: 'fake' | 'claude';
  run(turn: RuntimeTurn): Promise<void>;
}
