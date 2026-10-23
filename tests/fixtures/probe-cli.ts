// Synthetic P0 CLI. This fixture never authenticates to Anthropic or calls a model.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CLAUDE_VERSION } from '../../packages/runtime-adapter/claude.js';

const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1]!;
const mode = option('--fixture-mode');
const audit = option('--fixture-audit');
const record = (entry: unknown) =>
  appendFileSync(audit, JSON.stringify(entry) + '\n', { mode: 0o600 });
if (args[0] === '--version') console.log(CLAUDE_VERSION + ' (synthetic P0 fixture)');
else if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: mode !== 'no-auth', authMethod: 'claude.ai' }));
} else {
  const resume = args.includes('--resume');
  const requestedId = option(resume ? '--resume' : '--session-id');
  const sessionId = mode === 'wrong-session' && resume ? randomUUID() : requestedId;
  const chunks: Buffer[] = [];
  for await (const part of process.stdin) chunks.push(part as Buffer);
  const prompt = (JSON.parse(Buffer.concat(chunks).toString()) as { message: { content: string } })
    .message.content;
  const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  const text = (value: string) => {
    // Split the marker over separate deltas; P0 must not depend on frame boundaries.
    for (const fragment of [value.slice(0, 10), value.slice(10)]) {
      emit({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: fragment } },
      });
    }
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: value }] } });
  };
  const config = JSON.parse(readFileSync(option('--mcp-config'), 'utf8')) as {
    mcpServers: { local_bridge: { command: string; args: string[] } };
  };
  const server = config.mcpServers.local_bridge;
  const challengePath = server.args[server.args.indexOf('--challenge') + 1]!;
  const available = (JSON.parse(readFileSync(challengePath, 'utf8')) as { marker: string }).marker;
  const statePath = join(process.cwd(), 'synthetic-probe-transcript.json');
  record({
    phase: resume ? 'resume' : 'first',
    requestedId,
    sessionId,
    available,
    prompt,
    pid: process.pid,
  });
  emit({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    tools:
      mode === 'extra-tool'
        ? ['mcp__local_bridge__workspace_info', 'mcp__local_bridge__read_file']
        : ['mcp__local_bridge__workspace_info'],
  });
  if (resume && mode !== 'repeat-tool') {
    const previous = JSON.parse(readFileSync(statePath, 'utf8')) as { marker: string };
    text(mode === 'forget' ? 'I do not remember the earlier marker.' : previous.marker);
  } else if (mode === 'no-tool') {
    // Forged output is insufficient even if a fixture can inspect the challenge file.
    text(available);
  } else {
    const transport = new StdioClientTransport({ ...server, stderr: 'ignore' });
    const client = new Client({ name: 'synthetic-p0', version: '0.0.0' });
    try {
      await client.connect(transport);
      record({ phase: 'mcp', pid: process.pid, mcp_pid: transport.pid });
      const listed = await client.listTools();
      if (listed.tools.length !== 1 || listed.tools[0]!.name !== 'workspace_info')
        throw new Error('Unexpected probe tools');
      if (mode === 'hang')
        await new Promise(() => {
          setInterval(() => {}, 1000);
        });
      emit({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'mcp__local_bridge__workspace_info' }] },
      });
      const result = await client.callTool({ name: 'workspace_info', arguments: {} });
      const marker = (
        JSON.parse((result.content as { text: string }[])[0]!.text) as { probe: string }
      ).probe;
      writeFileSync(statePath, JSON.stringify({ marker }), { mode: 0o600 });
      text(marker);
    } finally {
      await client.close();
    }
  }
  emit({ type: 'result', subtype: 'success', session_id: sessionId, is_error: false });
}
