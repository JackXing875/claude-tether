import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpBridge } from '../apps/mcp-bridge/index.js';
import { fixture } from './helpers.js';
import { toolNames } from '../packages/protocol/index.js';

test('real MCP SDK tools/list and tools/call route to the local permission boundary', async (t) => {
  const f = await fixture(t, { approve: async () => false });
  const server = createMcpBridge((tool, input) => f.host.execute(f.operation(tool, input)));
  const client = new Client({ name: 'contract-test', version: '0.1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), toolNames);
    const info = await client.callTool({ name: 'workspace_info', arguments: {} });
    assert.equal(info.isError, false);
    const write = await client.callTool({ name: 'write_file', arguments: { path: 'denied', content: 'no', expected_revision: null } });
    assert.equal(write.isError, true);
    const content = write.content as { text: string }[];
    assert.equal(JSON.parse(content[0]!.text).status, 'DENIED');
  } finally { await client.close(); await server.close(); }
});
