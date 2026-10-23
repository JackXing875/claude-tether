import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { BridgeClient } from '../../packages/client/index.js';
import {
  assertOutsideWorkspace,
  clientState,
  readCredential,
  readWorkspaceIdentity,
  validatePrivateDirectory,
} from '../../packages/config/index.js';
import { LocalTools } from '../../packages/local-tools/index.js';
import { BridgeError } from '../../packages/protocol/index.js';
import type { SessionSummary } from '../../packages/protocol/index.js';
import { connectionArgs, connectionPlan } from './connection.js';

export async function runSessions(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      ...connectionArgs,
      credential: { type: 'string' },
      config: { type: 'string' },
      state: { type: 'string' },
      workspace: { type: 'string', default: process.cwd() },
      'read-only': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });
  const credentialPath = values.credential ?? values.config;
  if (!credentialPath)
    throw new BridgeError(
      'USAGE',
      'Required: --credential <device.json>. Run tether sessions --help.',
    );
  const connection = connectionPlan(values);
  const credentials = readCredential(credentialPath);
  const tools = new LocalTools(values.workspace);
  const policy = values['read-only'] ? 'read-only' : 'ask';
  const print = (sessions: SessionSummary[]) => {
    if (values.json) {
      console.log(JSON.stringify(sessions));
      return;
    }
    if (!sessions.length) {
      console.log('No sessions found for this device, workspace and policy.');
      return;
    }
    console.log('SESSION ID                             LAST TURN     CONNECTION  UNRESOLVED');
    for (const session of sessions) {
      console.log(
        [
          session.session_id.padEnd(38),
          session.latest_turn_state.padEnd(13),
          (session.connected ? 'attached' : 'detached').padEnd(11),
          session.unresolved_operations,
        ].join(''),
      );
    }
    console.log('Use tether connect with the same options and --resume <session-id>.');
    console.log(
      'Status is a snapshot. Resume checks ownership and reconciles operations before new work.',
    );
  };
  let state: string;
  try {
    state = validatePrivateDirectory(
      values.state ?? clientState(tools.root, credentials.device_id, connection.stateKey, policy),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    print([]);
    return;
  }
  assertOutsideWorkspace(tools.root, state);
  const workspace = readWorkspaceIdentity(join(state, 'workspace.json'), {
    root: tools.root,
    directory_identity: tools.identity(),
    policy,
    device_id: credentials.device_id,
  });
  if (!workspace) {
    print([]);
    return;
  }
  const transport = await connection.open();
  try {
    print(
      await BridgeClient.listSessions({
        url: transport.url,
        token: credentials.token,
        workspace,
        allowInsecureLoopback: transport.allowInsecureLoopback,
        ca: values.ca ? readFileSync(values.ca) : undefined,
      }),
    );
  } finally {
    await transport.close();
  }
}
