import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { RelayServer } from '../../packages/relay/index.js';
import { FakeAgent } from '../../packages/runtime-adapter/fake.js';
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
      cert: { type: 'string' },
      key: { type: 'string' },
    },
  });
  if (values.runtime !== 'fake')
    throw new BridgeError(
      'USAGE',
      'Select --runtime fake explicitly. Real Claude relay integration is not enabled in this alpha.',
    );
  if (!!values.cert !== !!values.key)
    throw new BridgeError('USAGE', 'Both --cert and --key are required for TLS.');
  const port = Number(values.port);
  if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port > 65535)
    throw new BridgeError('USAGE', 'Port must be an integer between 0 and 65535.');
  const tls =
    values.cert && values.key
      ? { cert: readFileSync(values.cert), key: readFileSync(values.key) }
      : undefined;
  const server = new RelayServer({ statePath: values.state, tls, runtime: new FakeAgent() });
  try {
    const url = await server.listen(port, values.host);
    console.log('Runtime: fake (no Claude requests). Listening: ' + url);
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        void server.close().then(resolve, reject);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } finally {
    await server.close();
  }
}
