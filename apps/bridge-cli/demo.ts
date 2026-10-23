import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RelayServer } from '../../packages/relay/index.js';
import { LocalHost } from '../../packages/local-host/index.js';
import { BridgeClient } from '../../packages/client/index.js';
import { terminalText } from '../../packages/diagnostics/index.js';

export async function runDemo(): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'personal-relay-demo-'));
  const project = join(base, 'local-project');
  await mkdir(project);
  await writeFile(join(project, 'calc.mjs'), 'export function add(a, b) { return a - b; }\n');
  await writeFile(
    join(project, 'calc.test.mjs'),
    "import assert from 'node:assert/strict';\nimport { add } from './calc.mjs';\nassert.equal(add(2, 3), 5);\n",
  );
  const relay = new RelayServer({ statePath: join(base, 'remote-state', 'relay.sqlite') });
  const device = relay.store.provision();
  const host = new LocalHost({
    root: project,
    journalPath: join(base, 'local-state', 'operations.sqlite'),
    approve: async (request) => {
      process.stdout.write(
        '\n[演示专用批准：仅限临时项目]\n' + terminalText(request.preview) + '\n',
      );
      return true;
    },
  });
  let client: BridgeClient | undefined;
  try {
    const url = await relay.listen();
    process.stdout.write(
      'Fake Agent + 真实本地文件/进程 + 鉴权 WebSocket（loopback，无 Claude 请求）\n',
    );
    client = await BridgeClient.connect({
      url,
      token: device.token,
      host,
      allowInsecureLoopback: true,
      workspace: {
        device_id: device.device_id,
        workspace_id: randomUUID(),
        workspace_generation: 1,
        execution_target_id: randomUUID(),
        policy_revision: 1,
      },
      onEvent: (event) => {
        if (event.type === 'text')
          process.stdout.write(terminalText((event.data as { text: string }).text));
        else
          process.stdout.write(
            '\n[' + event.type + '] ' + terminalText(JSON.stringify(event.data)) + '\n',
          );
      },
    });
    const turn = await client.submit('demo');
    const completed = await client.waitTurn(turn.turn_id);
    if (
      completed.type !== 'completed' ||
      !(await readFile(join(project, 'calc.mjs'), 'utf8')).includes('return a + b;')
    ) {
      throw new Error('Demo did not complete.');
    }
    process.stdout.write('\n演示验收通过；临时项目和状态将清理。\n');
  } finally {
    client?.close();
    await host.close();
    await relay.close();
    await rm(base, { recursive: true, force: true });
  }
}
