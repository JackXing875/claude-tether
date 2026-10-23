import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSshTunnel, validateSshOptions } from '../packages/transport/ssh.js';
import { connectionPlan } from '../apps/cli/connection.js';

void test('SSH aliases and ports cannot become command options; identity ignores ephemeral ports', () => {
  for (const alias of ['-oProxyCommand=bad', 'user@host', 'host;command', 'host name', ''])
    assert.throws(() => validateSshOptions({ alias }), { code: 'USAGE' });
  for (const relayPort of [0, -1, 65536, NaN, 1.5])
    assert.throws(() => validateSshOptions({ alias: 'vps', relayPort }), { code: 'USAGE' });
  assert.throws(() => connectionPlan({ ssh: 'vps', url: 'wss://example/v1/bridge' }), {
    code: 'USAGE',
  });
  assert.throws(() => connectionPlan({ ssh: 'vps', ca: '/certificate' }), { code: 'USAGE' });
  assert.throws(() => connectionPlan({ url: 'wss://example/v1/bridge', 'ssh-command': 'ssh' }), {
    code: 'USAGE',
  });
  assert.equal(
    connectionPlan({ ssh: 'vps' }).stateKey,
    connectionPlan({ ssh: 'vps', 'ssh-command': '/windows/ssh.exe', 'relay-port': '8787' })
      .stateKey,
  );
  assert.notEqual(
    connectionPlan({ ssh: 'vps' }).stateKey,
    connectionPlan({ ssh: 'another' }).stateKey,
  );
});

void test('SSH transport forwards bytes through argv-only OpenSSH and closes every child', async () => {
  const base = mkdtempSync(join(tmpdir(), 'tether-ssh-'));
  const executable = join(base, 'ssh fixture.mjs');
  const audit = join(base, 'audit.jsonl');
  writeFileSync(
    executable,
    '#!/usr/bin/env node\nprocess.env.TETHER_SSH_AUDIT=' +
      JSON.stringify(audit) +
      ';\nawait import(' +
      JSON.stringify(new URL('./fixtures/ssh.js', import.meta.url).href) +
      ');\n',
    { mode: 0o700 },
  );
  const remote = createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve));
  const address = remote.address();
  assert.ok(address && typeof address !== 'string');
  const tunnel = await openSshTunnel({ alias: 'test-vps', executable, relayPort: address.port });
  const socket = connect(Number(new URL(tunnel.url).port), '127.0.0.1');
  socket.on('error', () => {});
  try {
    await once(socket, 'connect');
    socket.write('private payload');
    const [bytes] = (await once(socket, 'data')) as [Buffer];
    assert.equal(bytes.toString(), 'private payload');
    const record = JSON.parse(readFileSync(audit, 'utf8')) as { pid: number; args: string[] };
    assert.ok(record.args.includes('StrictHostKeyChecking=yes'));
    assert.ok(record.args.includes('BatchMode=yes'));
    assert.equal(record.args.at(-1), 'test-vps');
    assert.ok(!record.args.join(' ').includes('private payload'));
    await tunnel.close();
    await tunnel.close();
    assert.throws(() => process.kill(record.pid, 0), { code: 'ESRCH' });
  } finally {
    socket.destroy();
    await tunnel.close();
    await new Promise<void>((resolve) => remote.close(() => resolve()));
    rmSync(base, { recursive: true, force: true });
  }
});

void test('missing SSH executable closes the socket without retaining a listener', async () => {
  const tunnel = await openSshTunnel({
    alias: 'vps',
    executable: '/missing/tether-ssh-executable',
  });
  const socket = connect(Number(new URL(tunnel.url).port), '127.0.0.1');
  socket.on('error', () => {});
  try {
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
  } finally {
    socket.destroy();
    await tunnel.close();
  }
});
