import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as httpServer, get, request } from 'node:http';
import { createConnection, createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { connectSocks, startProxy } from '../src/proxy.js';
import { connectProxy, listen, until } from './helpers.js';

test('CONNECT streams bytes with backpressure and closes both sides', { timeout: 10_000 }, async t => {
  let targetClosed = false;
  const port = await listen(t, createServer(socket => {
    socket.once('close', () => { targetClosed = true; });
    socket.pipe(socket);
  }));
  const proxy = await startProxy(async (host, destination) => {
    assert.equal(host, 'upstream.example'); assert.equal(destination, 443);
    const socket = createConnection({ host: '127.0.0.1', port });
    await once(socket, 'connect'); return socket;
  });
  t.after(proxy.close);
  const result = await connectProxy(proxy.url, 'upstream.example:443');
  assert.equal(result.status, 200);
  const data = Buffer.alloc(2 * 1024 * 1024, 0x61);
  const chunks: Buffer[] = [result.head];
  let received = result.head.length;
  result.socket.on('data', chunk => { chunks.push(chunk); received += chunk.length; });
  result.socket.write(data);
  await until(() => received === data.length);
  assert.deepEqual(Buffer.concat(chunks), data);
  result.socket.destroy();
  await until(() => targetClosed);
});

test('pipelined CONNECT payload is forwarded exactly once', { timeout: 5_000 }, async t => {
  const port = await listen(t, createServer(socket => socket.pipe(socket)));
  const proxy = await startProxy(async () => {
    const socket = createConnection({ host: '127.0.0.1', port });
    await once(socket, 'connect'); return socket;
  });
  t.after(proxy.close);
  const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(proxy.url).port) });
  t.after(() => socket.destroy());
  let data = '';
  socket.on('data', chunk => { data += String(chunk); });
  socket.write('CONNECT upstream.example:443 HTTP/1.1\r\nHost: upstream.example\r\n\r\npipelined');
  await until(() => data.endsWith('pipelined'));
  assert.equal(data, 'HTTP/1.1 200 Connection Established\r\n\r\npipelined');
});

test('upstream EOF drains a large response to a slow client without truncation', { timeout: 5_000 }, async t => {
  const expected = Buffer.alloc(2 * 1024 * 1024, 0x62);
  const port = await listen(t, createServer(socket => socket.end(expected)));
  const proxy = await startProxy(async () => {
    const socket = createConnection({ host: '127.0.0.1', port });
    await once(socket, 'connect'); return socket;
  });
  t.after(proxy.close);
  const result = await connectProxy(proxy.url, 'upstream.example:443');
  assert.equal(result.status, 200);
  result.socket.pause();
  await delay(100);
  const chunks = [result.head];
  result.socket.on('data', chunk => chunks.push(chunk));
  const ended = once(result.socket, 'end');
  result.socket.resume();
  await ended;
  assert.deepEqual(Buffer.concat(chunks), expected);
});

test('invalid authorities and relative HTTP URLs never reach the upstream', async t => {
  const proxy = await startProxy(async () => { throw new Error('Must not dial'); });
  t.after(proxy.close);
  for (const target of ['user:password@example.com:443', 'example.com:0', 'example.com:65536', 'example.com:443/path']) {
    const result = await connectProxy(proxy.url, target);
    assert.equal(result.status, 400); result.socket.destroy();
  }
  const status = await new Promise<number>(resolve => get(proxy.url, res => { res.resume(); resolve(res.statusCode!); }));
  assert.equal(status, 400);
});

