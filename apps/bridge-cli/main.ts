import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { terminalText } from '../../packages/diagnostics/index.js';
import { LocalHost } from '../../packages/local-host/index.js';
import { BridgeClient } from '../../packages/client/index.js';
import { BridgeError, failure } from '../../packages/protocol/index.js';
import { connectionArgs, connectionPlan } from '../cli/connection.js';
import {
  assertOutsideWorkspace,
  clientState,
  ensurePrivateDirectory,
  readCredential,
  readWorkspaceIdentity,
} from '../../packages/config/index.js';

export async function runClient(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      ...connectionArgs,
      credential: { type: 'string' },
      config: { type: 'string' },
      state: { type: 'string' },
      workspace: { type: 'string', default: process.cwd() },
      resume: { type: 'string' },
      prompt: { type: 'string' },
      'read-only': { type: 'boolean', default: false },
    },
  });
  const credentialPath = values.credential ?? values.config;
  if (!credentialPath)
    throw new BridgeError(
      'USAGE',
      'Required: --credential <device.json>. Run tether connect --help.',
    );
  const connection = connectionPlan(values);
  if (!process.stdin.isTTY && !values.prompt)
    throw new BridgeError(
      'USAGE',
      'Interactive mode requires a terminal. Use --prompt for one turn.',
    );
  const credentials = readCredential(credentialPath);
  const root = realpathSync(values.workspace);
  const policy = values['read-only'] ? 'read-only' : 'ask';
  const state = ensurePrivateDirectory(
    values.state ?? clientState(root, credentials.device_id, connection.stateKey, policy),
  );
  assertOutsideWorkspace(root, state);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let host: LocalHost | undefined, client: BridgeClient | undefined, turnId: string | undefined;
  let transport: Awaited<ReturnType<typeof connection.open>> | undefined;
  let stopping = false;
  const interrupt = () => {
    if (client && turnId) void client.cancel(turnId).catch(() => {});
    else terminal.close();
  };
  terminal.on('SIGINT', interrupt);
  process.on('SIGINT', interrupt);
  const terminate = () => {
    stopping = true;
    client?.close();
    host?.cancelAll();
    terminal.close();
  };
  process.once('SIGTERM', terminate);
  try {
    host = new LocalHost({
      root,
      journalPath: join(state, 'operations.sqlite'),
      policy,
      approve: async (approval, signal) => {
        if (!process.stdin.isTTY) return false;
        console.log('\n' + terminalText(approval.preview));
        try {
          return (
            (await terminal.question('Allow this local operation once? [y/N] ', { signal }))
              .trim()
              .toLowerCase() === 'y'
          );
        } catch {
          return false;
        }
      },
    });
    const identityPath = join(state, 'workspace.json');
    let binding = readWorkspaceIdentity(identityPath, {
      root,
      directory_identity: host.tools.identity(),
      policy,
      device_id: credentials.device_id,
    });
    if (!binding) {
      binding = {
        device_id: credentials.device_id,
        workspace_id: randomUUID(),
        workspace_generation: 1,
        execution_target_id: randomUUID(),
        policy_revision: 1,
      };
      const identity = {
        root,
        directory_identity: host.tools.identity(),
        policy,
        binding,
      };
      writeFileSync(identityPath, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
    }
    transport = await connection.open();
    if (stopping) throw new BridgeError('CANCELLED', 'Client is stopping.');
    client = await BridgeClient.connect({
      url: transport.url,
      token: credentials.token,
      workspace: binding,
      host,
      allowInsecureLoopback: transport.allowInsecureLoopback,
      ca: values.ca ? readFileSync(values.ca) : undefined,
      resumeSession: values.resume,
      onEvent: (event) => {
        if (event.type === 'text')
          process.stdout.write(terminalText((event.data as { text: string }).text));
        else console.log('\n[' + event.type + '] ' + terminalText(JSON.stringify(event.data)));
      },
    });
    if (stopping) throw new BridgeError('CANCELLED', 'Client is stopping.');
    console.log(
      '\nRuntime: ' +
        client.runtime +
        (client.runtime === 'fake' ? ' (offline simulator; commands: demo, read <path>)' : ''),
    );
    console.log('Workspace: ' + terminalText(root) + '\nSession: ' + client.binding!.session_id);
    const submit = async (prompt: string) => {
      try {
        const receipt = await client!.submit(prompt);
        turnId = receipt.turn_id;
        // Covers the server's configurable ten-minute deadline plus shutdown time.
        const event = await client!.waitTurn(turnId, 615_000);
        if (event.type !== 'completed' && values.prompt) process.exitCode = 1;
      } finally {
        turnId = undefined;
      }
    };
    if (values.prompt) {
      await submit(values.prompt);
      return;
    }
    for (;;) {
      let prompt: string;
      try {
        prompt = (await terminal.question('\ntether> ')).trim();
      } catch {
        break;
      }
      if (!prompt) continue;
      if (prompt === '/quit') break;
      if (prompt === '/help') {
        console.log('/quit exits; Ctrl-C cancels the active turn.');
        continue;
      }
      if (prompt.startsWith('/')) {
        console.log('Unsupported command. Use /help.');
        continue;
      }
      try {
        await submit(prompt);
      } catch (error) {
        console.error(failure(error));
      }
    }
  } finally {
    client?.close();
    await host?.close();
    await transport?.close();
    terminal.close();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
