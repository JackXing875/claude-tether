import { BridgeError } from '../protocol/index.js';
import type { AgentRuntime, RuntimeTurn } from './types.js';

/** Deterministic fixture, never interprets a natural-language prompt as code. */
export class FakeAgent implements AgentRuntime {
  readonly kind = 'fake' as const;
  async run(turn: RuntimeTurn): Promise<void> {
    if (turn.signal.aborted) throw new BridgeError('CANCELLED', 'Turn cancelled.');
    turn.text('[模拟 Agent] ');
    if (turn.prompt.startsWith('read ')) {
      const result = await turn.execute('read_file', { path: turn.prompt.slice(5) });
      if (result.status !== 'SUCCEEDED') throw new BridgeError('TOOL_FAILED', result.error?.code ?? 'Read failed.');
      turn.text((result.output as { content: string }).content);
      return;
    }
    if (turn.prompt !== 'demo') {
      turn.text('仅支持 demo 或 read <相对路径>。此入口不连接 Claude。');
      return;
    }
    turn.text('读取本地 calc.mjs，修复加法，再运行本地测试。\n');
    const read = await turn.execute('read_file', { path: 'calc.mjs' });
    if (read.status !== 'SUCCEEDED') throw new BridgeError('TOOL_FAILED', read.error?.code ?? 'Read failed.');
    const file = read.output as { content: string; revision: string };
    if (file.content.includes('return a - b;')) {
      const edit = await turn.execute('edit_text', {
        path: 'calc.mjs', expected_revision: file.revision,
        old_text: 'return a - b;', new_text: 'return a + b;', expected_matches: 1,
      });
      if (edit.status !== 'SUCCEEDED') throw new BridgeError('TOOL_FAILED', edit.error?.code ?? 'Edit failed.');
    }
    const test = await turn.execute('run_command', { program: 'node', args: ['--test', 'calc.test.mjs'], cwd: '.', timeout_ms: 10_000 });
    if (test.status !== 'SUCCEEDED') throw new BridgeError('TOOL_FAILED', test.error?.code ?? 'Test failed.');
    turn.text('本地修改及测试完成。');
  }
}
