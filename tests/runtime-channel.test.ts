import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeChannel, connectRuntimeChannel } from '../packages/runtime-channel/index.js';
import type { Binding } from '../packages/protocol/index.js';

const binding: Binding = {
  device_id: 'device',
  workspace_id: 'workspace',
  workspace_generation: 1,
  execution_target_id: 'target',
  policy_revision: 1,
  session_id: 'session',
  worker_epoch: 1,
};

void test('runtime channel requires a private capability, verified initialization, exact binding and one connection', async () => {
  let executed = 0;
  const channel = new RuntimeChannel({
    binding,
    turnId: 'turn',
    signal: new AbortController().signal,
    disconnected: () => {},
    execute: async () => {
      executed++;
      return { operation_id: 'operation', status: 'SUCCEEDED' };
    },
  });
  const config = await channel.listen();
  try {
    await assert.rejects(connectRuntimeChannel({ ...config, token: 'x'.repeat(43) }));
    const worker = await connectRuntimeChannel(config);
    try {
      await assert.rejects(worker.execute('workspace_info', {}), { code: 'RUNTIME_NOT_READY' });
      channel.activate();
      await assert.rejects(
        worker.peer.request('tool.call', {
          binding: { ...binding, worker_epoch: 2 },
          turn_id: 'turn',
          tool: 'workspace_info',
          input: {},
        }),
        { code: 'STALE_WORKER' },
      );
      await assert.rejects(
        worker.peer.request('tool.call', {
          binding,
          turn_id: 'other',
          tool: 'workspace_info',
          input: {},
        }),
        { code: 'STALE_WORKER' },
      );
      await assert.rejects(connectRuntimeChannel(config));
      assert.equal(executed, 0);
      assert.equal((await worker.execute('workspace_info', {})).status, 'SUCCEEDED');
      assert.equal(executed, 1);
    } finally {
      worker.close();
    }
  } finally {
    await channel.close();
  }
  await assert.rejects(connectRuntimeChannel(config));
});

void test('a dropped in-flight runtime call cancels instead of reconnecting or replaying it', async () => {
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let executions = 0,
    disconnects = 0;
  const channel = new RuntimeChannel({
    binding,
    turnId: 'turn',
    signal: controller.signal,
    disconnected: () => {
      disconnects++;
      controller.abort();
    },
    execute: async () => {
      executions++;
      started();
      await new Promise<void>((resolve) =>
        controller.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return { operation_id: 'operation', status: 'CANCELLED' };
    },
  });
  const config = await channel.listen();
  channel.activate();
  const worker = await connectRuntimeChannel(config);
  try {
    const outcome = assert.rejects(worker.execute('run_command', { program: 'node' }));
    await ready;
    worker.close();
    await outcome;
    // The close event is observable via abort, not a timing-only sleep.
    if (!controller.signal.aborted)
      await new Promise<void>((resolve) =>
        controller.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    await assert.rejects(connectRuntimeChannel(config));
    assert.equal(executions, 1);
    assert.equal(disconnects, 1);
  } finally {
    controller.abort();
    worker.close();
    await channel.close();
  }
});
