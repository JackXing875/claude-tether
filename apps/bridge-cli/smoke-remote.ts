import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { LocalHost } from '../../packages/local-host/index.js';
import { BridgeClient } from '../../packages/client/index.js';
import type { RelayEvent } from '../../packages/protocol/index.js';

const { values } = parseArgs({
  options: { url: { type: 'string' }, config: { type: 'string' }, ca: { type: 'string' } },
});
if (!values.url || !values.config)
  throw new Error('Required: --url <bridge-url> --config <private-device.json>');
const device = z
  .object({ device_id: z.string(), token: z.string() })
  .strict()
  .parse(JSON.parse(await readFile(values.config, 'utf8')));
const base = await mkdtemp(join(tmpdir(), 'relay-network-smoke-'));
const root = join(base, 'client-project');
await mkdir(root);
await writeFile(join(root, 'calc.mjs'), 'export function add(a, b) { return a - b; }\n');
await writeFile(
  join(root, 'calc.test.mjs'),
  "import assert from 'node:assert/strict'; import {add} from './calc.mjs'; assert.equal(add(2,3),5);\n",
);
const host = new LocalHost({
  root,
  journalPath: join(base, 'state', 'operations.sqlite'),
  // Only this fresh disposable project is eligible for smoke-test approval.
  approve: async (request) => ['edit_text', 'run_command'].includes(request.tool),
});
const events: RelayEvent[] = [];
let client: BridgeClient | undefined;
const start = performance.now();
try {
  client = await BridgeClient.connect({
    url: values.url,
    token: device.token,
    host,
    allowInsecureLoopback: true,
    ca: values.ca ? await readFile(values.ca) : undefined,
    workspace: {
      device_id: device.device_id,
      workspace_id: randomUUID(),
      workspace_generation: 1,
      execution_target_id: randomUUID(),
      policy_revision: 1,
    },
    onEvent: (event) => events.push(event),
  });
  if (client.runtime !== 'fake')
    throw new Error('This smoke test only supports the explicit fake runtime.');
  const turn = await client.submit('demo');
  const result = await client.waitTurn(turn.turn_id);
  const content = await readFile(join(root, 'calc.mjs'), 'utf8');
  if (result.type !== 'completed' || !content.includes('return a + b;'))
    throw new Error('Remote smoke failed.');
  const statuses = host.journal.counts();
  if (statuses.length !== 1 || statuses[0]!.state !== 'SUCCEEDED' || statuses[0]!.n !== 3)
    throw new Error('Unexpected local effects.');
  console.log(
    JSON.stringify(
      {
        passed: true,
        remote_runtime: client.runtime,
        model_requests: 0,
        local_operations_succeeded: 3,
        local_file_changed: true,
        local_test_exit_code: 0,
        event_count: events.length,
        elapsed_ms: Math.round(performance.now() - start),
      },
      null,
      2,
    ),
  );
} finally {
  client?.close();
  await host.close();
  await rm(base, { recursive: true, force: true });
}
