import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { Binding, Operation, ToolName } from '../packages/protocol/index.js';
import { LocalHost } from '../packages/local-host/index.js';
import type { HostOptions } from '../packages/local-host/index.js';

export async function fixture(t: TestContext, options: Partial<HostOptions> = {}) {
  const base = await mkdtemp(join(tmpdir(), 'relay-test-'));
  const root = join(base, 'workspace');
  await mkdir(root);
  const binding: Binding = {
    session_id: randomUUID(),
    device_id: randomUUID(),
    workspace_id: randomUUID(),
    workspace_generation: 1,
    worker_epoch: 1,
    execution_target_id: randomUUID(),
    policy_revision: 1,
  };
  const journalPath = join(base, 'state', 'operations.sqlite');
  const host = new LocalHost({ root, journalPath, approve: async () => true, ...options });
  host.bind(binding);
  t.after(async () => {
    await host.close();
    await rm(base, { recursive: true, force: true });
  });
  const operation = (
    tool: ToolName,
    input: unknown,
    extra: Partial<Operation> = {},
  ): Operation => ({
    ...binding,
    operation_id: randomUUID(),
    turn_id: randomUUID(),
    tool,
    input,
    ...extra,
  });
  return { base, root, binding, journalPath, host, operation };
}
