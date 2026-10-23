import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { ClaudeRuntime } from '../packages/runtime-adapter/supervisor.js';
import type { RuntimeTurn } from '../packages/runtime-adapter/types.js';
import { RelayServer } from '../packages/relay/index.js';
import { BridgeClient } from '../packages/client/index.js';
import { LocalHost } from '../packages/local-host/index.js';
import type { Binding } from '../packages/protocol/index.js';

async function assertWorkerProcessesStopped(remote: string): Promise<void> {
  const records = (readdirSync(remote, { recursive: true }) as string[]).filter((path) =>
    path.endsWith('synthetic-processes.json'),
  );
  assert.ok(records.length > 0, 'synthetic runtime recorded its process IDs');
  for (const record of records) {
    const pids = JSON.parse(readFileSync(join(remote, record), 'utf8')) as number[];
    for (const pid of pids) {
      let stopped = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          if (/\) [ZX] /.test(await readFile('/proc/' + pid + '/stat', 'utf8'))) {
            stopped = true;
            break;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            stopped = true;
            break;
          }
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(stopped, 'CLI and MCP processes must stop with the turn');
    }
  }
}

function setup(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), 'tether-supervisor-'));
  const root = join(base, 'local-project');
  mkdirSync(root);
  const remote = join(base, 'remote-infrastructure');
  const executable = join(base, 'synthetic-claude.mjs');
  writeFileSync(
    executable,
    '#!/usr/bin/env node\nimport ' +
      JSON.stringify(new URL('./fixtures/claude-cli.js', import.meta.url).href) +
      ';\n',
    { mode: 0o700 },
  );
  const options = {
    executable,
    stateDirectory: remote,
    mcpWorkerPath: fileURLToPath(new URL('../apps/mcp-bridge/worker.js', import.meta.url)),
    env: { HOME: base, PATH: process.env.PATH },
    timeoutMs: 10_000,
  };
  // Tests are compiled to dist/tests; the worker is in dist/apps.
  const host = new LocalHost({
    root,
    journalPath: join(base, 'local-state', 'operations.sqlite'),
    approve: async () => true,
  });
  const binding: Binding = {
    device_id: 'device',
    workspace_id: 'workspace',
    workspace_generation: 1,
    execution_target_id: 'local',
    policy_revision: 1,
    session_id: randomUUID(),
    worker_epoch: 1,
  };
  host.bind(binding);
  let runtime = new ClaudeRuntime(options);
  const outputs: string[] = [];
  const turn = (prompt: string, signal = new AbortController().signal): RuntimeTurn => {
    const turnId = randomUUID();
    return {
      binding: { ...binding },
      turnId,
      prompt,
      signal,
      text: (text) => outputs.push(text),
      execute: (tool, input) =>
        host.execute({ ...binding, turn_id: turnId, operation_id: randomUUID(), tool, input }),
      cancelTools: () => host.cancelTurn(turnId),
    };
  };
  t.after(async () => {
    await runtime.close();
    await host.close();
    rmSync(base, { recursive: true, force: true });
  });
  return {
    base,
    root,
    remote,
    options,
    host,
    binding,
    outputs,
    turn,
    runtime: () => runtime,
    restart: async () => {
      await runtime.close();
      runtime = new ClaudeRuntime(options);
    },
  };
}

void test('candidate CLI -> real MCP subprocess -> relay -> local host edits and tests only the client project', async (t) => {
  const f = setup(t);
  writeFileSync(join(f.root, 'calc.mjs'), 'export function add(a,b){ return a - b; }\n');
  writeFileSync(
    join(f.root, 'calc.test.mjs'),
    "import {add} from './calc.mjs'; if(add(2,3)!==5) process.exit(1);\n",
  );
  const server = new RelayServer({
    statePath: join(f.base, 'relay-state', 'relay.sqlite'),
    runtime: f.runtime(),
  });
  const device = server.store.provision(f.binding.device_id);
  const { session_id: _session, worker_epoch: _epoch, ...workspace } = f.binding;
  let client: BridgeClient | undefined;
  try {
    client = await BridgeClient.connect({
      url: await server.listen(),
      token: device.token,
      workspace,
      host: f.host,
      allowInsecureLoopback: true,
    });
    assert.equal(client.runtime, 'claude');
    const receipt = await client.submit('edit-test');
    const event = await client.waitTurn(receipt.turn_id, 15_000);
    assert.equal(event.type, 'completed', JSON.stringify(event.data));
    assert.match(readFileSync(join(f.root, 'calc.mjs'), 'utf8'), /return a \+ b/);
    assert.deepEqual(f.host.journal.counts(), [{ state: 'SUCCEEDED', n: 4 }]);
    const remoteFiles = readdirSync(f.remote, { recursive: true }) as string[];
    assert.ok(!remoteFiles.some((path) => /calc\.|channel\.json|mcp\.json|turn-/.test(path)));
    await assertWorkerProcessesStopped(f.remote);
  } finally {
    client?.close();
    await server.close();
  }
});

