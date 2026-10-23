import type { OperationResult, ToolName } from '../protocol/index.js';

export interface RuntimeTurn {
  prompt: string;
  signal: AbortSignal;
  text(value: string): void;
  execute(tool: ToolName, input: unknown): Promise<OperationResult>;
}
export interface AgentRuntime {
  readonly kind: 'fake' | 'claude';
  run(turn: RuntimeTurn): Promise<void>;
}
