import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { connect as connectTls } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startProxy } from '../src/proxy.js';
import { SshTunnel, sshArgs } from '../src/tunnel.js';
import { certificate, connectProxy, listen, sshFixture, until } from './helpers.js';

test('SSH arguments require host verification, keepalive and isolated loopback forwarding', () => {
  const args = sshArgs('my-vps', 12345, '/tmp/config with spaces');
  for (const arg of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ExitOnForwardFailure=yes', 'ServerAliveInterval=15', 'ServerAliveCountMax=3', 'ForwardAgent=no', 'ControlPath=none', '127.0.0.1:12345', '/tmp/config with spaces']) assert.ok(args.includes(arg));
  assert.deepEqual(args.slice(-2), ['--', 'my-vps']);
  for (const host of ['-oProxyCommand=evil', 'user@host;command', 'host\nother', '']) assert.throws(() => sshArgs(host, 12345));
});

test('real OpenSSH transports TLS, recovers new connections and never replays a broken stream', { timeout: 20_000 }, async t => {
  const fixture = await sshFixture(t);
  const credentials = await certificate(fixture.directory);
  const requests: string[] = [];
  const upstream = createServer(credentials, (req, res) => {
    requests.push(req.url!);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: first\n\n');
    if (req.url === '/complete') res.end('data: done\n\n');
  });
  const targetPort = await listen(t, upstream);
  const children: ChildProcess[] = [], messages: string[] = [];
  const tunnel = new SshTunnel({ destination: 'test-vps', config: fixture.config, retryMs: 200, connectTimeoutMs: 1_000, log: message => messages.push(message), launch: args => {
    const child = spawn('ssh', args, { stdio: 'ignore' }); children.push(child); return child;
  } });
  t.after(() => tunnel.stop());
  await tunnel.start(5_000);
  const proxy = await startProxy((host, port, signal) => tunnel.connect(host, port, signal));
  t.after(proxy.close);
  const first = await connectProxy(proxy.url, `localhost:${targetPort}`);
  assert.equal(first.status, 200);
  const stream = connectTls({ socket: first.socket, servername: 'localhost', ca: credentials.cert });
  stream.on('error', () => {});
  await once(stream, 'secureConnect');
  assert.equal(stream.authorized, true);
  let partial = '';
  stream.on('data', chunk => { partial += String(chunk); });
  stream.write('GET /interrupted HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
  await until(() => partial.includes('data: first'));
  await delay(1_100);
  assert.equal(stream.destroyed, false, 'establishment timeout must not terminate an idle established stream');
  const streamClosed = new Promise<void>(resolve => stream.once('close', () => resolve()));
  children[0]!.kill('SIGKILL');
  await streamClosed;
  await until(() => messages.some(message => message.includes('disconnected')));
  // A new CONNECT can wait for recovery; the existing TLS stream is not recreated.
  const second = await connectProxy(proxy.url, `localhost:${targetPort}`);
  assert.equal(second.status, 200);
  const recovered = connectTls({ socket: second.socket, servername: 'localhost', ca: credentials.cert });
  await once(recovered, 'secureConnect');
  let body = '';
  recovered.on('data', chunk => { body += String(chunk); });
  recovered.write('GET /complete HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
  await once(recovered, 'end');
  assert.ok(body.includes('data: done'));
  assert.deepEqual(requests, ['/interrupted', '/complete']);
  assert.ok(children.length >= 2);
  await tunnel.stop();
  const count = children.length;
  await delay(300);
  assert.equal(children.length, count);
});

test('missing SSH executable fails promptly instead of reconnecting forever', { timeout: 3_000 }, async () => {
  const tunnel = new SshTunnel({ destination: 'test-vps', launch: () => spawn('/does-not-exist/tether-ssh', []) });
  await assert.rejects(tunnel.start(1_000), { code: 'ENOENT' });
  await tunnel.stop();
});

test('stop cancels initial connection attempts and reaps a stuck SSH process', { timeout: 5_000 }, async () => {
  let child: ChildProcess | undefined;
  const tunnel = new SshTunnel({ destination: 'test-vps', launch: () => {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); return child;
  } });
  const starting = assert.rejects(tunnel.start(3_000));
  await until(() => !!child);
  await tunnel.stop(); await starting;
  assert.notEqual(child!.signalCode, null);
});
