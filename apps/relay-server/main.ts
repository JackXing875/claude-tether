import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RelayServer } from '../../packages/relay/index.js';
import { FakeAgent } from '../../packages/runtime-adapter/fake.js';
import { ClaudeRuntime } from '../../packages/runtime-adapter/supervisor.js';
import { BridgeError } from '../../packages/protocol/index.js';
import { stateHome } from '../../packages/config/index.js';

export async function runServer(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      state: { type: 'string', default: join(stateHome(), 'relay', 'relay.sqlite') },
      port: { type: 'string', default: '8787' },
      host: { type: 'string', default: '127.0.0.1' },
      runtime: { type: 'string' },
      claude: { type: 'string' },
      'runtime-state': { type: 'string' },
      'turn-timeout-ms': { type: 'string' },
      cert: { type: 'string' },
      key: { type: 'string' },
    },
  });
  if (!['fake', 'claude'].includes(values.runtime ?? ''))
    throw new BridgeError('USAGE', 'Select --runtime fake or --runtime claude explicitly.');
  if (
    values.runtime === 'fake' &&
    (values.claude || values['runtime-state'] || values['turn-timeout-ms'])
  )
    throw new BridgeError('USAGE', 'Claude options require --runtime claude.');
  const timeout = values['turn-timeout-ms'] ?? '120000';
  const timeoutMs = Number(timeout);
  if (
    !/^\d+$/.test(timeout) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 600_000
  )
    throw new BridgeError('USAGE', 'Turn timeout must be between 1 and 600000 ms.');
  if (!!values.cert !== !!values.key)
    throw new BridgeError('USAGE', 'Both --cert and --key are required for TLS.');
  const port = Number(values.port);
  if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port > 65535)
    throw new BridgeError('USAGE', 'Port must be an integer between 0 and 65535.');
  const tls =
    values.cert && values.key
      ? { cert: readFileSync(values.cert), key: readFileSync(values.key) }
      : undefined;
  const runtime =
    values.runtime === 'claude'
      ? new ClaudeRuntime({
          executable: values.claude ?? 'claude',
          stateDirectory: values['runtime-state'] ?? join(dirname(values.state), 'runtime'),
          mcpWorkerPath: fileURLToPath(new URL('../mcp-bridge/worker.js', import.meta.url)),
          timeoutMs,
        })
      : new FakeAgent();
  let server: RelayServer | undefined;
  try {
    server = new RelayServer({ statePath: values.state, tls, runtime });
    const url = await server.listen(port, values.host);
    console.log(
      'Runtime: ' +
        runtime.kind +
        (runtime.kind === 'fake' ? ' (no Claude requests).' : '.') +
        ' Listening: ' +
        url,
    );
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        void server!.close().then(resolve, reject);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } finally {
    try {
      await server?.close();
    } finally {
      if (runtime instanceof ClaudeRuntime) await runtime.close();
    }
  }
}
