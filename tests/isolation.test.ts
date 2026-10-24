import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { listen, sshFixture, until } from './helpers.js';
import { gpuDevices, namespaceArgs } from '../src/isolation.js';

const cli = new URL('../src/cli.js', import.meta.url).pathname;

test('GPU discovery mounts real NVIDIA UVM names on hosts without NVIDIA hardware', () => {
  const names = ['dxg', 'kfd', 'nvidia0', 'nvidia7', 'nvidiactl', 'nvidia-uvm',
    'nvidia-uvm-tools', 'nvidia-modeset', 'dri/card0', 'dri/renderD128', 'nvidia-caps/nvidia-cap1'];
  const excluded = ['nvidiauvm', 'nvidiauvm-tools', 'nvidiamodeset', 'nvidia-ctl', 'nvidia0-extra', 'unrelated'];
  const paths = names.map(name => `/dev/${name}`).sort();
  // Real character-device aliases in a private /dev make this independent of CI hardware.
  const probe = spawnSync('bwrap', ['--unshare-user', '--unshare-net', '--bind', '/', '/',
    '--dev', '/dev', '--dir', '/dev/dri', '--dir', '/dev/nvidia-caps',
    ...[...names, ...excluded].flatMap(name => ['--dev-bind', '/dev/null', `/dev/${name}`]),
    '--die-with-parent', '--', process.execPath, '--input-type=module', '-e', `
      import { gpuDevices, namespaceArgs } from ${JSON.stringify(new URL('../src/isolation.js', import.meta.url).href)};
      const args = namespaceArgs(['/bin/true']);
      const mounts = args.flatMap((arg, i) => arg === '--dev-bind' ? [args.slice(i + 1, i + 3)] : []);
      console.log(JSON.stringify({ devices: gpuDevices(), mounts }));
    `], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), { devices: paths, mounts: paths.map(path => [path, path]) });
});

test('GPU mounts preserve host device identity inside the isolated namespace', async () => {
  const devices = gpuDevices();
  const expected = await Promise.all(devices.map(async path => ({ path, rdev: (await stat(path)).rdev, character: true })));
  const probe = spawnSync('bwrap', namespaceArgs([process.execPath, '-e', `
    const fs = require('node:fs');
    console.log(JSON.stringify(${JSON.stringify(devices)}.map(path => {
      const s = fs.statSync(path); return { path, rdev: s.rdev, character: s.isCharacterDevice() };
    })));
  `]), { encoding: 'utf8', timeout: 10_000 });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), expected);
});

test('GPU discovery excludes ordinary files, symlinks and symlinked device directories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tether-gpu-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'dxg'), 'not a device');
  await writeFile(join(root, 'nvidia-uvm'), 'not a device');
  await symlink('/dev/null', join(root, 'nvidia0'));
  await symlink('/dev/null', join(root, 'nvidia-uvm-tools'));
  await symlink('/dev', join(root, 'dri'));
  await mkdir(join(root, 'nvidia-caps'));
  await symlink('/dev/zero', join(root, 'nvidia-caps/nvidia-cap1'));
  assert.deepEqual(gpuDevices(root), []);
});

test('isolated Claude and tools use SSH for HTTP while direct IPv4, IPv6, UDP and host loopback fail closed', { timeout: 15_000 }, async t => {
  const fixture = await sshFixture(t);
  let requests = 0;
  const port = await listen(t, createServer((_req, res) => { requests++; res.end('via-ssh'); }));
  const fake = join(fixture.directory, 'probe.mjs');
  await writeFile(fake, `
    import { createConnection } from 'node:net';
    import { createSocket } from 'node:dgram';
    import { Resolver } from 'node:dns/promises';
    import { execFileSync } from 'node:child_process';
    import { readFileSync, readlinkSync } from 'node:fs';
    import { request } from 'node:http';
    const tcp = host => new Promise(resolve => {
      const s = createConnection({ host, port: ${port}, timeout: 800 });
      s.on('connect', () => { s.destroy(); resolve('connected'); });
      s.on('error', e => resolve(e.code));
      s.on('timeout', () => { s.destroy(); resolve('timeout'); });
    });
    const http = await new Promise((resolve, reject) => {
      const req = request(process.env.HTTP_PROXY, { path: 'http://127.0.0.1:${port}/' }, res => {
        let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve(body));
      }); req.on('error', reject); req.end();
    });
    process.env.NO_PROXY = process.env.no_proxy = '*';
    delete process.env.HTTPS_PROXY; delete process.env.https_proxy;
    const direct = await Promise.all(['1.1.1.1', '2606:4700:4700::1111', '127.0.0.1'].map(tcp));
    const udp = await new Promise(resolve => {
      const socket = createSocket('udp4');
      socket.send('test', 53, '1.1.1.1', error => { resolve(error?.code ?? 'sent'); socket.close(); });
    });
    const resolver = new Resolver({ timeout: 200, tries: 1 }); resolver.setServers(['1.1.1.1']);
    const dns = await resolver.resolve4('example.invalid').then(() => 'resolved', e => e.code);
    const child = JSON.parse(execFileSync(process.execPath, ['-e', 'const fs = require("node:fs"); console.log(JSON.stringify({ net: fs.readlinkSync("/proc/self/ns/net"), interop: process.env.WSL_INTEROP ?? null }))'], { encoding: 'utf8' }));
    console.log(JSON.stringify({ http, direct, udp, dns, child, net: readlinkSync('/proc/self/ns/net'), routes: readFileSync('/proc/net/route', 'utf8').trim().split('\\n').length }));
  `);
  const child = spawn(process.execPath, [cli, '--ssh', 'test-vps', '--ssh-config', fixture.config,
    '--claude', process.execPath, '--', fake], { cwd: fixture.directory, env: { ...process.env, XDG_CONFIG_HOME: fixture.directory } });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.http, 'via-ssh'); assert.equal(requests, 1);
  assert.deepEqual(result.direct, ['ENETUNREACH', 'ENETUNREACH', 'ECONNREFUSED']);
  assert.equal(result.udp, 'ENETUNREACH'); assert.notEqual(result.dns, 'resolved');
  assert.equal(result.routes, 1); assert.equal(result.net, result.child.net); assert.equal(result.child.interop, null);
});

