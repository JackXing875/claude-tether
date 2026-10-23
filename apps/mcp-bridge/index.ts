import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { failure, mutatingTools, toolName, toolNames, toolSchemas } from '../../packages/protocol/index.js';
import type { OperationResult, ToolName } from '../../packages/protocol/index.js';

export function createMcpBridge(execute: (name: ToolName, input: unknown) => Promise<OperationResult>): Server {
  const server = new Server({ name: 'local_bridge', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolNames.map((name) => ({
      name,
      description: 'Runs on the connected LOCAL workspace with local authorization. ' + name +
        '. Relative paths only; UTF-8 files up to 128 KiB. Commands are foreground exec (60 seconds maximum).',
      inputSchema: z.toJSONSchema(toolSchemas[name], { io: 'input' }) as { type: 'object'; properties: Record<string, unknown> },
      annotations: { readOnlyHint: !mutatingTools.has(name), openWorldHint: name === 'run_command' },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const name = toolName.parse(request.params.name);
      const input = toolSchemas[name].parse(request.params.arguments ?? {});
      const result = await execute(name, input);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: result.status !== 'SUCCEEDED' };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify(failure(error)) }], isError: true };
    }
  });
  return server;
}
