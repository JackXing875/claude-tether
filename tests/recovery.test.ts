import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { LocalHost } from '../apps/local-host/index.js';
import { OperationJournal } from '../packages/operation-journal/index.js';
import type { Binding, Operation } from '../packages/protocol/index.js';
import { fixture } from './helpers.js';

test('hard crash after an effect recovers UNKNOWN and blocks effects even with new IDs', async () => {
  const base = await mkdtemp(join(tmpdir(), 'relay-crash-'));
  const root = join(base, 'project');
  await mkdir(root);
  const database = join(base, 'state', 'ops.sqlite');
  const binding: Binding = {
    device_id: 'device', session_id: 'session', workspace_id: 'workspace',
    workspace_generation: 1, worker_epoch: 1, execution_target_id: 'linux', policy_revision: 1,
  };
  const op: Operation = {
    ...binding, operation_id: 'op1', turn_id: 'turn1', tool: 'write_file',
    input: { path: 'effect', content: 'effect already happened', expected_revision: null },
  };
  const crashed = spawnSync(process.execPath, [
    fileURLToPath(new URL('./fixtures/crash-worker.js', import.meta.url)), database, join(root, 'effect'), JSON.stringify(op),
  ]);
  assert.equal(crashed.status, 17);
  const host = new LocalHost({ root, journalPath: database, policy: 'accept-edits' });
  host.bind(binding);
  try {
    const restored = await host.execute(op);
    assert.equal(restored.status, 'UNKNOWN');
    const fresh = await host.execute({ ...op, operation_id: 'new-op', input: { path: 'other', content: 'new', expected_revision: null } });
    assert.equal(fresh.error?.code, 'OUTCOME_UNKNOWN');
    assert.equal(await readFile(join(root, 'effect'), 'utf8'), 'effect already happened');
    await assert.rejects(stat(join(root, 'other')), { code: 'ENOENT' });
  } finally { await host.close(); await rm(base, { recursive: true, force: true }); }
});

test('result survives reopening SQLite after a response is lost', async () => {
  const base = await mkdtemp(join(tmpdir(), 'relay-journal-'));
  const path = join(base, 'state', 'journal.sqlite');
  const op: Operation = {
    device_id: 'device', session_id: 'session', workspace_id: 'workspace',
    workspace_generation: 1, worker_epoch: 1, execution_target_id: 'linux', policy_revision: 1,
    turn_id: 'turn', operation_id: randomUUID(), tool: 'workspace_info', input: {},
  };
  let journal = new OperationJournal(path);
  journal.accept(op);
  const saved = { operation_id: op.operation_id, status: 'SUCCEEDED' as const, output: { marker: 'durable' } };
  journal.finish(saved); journal.close();
  journal = new OperationJournal(path);
  try { assert.deepEqual(journal.accept(op), saved); }
  finally { journal.close(); await rm(base, { recursive: true, force: true }); }
});

test('cancel stops a process group including a child that ignores SIGTERM', async (t) => {
  const f = await fixture(t);
  const op = f.operation('run_command', {
    program: process.execPath,
    args: ['-e', [
      "const {spawn}=require('child_process');",
      'const child=spawn(process.execPath,["-e","process.on(\'SIGTERM\',()=>{});setInterval(()=>{},50)"],{stdio:"inherit"});',
      'require("fs").writeFileSync("child.pid",String(child.pid));',
      'process.on("SIGTERM",()=>{});setInterval(()=>{},50);',
    ].join('')],
    timeout_ms: 5000,
  });
  const pending = f.host.execute(op);
  let pid = 0;
  for (let i = 0; i < 100; i++) {
    try { pid = Number(await readFile(join(f.root, 'child.pid'), 'utf8')); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  assert.ok(pid > 0, 'child has started');
  f.host.cancelTurn(op.turn_id);
  assert.equal((await pending).status, 'CANCELLED');
  try {
    const state = await readFile('/proc/' + pid + '/stat', 'utf8');
    assert.match(state, /\) Z /);
  } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT'); }
});

test('command timeout is distinct from a successful zero-exit result', async (t) => {
  const f = await fixture(t);
  const result = await f.host.execute(f.operation('run_command', {
    program: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeout_ms: 50,
  }));
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error?.code, 'PROCESS_TIMEOUT');
});
