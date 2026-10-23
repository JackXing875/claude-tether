import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { RelayServer } from './index.js';
import { RelayStore } from './store.js';
import { failure } from '../../packages/protocol/index.js';

const { values } = parseArgs({ options: {
  state: { type: 'string' }, port: { type: 'string', default: '8787' },
  host: { type: 'string', default: '127.0.0.1' }, provision: { type: 'string' },
  'token-file': { type: 'string' }, revoke: { type: 'string' },
  cert: { type: 'string' }, key: { type: 'string' },
} });
if (!values.state) throw new Error('Required: --state /private/state/relay.sqlite');
if (values.provision) {
  if (!values['token-file']) throw new Error('Provisioning requires --token-file /private/client.json (created once, never printed).');
  const store = new RelayStore(values.state);
  try {
    const device = store.provision(values.provision);
    writeFileSync(values['token-file'], JSON.stringify(device, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log('Device provisioned. Credential file created; no secret was printed.');
  } finally { store.close(); }
} else if (values.revoke) {
  const store = new RelayStore(values.state);
  try { store.revoke(values.revoke); console.log('Device revoked.'); } finally { store.close(); }
} else {
  if (!!values.cert !== !!values.key) throw new Error('Both --cert and --key are required for TLS.');
  const tls = values.cert && values.key ? { cert: readFileSync(values.cert), key: readFileSync(values.key) } : undefined;
  const server = new RelayServer({ statePath: values.state, tls });
  try {
    const port = z.number().int().min(0).max(65535).parse(Number(values.port));
    const url = await server.listen(port, values.host);
    console.log('P1 FAKE runtime only; no Claude requests. Listening: ' + url);
    let stopping = false;
    const stop = () => { if (!stopping) { stopping = true; void server.close().catch(() => { process.exitCode = 1; }); } };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) { console.error(failure(error)); await server.close(); process.exitCode = 1; }
}