test('isolated gateway preserves models, beta headers, SSE tool deltas and provider errors without retries', { timeout: 15_000 }, async t => {
  const fixture = await sshFixture(t);
  const bodies: unknown[] = [];
  const sse = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const port = await listen(t, createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer synthetic-test');
    assert.equal(req.headers['anthropic-beta'], 'synthetic-beta');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      if (req.url?.includes('error')) res.writeHead(429, { 'retry-after': '42' }).end('{"error":"synthetic-rate-limit"}');
      else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(sse.slice(0, 30)); setTimeout(() => res.end(sse.slice(30)), 30); }
    });
  }));
  const fake = join(fixture.directory, 'gateway.mjs');
  await writeFile(fake, `
    const results = [];
    for (const model of ['sonnet-test', 'opus-test', 'error-test']) {
      const response = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages?beta=true&model=' + model, {
        method: 'POST', headers: { authorization: 'Bearer synthetic-test', 'anthropic-beta': 'synthetic-beta', 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'synthetic' }], stream: true, tools: [{ name: 'read_fixture' }] }),
      });
      results.push({ status: response.status, retry: response.headers.get('retry-after'), body: await response.text() });
    }
    console.log(JSON.stringify(results));
  `);
  const child = spawn(process.execPath, [cli, '--ssh', 'test-vps', '--ssh-config', fixture.config,
    '--ccproxy-port', String(port), '--claude', process.execPath, '--', fake], { env: { ...process.env, XDG_CONFIG_HOME: fixture.directory } });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close'); assert.equal(code, 0, stderr);
  const results = JSON.parse(stdout);
  assert.equal(bodies.length, 3);
  assert.equal(results[0].body, sse); assert.equal(results[1].body, sse);
  assert.equal(results[2].status, 429); assert.equal(results[2].retry, '42');
  assert.deepEqual(bodies.map(body => (body as { model: string }).model), ['sonnet-test', 'opus-test', 'error-test']);
});

for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
  test(`isolated process tree stops after launcher ${signal}`, { timeout: 15_000 }, async t => {
    const fixture = await sshFixture(t);
    const heartbeat = join(fixture.directory, 'heartbeat');
    const fake = join(fixture.directory, 'descendants.mjs');
    await writeFile(fake, `
      import { spawn } from 'node:child_process';
      spawn(process.execPath, ['-e', 'setInterval(() => require("node:fs").writeFileSync(process.argv[1], String(Date.now())), 40)', ${JSON.stringify(heartbeat)}], { detached: true, stdio: 'ignore' }).unref();
      console.log('ready'); setInterval(() => {}, 1000);
    `);
    const child = spawn(process.execPath, [cli, '--ssh', 'test-vps', '--ssh-config', fixture.config,
      '--claude', process.execPath, '--', fake], { env: { ...process.env, XDG_CONFIG_HOME: fixture.directory } });
    t.after(() => child.kill('SIGKILL'));
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.resume();
    const closed = once(child, 'close');
    await until(() => stdout.includes('ready'));
    await delay(200);
    child.kill(signal); await closed;
    await delay(200);
    const stopped = await readFile(heartbeat, 'utf8');
    await delay(200);
    assert.equal(await readFile(heartbeat, 'utf8'), stopped, 'detached tools must also stop');
  });
}

test('missing isolation never falls back to an unconfined Claude process', { timeout: 5_000 }, async t => {
  const fixture = await sshFixture(t);
  const child = spawn(process.execPath, [cli, '--ssh', 'test-vps', '--claude', process.execPath], {
    env: { ...process.env, PATH: fixture.directory, XDG_CONFIG_HOME: fixture.directory },
  });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 1); assert.match(stderr, /No direct fallback was used/);
});
