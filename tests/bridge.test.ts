import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';
import { RelayServer } from '../packages/relay/index.js';
import { BridgeClient } from '../packages/client/index.js';
import type { AgentRuntime } from '../packages/runtime-adapter/types.js';
import { fixture } from './helpers.js';
import type { TestContext } from 'node:test';
import type { RelayEvent, WorkspaceIdentity } from '../packages/protocol/index.js';

async function network(
  t: TestContext,
  runtime?: AgentRuntime,
  tls?: { cert: Buffer; key: Buffer },
) {
  const f = await fixture(t);
  const server = new RelayServer({
    statePath: join(f.base, 'remote-state', 'relay.sqlite'),
    runtime,
    tls,
  });
  const device = server.store.provision(f.binding.device_id);
  const url = await server.listen();
  const { session_id: _s, worker_epoch: _e, ...workspace } = f.binding;
  const clients: BridgeClient[] = [];
  t.after(async () => {
    for (const c of clients) c.close();
    await server.close();
  });
  const connect = async (extra: Partial<Parameters<typeof BridgeClient.connect>[0]> = {}) => {
    const client = await BridgeClient.connect({
      url,
      token: device.token,
      host: f.host,
      workspace,
      allowInsecureLoopback: true,
      ...extra,
    });
    clients.push(client);
    return client;
  };
  return { ...f, server, device, url, workspace, connect };
}

void test('fake agent reads, edits and tests exclusively in the client workspace over real WebSocket', async (t) => {
  const f = await network(t);
  await writeFile(join(f.root, 'calc.mjs'), 'export function add(a,b) { return a - b; }\n');
  await writeFile(
    join(f.root, 'calc.test.mjs'),
    "import {add} from './calc.mjs'; if(add(2,3)!==5) process.exit(1);\n",
  );
  const events: RelayEvent[] = [];
  const client = await f.connect({
    onEvent: (e) => {
      assert.ok(f.host.journal.events(e.session_id).some((saved) => saved.cursor === e.cursor));
      events.push(e);
    },
  });
  const receipt = await client.submit('demo', 'stable-message');
  assert.equal((await client.waitTurn(receipt.turn_id)).type, 'completed');
  assert.ok((await readFile(join(f.root, 'calc.mjs'), 'utf8')).includes('return a + b;'));
  assert.equal(events.filter((e) => e.type === 'tool').length, 3);
  const duplicate = await client.submit('demo', 'stable-message');
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.turn_id, receipt.turn_id);
  await assert.rejects(client.submit('different prompt', 'stable-message'), {
    code: 'MESSAGE_CONFLICT',
  });
  await assert.rejects(readFile(join(f.base, 'remote-state', 'calc.mjs')), { code: 'ENOENT' });
});

void test('authentication, hello device binding, and protocol version reject forged clients', async (t) => {
  const f = await network(t);
  await assert.rejects(f.connect({ token: 'invalid' }));
  await assert.rejects(f.connect({ workspace: { ...f.workspace, device_id: randomUUID() } }), {
    code: 'DEVICE_MISMATCH',
  });
  const socket = new WebSocket(f.url, { headers: { Authorization: 'Bearer ' + f.device.token } });
  await once(socket, 'open');
  const { RpcPeer } = await import('../packages/transport/index.js');
  const peer = new RpcPeer(socket);
  try {
    await assert.rejects(peer.request('session.create', f.workspace), {
      code: 'PROTOCOL_MISMATCH',
    });
    await assert.rejects(
      peer.request('connection.hello', { protocol_version: '99', device_id: f.device.device_id }),
      { code: 'PROTOCOL_MISMATCH' },
    );
  } finally {
    peer.close();
    socket.terminate();
  }
});

void test('explicit resume preserves project binding, bumps epoch and does not replay displayed events', async (t) => {
  const f = await network(t);
  await writeFile(join(f.root, 'local.txt'), 'local result');
  let displayed = 0;
  const client = await f.connect({
    onEvent: () => {
      displayed++;
    },
  });
  const receipt = await client.submit('read local.txt');
  await client.waitTurn(receipt.turn_id);
  const count = displayed,
    binding = client.binding!;
  const closed = once(client.peer.socket, 'close');
  client.close();
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(
    f.connect({
      resumeSession: binding.session_id,
      workspace: { ...f.workspace, workspace_id: randomUUID() },
    }),
    { code: 'WORKSPACE_MISMATCH' },
  );
  const restored = await f.connect({
    resumeSession: binding.session_id,
    onEvent: () => {
      displayed++;
    },
  });
  assert.equal(restored.binding!.worker_epoch, binding.worker_epoch + 1);
  assert.equal(displayed, count);
  assert.equal((await restored.waitTurn(receipt.turn_id, 100)).type, 'completed');
  const replay = (await restored.peer.request('events.resume', {
    session_id: binding.session_id,
    cursor: 0,
  })) as RelayEvent[];
  assert.ok(replay.some((e) => e.type === 'completed'));
  assert.ok(replay.every((e, i) => i === 0 || e.cursor > replay[i - 1]!.cursor));
});

