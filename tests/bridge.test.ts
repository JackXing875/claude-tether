import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { localSocket, startBridge } from '../src/bridge.js';
import { listen, until } from './helpers.js';

test('Unix bridge drains a large response to a slow reader without truncation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tether-bridge-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const expected = Buffer.alloc(2 * 1024 * 1024, 's');
  const port = await listen(t, createServer(socket => socket.end(expected)));
  const path = join(directory, 'bridge.sock');
  const bridge = await startBridge(signal => localSocket(port, signal), path);
  t.after(bridge.close);
  const client = await localSocket(path, AbortSignal.timeout(2_000));
  t.after(() => client.destroy());
  client.pause(); await delay(100);
  const chunks: Buffer[] = [];
  client.on('data', chunk => chunks.push(chunk));
  const ended = once(client, 'end'); client.resume(); await ended;
  assert.deepEqual(Buffer.concat(chunks), expected);
});

test('bridge cancels a pending SSH connection when the client disconnects', async t => {
  let pending = false, aborted = false;
  const bridge = await startBridge(async signal => {
    pending = true;
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    throw new Error('cancelled');
  });
  t.after(bridge.close);
  const client = createConnection({ host: '127.0.0.1', port: bridge.port! });
  t.after(() => client.destroy());
  await until(() => pending); client.destroy(); await until(() => aborted);
});

test('bridge backpressure preserves a large upload while SSH establishment is delayed', async t => {
  const port = await listen(t, createServer(socket => socket.pipe(socket)));
  const bridge = await startBridge(async signal => {
    await delay(150);
    return localSocket(port, signal);
  });
  t.after(bridge.close);
  const client = createConnection({ host: '127.0.0.1', port: bridge.port! });
  t.after(() => client.destroy());
  const expected = Buffer.alloc(2 * 1024 * 1024, 'u');
  const chunks: Buffer[] = []; let received = 0;
  client.on('data', chunk => { chunks.push(chunk); received += chunk.length; });
  client.write(expected);
  await until(() => received === expected.length);
  assert.deepEqual(Buffer.concat(chunks), expected);
});