test('ordinary HTTP streams through the VPS dialer and removes hop-by-hop credentials', async t => {
  let calls = 0;
  const expected = Buffer.alloc(1024 * 1024, 'x');
  const port = await listen(t, httpServer((req, res) => {
    assert.equal(req.url, '/stream?x=1');
    assert.equal(req.headers.host, 'http-origin.invalid');
    assert.equal(req.headers['proxy-authorization'], undefined);
    assert.equal(req.headers['x-hop'], undefined);
    assert.equal(req.headers.authorization, 'Bearer synthetic-test');
    res.writeHead(429, { 'content-type': 'text/event-stream', 'retry-after': '12', connection: 'close, x-hop', 'x-hop': 'removed' });
    req.pipe(res);
  }));
  const proxy = await startProxy(async (host, destination) => {
    calls++;
    assert.equal(host, 'http-origin.invalid'); assert.equal(destination, 80);
    const socket = createConnection({ host: '127.0.0.1', port });
    await once(socket, 'connect'); return socket;
  });
  t.after(proxy.close);
  const response = await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const req = request(proxy.url, { method: 'POST', path: 'http://http-origin.invalid/stream?x=1', headers: {
      'content-length': expected.length, authorization: 'Bearer synthetic-test',
      'proxy-authorization': 'must-not-reach-origin', connection: 'close, x-hop', 'x-hop': 'removed',
    } }, res => {
      assert.equal(res.headers['retry-after'], '12'); assert.equal(res.headers['x-hop'], undefined);
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end(expected);
  });
  assert.equal(response.status, 429); assert.deepEqual(response.body, expected); assert.equal(calls, 1);
});

test('upstream failure returns 502 without retrying or leaking diagnostics', async t => {
  let calls = 0;
  const proxy = await startProxy(async () => { calls++; throw new Error('private diagnostic'); });
  t.after(proxy.close);
  const result = await connectProxy(proxy.url, 'upstream.example:443');
  assert.equal(result.status, 502); assert.equal(calls, 1); result.socket.destroy();
});

test('client disconnect cancels a connection waiting for the tunnel', { timeout: 5_000 }, async t => {
  let started = false, cancelled = false;
  const proxy = await startProxy(async (_host, _port, signal) => {
    started = true;
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
    throw new Error('cancelled');
  });
  t.after(proxy.close);
  const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(proxy.url).port) });
  socket.write('CONNECT upstream.example:443 HTTP/1.1\r\n\r\n');
  await until(() => started); socket.destroy();
  await until(() => cancelled);
});

test('SOCKS handles fragmented headers, remote DNS and coalesced target bytes', { timeout: 5_000 }, async t => {
  let host = '', destination = 0;
  const port = await listen(t, createServer(socket => {
    socket.once('data', async greeting => {
      assert.deepEqual(greeting, Buffer.from([5, 1, 0]));
      socket.write(Buffer.from([5])); await delay(10); socket.write(Buffer.from([0]));
      socket.once('data', request => {
        assert.equal(request[3], 3);
        host = request.subarray(5, 5 + request[4]!).toString();
        destination = request.readUInt16BE(5 + request[4]!);
        socket.write(Buffer.concat([Buffer.from([5, 0, 0, 3, 3, 102, 111, 111, 0, 0]), Buffer.from('first bytes')]));
      });
    });
  }));
  const socket = await connectSocks(port, 'remote-dns.invalid', 443, AbortSignal.timeout(2_000));
  t.after(() => socket.destroy());
  assert.equal(host, 'remote-dns.invalid'); assert.equal(destination, 443);
  const [data] = await once(socket, 'data');
  assert.equal(String(data), 'first bytes');
});

test('SOCKS rejects malformed, denied and incomplete handshakes', async t => {
  for (const reply of [[4, 0], [5, 2], [5]]) {
    const port = await listen(t, createServer(socket => socket.once('data', () => socket.end(Buffer.from(reply)))));
    await assert.rejects(connectSocks(port, 'example.com', 443, AbortSignal.timeout(1_000)));
  }
  const port = await listen(t, createServer(socket => socket.once('data', () => {
    socket.write(Buffer.from([5, 0]));
    socket.once('data', () => socket.end(Buffer.from([5, 5, 0, 1])));
  })));
  await assert.rejects(connectSocks(port, 'example.com', 443, AbortSignal.timeout(1_000)), /unavailable/);
});

test('silent SOCKS handshakes time out and release the socket', { timeout: 5_000 }, async t => {
  let closed = false;
  const port = await listen(t, createServer(socket => {
    socket.resume(); socket.once('close', () => { closed = true; });
  }));
  await assert.rejects(connectSocks(port, 'example.com', 443, AbortSignal.timeout(100)));
  await until(() => closed);
});
