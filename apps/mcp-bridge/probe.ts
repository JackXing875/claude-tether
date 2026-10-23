import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// P0 only: deliberately no remote file or command tools. stdout is MCP-only.
const server = new Server({ name: 'local_bridge', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'workspace_info', description: 'Return the P0 bridge probe marker. No filesystem or command access.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: 'text', text: request.params.name === 'workspace_info' ? '{"probe":"personal-relay-p0","project_access":false}' : '{"error":"unsupported tool"}' }],
  isError: request.params.name !== 'workspace_info',
}));
await server.connect(new StdioServerTransport());
