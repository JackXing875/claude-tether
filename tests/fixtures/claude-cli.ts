// Synthetic CLI fixture. It speaks the candidate wire contract and uses a real MCP child.
// This is not official Claude and never makes a model request.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CLAUDE_VERSION } from '../../packages/runtime-adapter/claude.js';
import { toolNames } from '../../packages/protocol/index.js';
import type { OperationResult, ToolName } from '../../packages/protocol/index.js';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log(CLAUDE_VERSION + ' (synthetic test fixture)');
} else if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
} else {
  const sessionId =
    args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1]!;
  const input: Buffer[] = [];
  for await (const part of process.stdin) input.push(part as Buffer);
  const prompt = (
    JSON.parse(Buffer.concat(input).toString('utf8')) as { message: { content: string } }
  ).message.content;
  const statePath = join(process.cwd(), 'synthetic-transcript.json');
  const processesPath = join(process.cwd(), 'synthetic-processes.json');
  writeFileSync(processesPath, JSON.stringify([process.pid]), { mode: 0o600 });
  let state: { session: string; marker?: string; resumes: number };
  if (args.includes('--resume')) {
    state = JSON.parse(readFileSync(statePath, 'utf8')) as typeof state;
    if (state.session !== sessionId) throw new Error('Synthetic session mismatch');
    state.resumes++;
  } else state = { session: sessionId, resumes: 0 };
  const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  const text = (value: string) =>
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: value }] } });
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  emit({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    tools:
      prompt === 'bad-tools' ? ['Bash'] : toolNames.map((name) => 'mcp__local_bridge__' + name),
  });
  if (prompt === 'bad-tools' || prompt === 'crash') {
    process.exitCode = 17;
  } else if (prompt.startsWith('remember ')) {
    state.marker = prompt.slice(9);
    writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    text('stored');
    emit({ type: 'result', session_id: sessionId, subtype: 'success', is_error: false });
  } else if (prompt === 'recall') {
    text('marker=' + state.marker + ';resumes=' + state.resumes);
    emit({ type: 'result', session_id: sessionId, subtype: 'success', is_error: false });
  } else if (prompt === 'hang') {
    text('synthetic-runtime-ready');
    setInterval(() => {}, 1000);
  } else {
    const config = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1]!, 'utf8')) as {
      mcpServers: { local_bridge: { command: string; args: string[] } };
    };
    const transport = new StdioClientTransport({
      ...config.mcpServers.local_bridge,
      stderr: 'ignore',
    });
    const client = new Client({ name: 'synthetic-claude', version: '0.0.0' });
    try {
      await client.connect(transport);
      writeFileSync(processesPath, JSON.stringify([process.pid, transport.pid]), { mode: 0o600 });
      const listed = await client.listTools();
      if (listed.tools.length !== toolNames.length) throw new Error('MCP tools differ');
      const call = async (name: ToolName, input: unknown): Promise<OperationResult> => {
        emit({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'mcp__local_bridge__' + name }] },
        });
        const result = await client.callTool({ name, arguments: input as Record<string, unknown> });
        const content = result.content as { text: string }[];
        const operation = JSON.parse(content[0]!.text) as OperationResult;
        if (operation.status !== 'SUCCEEDED')
          throw new Error('Synthetic tool failed: ' + operation.status);
        return operation;
      };
      await call('workspace_info', {});
      if (prompt === 'edit-test') {
        const read = await call('read_file', { path: 'calc.mjs' });
        await call('edit_text', {
          path: 'calc.mjs',
          expected_revision: (read.output as { revision: string }).revision,
          old_text: 'return a - b;',
          new_text: 'return a + b;',
        });
        await call('run_command', { program: 'node', args: ['--test', 'calc.test.mjs'] });
        text('synthetic edit and local test completed');
      } else if (prompt === 'long-command') {
        await call('run_command', {
          program: 'node',
          args: [
            '-e',
            "require('fs').writeFileSync('local-command.pid',String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
          ],
          timeout_ms: 60_000,
        });
      } else if (prompt.startsWith('read ')) {
        const read = await call('read_file', { path: prompt.slice(5) });
        text(JSON.stringify(read.output));
      }
      emit({ type: 'result', session_id: sessionId, subtype: 'success', is_error: false });
    } finally {
      await client.close();
    }
  }
}
