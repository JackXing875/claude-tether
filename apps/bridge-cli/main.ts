import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { terminalText } from '../../packages/diagnostics/index.js';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LocalHost } from '../local-host/index.js';
import { BridgeClient } from './client.js';
import { failure, workspaceSchema } from '../../packages/protocol/index.js';

const { values } = parseArgs({ options: {
  config: { type: 'string' }, state: { type: 'string' }, workspace: { type: 'string', default: process.cwd() },
  url: { type: 'string' }, resume: { type: 'string' }, ca: { type: 'string' },
  'allow-insecure-loopback': { type: 'boolean', default: false },
  'read-only': { type: 'boolean', default: false },
} });
if (!values.config || !values.state || !values.url) throw new Error('Required: --config <device.json> --state <private-directory> --url <wss-url>');
if ((lstatSync(values.config).mode & 0o077) !== 0) throw new Error('Device credential file must have mode 0600.');
const credentials = z.object({ device_id: z.string(), token: z.string().min(32) }).strict().parse(JSON.parse(readFileSync(values.config, 'utf8')));
const root = realpathSync(values.workspace), state = resolve(values.state);
const relativeState = relative(root, state);
if (!relativeState.startsWith('..') && !isAbsolute(relativeState)) throw new Error('Store client state outside the workspace.');
mkdirSync(state, { recursive: true, mode: 0o700 });
const terminal = createInterface({ input: process.stdin, output: process.stdout });
const host = new LocalHost({
  root, journalPath: join(state, 'operations.sqlite'), policy: values['read-only'] ? 'read-only' : 'ask',
  approve: async (approval, signal) => {
    if (!process.stdin.isTTY) return false;
    console.log('\n' + terminalText(approval.preview));
    try { return (await terminal.question('允许这一次本地操作？[y/N] ', { signal })).trim().toLowerCase() === 'y'; }
    catch { return false; }
  },
});
const identityPath = join(state, 'workspace.json');
const policy = values['read-only'] ? 'read-only' : 'ask';
const persistedSchema = z.object({
  root: z.string(), directory_identity: z.string(), policy: z.enum(['ask', 'read-only']), binding: workspaceSchema,
}).strict();
let identity: z.infer<typeof persistedSchema>;
try {
  identity = persistedSchema.parse(JSON.parse(readFileSync(identityPath, 'utf8')));
  if (identity.root !== root || identity.directory_identity !== host.tools.identity() || identity.binding.device_id !== credentials.device_id) {
    throw new Error('Workspace or device changed. Use a new state directory and session.');
  }
  if (identity.policy !== policy) throw new Error('Policy changed. Use a new state directory and session; old approvals cannot be reused.');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await host.close(); terminal.close(); throw error; }
  identity = {
    root, directory_identity: host.tools.identity(), policy, binding: {
      device_id: credentials.device_id, workspace_id: randomUUID(), workspace_generation: 1,
      execution_target_id: randomUUID(), policy_revision: 1,
    },
  };
  writeFileSync(identityPath, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
}
let client: BridgeClient | undefined, turnId: string | undefined;
const interrupt = () => {
  if (client && turnId) void client.cancel(turnId).catch(() => {});
  else terminal.close();
};
terminal.on('SIGINT', interrupt); process.on('SIGINT', interrupt);
try {
  client = await BridgeClient.connect({
    url: values.url, token: credentials.token, workspace: identity.binding, host,
    allowInsecureLoopback: values['allow-insecure-loopback'], ca: values.ca ? readFileSync(values.ca) : undefined,
    resumeSession: values.resume,
    onEvent: (event) => {
      if (event.type === 'text') process.stdout.write(terminalText((event.data as { text: string }).text));
      else console.log('\n[' + event.type + '] ' + terminalText(JSON.stringify(event.data)));
    },
  });
  console.log('\nP1 模拟运行时。支持 demo、read <相对路径>、/quit。');
  console.log('项目：' + terminalText(root) + '\n会话：' + client.binding!.session_id);
  for (;;) {
    let prompt: string;
    try { prompt = (await terminal.question('\nbridge> ')).trim(); } catch { break; }
    if (!prompt) continue;
    if (prompt === '/quit') break;
    if (prompt.startsWith('/')) { console.log('当前不支持此斜杠命令。'); continue; }
    try {
      const receipt = await client.submit(prompt); turnId = receipt.turn_id;
      if (receipt.created) await client.waitTurn(turnId);
      else console.log('已有请求：' + receipt.state);
    } catch (error) { console.error(failure(error)); }
    finally { turnId = undefined; }
  }
} finally {
  client?.close(); await host.close(); terminal.close(); process.off('SIGINT', interrupt);
}
