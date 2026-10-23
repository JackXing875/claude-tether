import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpBridge } from '../../packages/mcp-bridge/index.js';
import { connectRuntimeChannel } from '../../packages/runtime-channel/index.js';
import { BridgeError, failure } from '../../packages/protocol/index.js';

// stdout belongs exclusively to MCP. The argument names a private capability file, not a secret.
try {
  const { values } = parseArgs({ options: { channel: { type: 'string' } } });
  if (!values.channel)
    throw new BridgeError('INVALID_CONFIG', 'A private runtime channel file is required.');
  const fd = openSync(values.channel, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: unknown;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o077) !== 0)
      throw new BridgeError('STATE_PERMISSIONS', 'Runtime capability file must be private.');
    raw = JSON.parse(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
  const channel = await connectRuntimeChannel(raw);
  const server = createMcpBridge(channel.execute);
  let stopping = false;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    channel.close();
    void server
      .close()
      .finally(() => {
        process.stdin.destroy();
        done();
      })
      .catch(() => {});
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.stdin.once('end', stop);
  channel.peer.socket.once('close', stop);
  try {
    await server.connect(new StdioServerTransport());
    await finished;
  } finally {
    stop();
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
} catch (error) {
  process.stderr.write('Tether MCP worker: ' + failure(error).code + '\n');
  process.exitCode = 1;
}
