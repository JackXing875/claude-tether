import { closeSync, fsyncSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ensurePrivateDirectory, stateHome } from '../../packages/config/index.js';
import { BridgeError, id } from '../../packages/protocol/index.js';
import { RelayStore } from '../../packages/relay/store.js';

export async function runDevice(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!['create', 'revoke'].includes(command ?? ''))
    throw new BridgeError('USAGE', 'Use tether device create or tether device revoke.');
  const { values } = parseArgs({
    args: rest,
    options: {
      state: { type: 'string', default: join(stateHome(), 'relay', 'relay.sqlite') },
      id: { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (command === 'revoke') {
    if (!values.id || values.out)
      throw new BridgeError('USAGE', 'Revoke requires --id and does not accept --out.');
    id.parse(values.id);
    const store = new RelayStore(values.state);
    try {
      store.revoke(values.id);
      console.log('Device revoked.');
    } finally {
      store.close();
    }
    return;
  }
  if (!values.out) throw new BridgeError('USAGE', 'Create requires --out <private-device.json>.');
  const deviceId = id.parse(values.id ?? randomUUID());
  ensurePrivateDirectory(dirname(values.out));
  const store = new RelayStore(values.state);
  try {
    const fd = openSync(values.out, 'wx', 0o600);
    let provisioned = false;
    try {
      const credential = store.provision(deviceId);
      provisioned = true;
      writeFileSync(fd, JSON.stringify(credential, null, 2) + '\n');
      fsyncSync(fd);
      console.log('Device ' + deviceId + ' created. Credential saved; no secret printed.');
    } catch (error) {
      if (provisioned) store.revoke(deviceId);
      unlinkSync(values.out);
      throw error;
    } finally {
      closeSync(fd);
    }
  } finally {
    store.close();
  }
}