void test('lost tool response is reconciled from the local journal without repeating an effect', async (t) => {
  const runtime: AgentRuntime = {
    kind: 'fake',
    async run(turn) {
      await turn.execute('run_command', {
        program: 'node',
        args: ['-e', "require('fs').appendFileSync('count','x')"],
      });
    },
  };
  const f = await network(t, runtime);
  const client = await f.connect();
  const original = f.host.execute.bind(f.host);
  const closed = once(client.peer.socket, 'close');
  f.host.execute = async (raw) => {
    const result = await original(raw);
    client.peer.socket.terminate(); // Result is durable locally but never sent to the relay.
    return result;
  };
  const receipt = await client.submit('one effect');
  await assert.rejects(client.waitTurn(receipt.turn_id), { code: 'WORKSPACE_OFFLINE' });
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.server.store.pending(client.binding!.session_id).length, 1);
  f.host.execute = original;
  const restored = await f.connect({ resumeSession: client.binding!.session_id });
  assert.equal(f.server.store.pending(restored.binding!.session_id).length, 0);
  assert.equal(await readFile(join(f.root, 'count'), 'utf8'), 'x');
});

void test('device revocation disconnects an existing socket and prevents reconnect', async (t) => {
  const f = await network(t);
  const client = await f.connect();
  const closed = once(client.peer.socket, 'close');
  f.server.revoke(f.device.device_id);
  await closed;
  await assert.rejects(f.connect());
});

void test('the same session cannot be taken over by another live connection', async (t) => {
  const f = await network(t);
  const client = await f.connect();
  await assert.rejects(f.connect({ resumeSession: client.binding!.session_id }), {
    code: 'SESSION_BUSY',
  });
});

void test('TLS certificate validation is required, and WSS works with an explicitly trusted test CA', async (t) => {
  const f = await fixture(t);
  const certPath = join(f.base, 'tls.crt'),
    keyPath = join(f.base, 'tls.key');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  const cert = await readFile(certPath),
    key = await readFile(keyPath);
  const server = new RelayServer({
    statePath: join(f.base, 'remote', 'relay.sqlite'),
    tls: { cert, key },
  });
  const device = server.store.provision(f.binding.device_id);
  const url = await server.listen();
  const { session_id: _s, worker_epoch: _e, ...workspace } = f.binding;
  let client: BridgeClient | undefined;
  try {
    await assert.rejects(
      BridgeClient.connect({ url, token: device.token, host: f.host, workspace }),
    );
    client = await BridgeClient.connect({
      url,
      token: device.token,
      host: f.host,
      workspace,
      ca: cert,
    });
    const turn = await client.submit('hello');
    assert.equal((await client.waitTurn(turn.turn_id)).type, 'completed');
  } finally {
    client?.close();
    await server.close();
  }
});

void test('non-loopback plaintext transport is rejected before networking', async (t) => {
  const f = await network(t);
  await assert.rejects(
    f.connect({ url: 'ws://example.com/v1/bridge', allowInsecureLoopback: true }),
    { code: 'TLS_REQUIRED' },
  );
});

void test('all callers waiting for the same turn receive its durable terminal event', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const f = await network(t, { kind: 'fake', run: () => gate });
  const client = await f.connect();
  const receipt = await client.submit('one turn, two observers');
  const completed = Promise.all([
    client.waitTurn(receipt.turn_id, 1000),
    client.waitTurn(receipt.turn_id, 1000),
  ]);
  release();
  const events = await completed;
  assert.equal(events[0]!.type, 'completed');
  assert.deepEqual(events[0], events[1]);
  assert.ok(
    f.host.journal.events(client.binding!.session_id).some((e) => e.cursor === events[0]!.cursor),
  );
});

void test('one turn observer timing out does not remove other observers or cancel the turn', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const f = await network(t, { kind: 'fake', run: () => gate });
  const client = await f.connect();
  const receipt = await client.submit('independent wait deadlines');
  const longer = client.waitTurn(receipt.turn_id, 1500);
  await assert.rejects(client.waitTurn(receipt.turn_id, 20), { code: 'TURN_TIMEOUT' });
  release();
  assert.equal((await longer).type, 'completed');
});

void test('closing a client rejects every turn observer and remains safe to repeat', async (t) => {
  const f = await network(t);
  const client = await f.connect();
  const turnId = randomUUID();
  const waits = [
    assert.rejects(client.waitTurn(turnId, 1000), { code: 'WORKSPACE_OFFLINE' }),
    assert.rejects(client.waitTurn(turnId, 1000), { code: 'WORKSPACE_OFFLINE' }),
    assert.rejects(client.waitTurn(randomUUID(), 1000), { code: 'WORKSPACE_OFFLINE' }),
  ];
  client.close();
  client.close();
  waits.push(assert.rejects(client.waitTurn(randomUUID(), 1000), { code: 'WORKSPACE_OFFLINE' }));
  await Promise.all(waits);
});

