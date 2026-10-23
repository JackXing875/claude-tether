import { BridgeError } from '../../packages/protocol/index.js';
import { openSshTunnel, validateSshOptions } from '../../packages/transport/ssh.js';
import type { SshOptions } from '../../packages/transport/ssh.js';

export const connectionArgs = {
  url: { type: 'string' },
  ca: { type: 'string' },
  ssh: { type: 'string' },
  'ssh-command': { type: 'string' },
  'relay-port': { type: 'string' },
  'allow-insecure-loopback': { type: 'boolean', default: false },
} as const;

export function connectionPlan(values: {
  url?: string;
  ca?: string;
  ssh?: string;
  'ssh-command'?: string;
  'relay-port'?: string;
  'allow-insecure-loopback'?: boolean;
}): {
  stateKey: string;
  open(): Promise<{ url: string; allowInsecureLoopback: boolean; close(): Promise<void> }>;
} {
  if (values.ssh !== undefined) {
    if (values.url || values.ca)
      throw new BridgeError('USAGE', 'Choose --ssh or --url; --ca applies to direct WSS only.');
    const port = values['relay-port'] ?? '8787';
    if (!/^\d+$/.test(port)) throw new BridgeError('USAGE', 'Relay port must be a number.');
    const ssh: SshOptions = {
      alias: values.ssh,
      executable: values['ssh-command'],
      relayPort: Number(port),
    };
    validateSshOptions(ssh);
    return {
      // Ephemeral loopback ports must never change the saved workspace/session identity.
      stateKey: `ssh://${ssh.alias}:${ssh.relayPort}/v1/bridge`,
      open: async () => ({ ...(await openSshTunnel(ssh)), allowInsecureLoopback: true }),
    };
  }
  if (!values.url || values['ssh-command'] !== undefined || values['relay-port'] !== undefined)
    throw new BridgeError(
      'USAGE',
      'Use --url <bridge-url> or --ssh <config-alias>. SSH options require --ssh.',
    );
  const url = values.url;
  return {
    stateKey: url,
    open: async () => ({
      url,
      allowInsecureLoopback: values['allow-insecure-loopback'] ?? false,
      close: async () => {},
    }),
  };
}