void test('runtime mapping survives restart and resumes only the explicit original conversation', async (t) => {
  const f = setup(t);
  await f.runtime().run(f.turn('remember local-marker'));
  await f.restart();
  f.binding.worker_epoch++;
  f.host.bind(f.binding);
  await f.runtime().run(f.turn('recall'));
  assert.ok(f.outputs.includes('marker=local-marker;resumes=1'));
  const changed = f.turn('recall');
  changed.binding.workspace_id = 'other-workspace';
  await assert.rejects(f.runtime().run(changed), { code: 'WORKSPACE_MISMATCH' });
});

void test('interrupted CLI requires explicit reconnect; unapproved tool lists never reach local execution', async (t) => {
  const f = setup(t);
  await assert.rejects(f.runtime().run(f.turn('crash')));
  await assert.rejects(f.runtime().run(f.turn('recall')), {
    code: 'RUNTIME_RECONCILIATION_REQUIRED',
  });
  f.binding.worker_epoch++;
  f.host.bind(f.binding);
  await f.runtime().run(f.turn('recall'));
  f.binding.session_id = randomUUID();
  f.host.bind(f.binding);
  await assert.rejects(f.runtime().run(f.turn('bad-tools')), { code: 'REMOTE_TOOL_EXPOSED' });
  assert.deepEqual(f.host.journal.counts(), []);
});

void test('cancelling a remote CLI cancels its active local process and removes ephemeral capabilities', async (t) => {
  const f = setup(t);
  const controller = new AbortController();
  const pending = f.runtime().run(f.turn('long-command', controller.signal));
  const outcome = assert.rejects(pending, { code: 'CANCELLED' });
  let pid = 0;
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      pid = Number(readFileSync(join(f.root, 'local-command.pid'), 'utf8'));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.ok(pid > 0, 'local command started through the MCP subprocess');
  controller.abort();
  await outcome;
  try {
    assert.match(await readFile('/proc/' + pid + '/stat', 'utf8'), /\) Z /);
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
  }
  assert.ok(f.host.journal.counts().some((row) => row.state === 'CANCELLED'));
  await assertWorkerProcessesStopped(f.remote);
  assert.ok(
    !(readdirSync(f.remote, { recursive: true }) as string[]).some((path) => /turn-/.test(path)),
  );
});

void test('runtime timeout reaps its process and a credential override is rejected before execution', async (t) => {
  const f = setup(t);
  const short = new ClaudeRuntime({
    ...f.options,
    stateDirectory: join(f.base, 'timeout-runtime'),
    timeoutMs: 250,
  });
  try {
    await assert.rejects(short.run(f.turn('hang')), { code: 'RUNTIME_TIMEOUT' });
  } finally {
    await short.close();
  }
  const contaminated = new ClaudeRuntime({
    ...f.options,
    stateDirectory: join(f.base, 'other-runtime'),
    env: { ANTHROPIC_API_KEY: 'secret-never-print' },
  });
  try {
    await assert.rejects(
      contaminated.run(f.turn('edit-test')),
      (error: unknown) =>
        error instanceof Error &&
        !error.message.includes('secret-never-print') &&
        'code' in error &&
        error.code === 'AUTH_CONFIG_CONFLICT',
    );
  } finally {
    await contaminated.close();
  }
  const apiExecutable = join(f.base, 'api-auth.mjs');
  writeFileSync(
    apiExecutable,
    '#!/usr/bin/env node\nconsole.log(JSON.stringify({loggedIn:true,authMethod:"api_key",token:"secret-never-print"}));\n',
    { mode: 0o700 },
  );
  const apiAuth = new ClaudeRuntime({
    ...f.options,
    executable: apiExecutable,
    stateDirectory: join(f.base, 'api-runtime'),
  });
  try {
    await assert.rejects(
      apiAuth.run(f.turn('edit-test')),
      (error: unknown) =>
        error instanceof Error &&
        !error.message.includes('secret-never-print') &&
        'code' in error &&
        error.code === 'AUTH_REQUIRED',
    );
  } finally {
    await apiAuth.close();
  }
  assert.deepEqual(f.host.journal.counts(), []);
});