void test('turn waits reject invalid deadlines and bound observers without leaking expired slots', async (t) => {
  const f = await network(t);
  const client = await f.connect();
  const turnId = randomUUID();
  for (const timeout of [0, -1, NaN, Infinity, 0.5, 2_147_483_648]) {
    await assert.rejects(client.waitTurn(turnId, timeout), { code: 'INVALID_ARGUMENT' });
  }
  const expiring = assert.rejects(client.waitTurn(turnId, 20), { code: 'TURN_TIMEOUT' });
  const pending = Array.from({ length: 63 }, () =>
    assert.rejects(client.waitTurn(turnId, 1000), { code: 'WORKSPACE_OFFLINE' }),
  );
  await assert.rejects(client.waitTurn(turnId, 1000), { code: 'RESOURCE_LIMIT' });
  await expiring;
  pending.push(assert.rejects(client.waitTurn(turnId, 1000), { code: 'WORKSPACE_OFFLINE' }));
  client.close();
  await Promise.all(pending);
});

void test('session discovery is authenticated, exact-workspace scoped and does not attach or run work', async (t) => {
  let runs = 0;
  const f = await network(t, {
    kind: 'fake',
    async run() {
      runs++;
    },
  });
  const options = {
    url: f.url,
    token: f.device.token,
    workspace: f.workspace,
    allowInsecureLoopback: true,
  };
  assert.deepEqual(await BridgeClient.listSessions(options), []);
  assert.deepEqual(f.server.store.sessions(f.workspace), []);
  const client = await f.connect();
  const expected = {
    session_id: client.binding!.session_id,
    worker_epoch: 1,
    latest_turn_state: 'NEW',
    unresolved_operations: 0,
    connected: true,
  };
  const variants: WorkspaceIdentity[] = [
    { ...f.workspace, workspace_id: randomUUID() },
    { ...f.workspace, workspace_generation: 2 },
    { ...f.workspace, execution_target_id: randomUUID() },
    { ...f.workspace, policy_revision: 2 },
  ];
  for (const workspace of variants) f.server.store.create(workspace);
  const other = f.server.store.provision('other-device');
  f.server.store.create({ ...f.workspace, device_id: other.device_id });
  assert.deepEqual(await BridgeClient.listSessions(options), [expected]);
  assert.deepEqual(await BridgeClient.listSessions(options), [expected]);
  assert.equal(f.server.store.sessions(f.workspace).length, 1);
  assert.equal(f.server.store.session(expected.session_id, f.device.device_id).worker_epoch, 1);
  assert.equal(runs, 0);
  assert.deepEqual(f.host.journal.counts(), []);
  await assert.rejects(BridgeClient.listSessions({ ...options, token: 'bad-token' }));
  await assert.rejects(
    BridgeClient.listSessions({
      ...options,
      workspace: { ...f.workspace, device_id: other.device_id },
    }),
    { code: 'DEVICE_MISMATCH' },
  );
  await assert.rejects(
    client.peer.request('session.list', { ...f.workspace, device_id: other.device_id }),
    { code: 'DEVICE_MISMATCH' },
  );
  assert.deepEqual(
    await BridgeClient.listSessions({
      ...options,
      workspace: { ...f.workspace, workspace_id: 'unknown-project' },
    }),
    [],
  );
});

void test('session discovery reports pending effects and turn state without replaying, resolving or leaking content', async (t) => {
  const f = await network(t);
  const binding = f.server.store.create(f.workspace);
  const turn = f.server.store.turn(binding.session_id, randomUUID(), 'private-prompt');
  f.server.store.finishTurn(turn.turn_id, 'INTERRUPTED');
  const operation = f.operation(
    'run_command',
    { program: 'private-program', args: [] },
    {
      ...binding,
      turn_id: turn.turn_id,
    },
  );
  f.server.store.dispatch(operation);
  f.server.store.result({ operation_id: operation.operation_id, status: 'UNKNOWN' });
  const list = await BridgeClient.listSessions({
    url: f.url,
    token: f.device.token,
    workspace: f.workspace,
    allowInsecureLoopback: true,
  });
  assert.deepEqual(list, [
    {
      session_id: binding.session_id,
      worker_epoch: 1,
      latest_turn_state: 'INTERRUPTED',
      unresolved_operations: 1,
      connected: false,
    },
  ]);
  assert.equal(f.server.store.pending(binding.session_id).length, 1);
  assert.equal(f.server.store.events(binding.session_id, 0).length, 0);
  assert.equal(f.host.journal.get(operation.operation_id), undefined);
  assert.ok(!JSON.stringify(list).includes('private-'));
  await assert.rejects(f.connect({ resumeSession: binding.session_id }), {
    code: 'RECONCILIATION_REQUIRED',
  });
});
