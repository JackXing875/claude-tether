import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
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

for (const processes of ['host', 'isolated']) {
test(`${processes} process mode uses SSH for HTTP while direct IPv4, IPv6, UDP and host loopback fail closed`, { timeout: 15_000 }, async t => {
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
    '--processes', processes, '--claude', process.execPath, '--', fake], { cwd: fixture.directory, env: { ...process.env, XDG_CONFIG_HOME: fixture.directory } });
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
}

test('a malformed upstream cannot terminate the isolated launcher or its running child', { timeout: 15_000 }, async t => {
  const fixture = await sshFixture(t);
  let requests = 0;
  const port = await listen(t, tcpServer(socket => socket.once('data', () => {
    const status = requests++ === 0 ? '000 Invalid' : '200 OK';
    socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  })));
  const fake = join(fixture.directory, 'bad-upstream.mjs');
  await writeFile(fake, `
    import { request } from 'node:http';
    import { setTimeout as delay } from 'node:timers/promises';
    let heartbeats = 0;
    const timer = setInterval(() => heartbeats++, 10);
    const statuses = [];
    try {
      for (let i = 0; i < 2; i++) {
        statuses.push(await new Promise((resolve, reject) => {
          const req = request(process.env.HTTP_PROXY, { path: 'http://127.0.0.1:${port}/' }, res => {
            res.resume(); res.on('error', reject).on('end', () => resolve(res.statusCode));
          });
          req.on('error', reject).end();
        }));
        await delay(40);
      }
      console.log(JSON.stringify({ statuses, heartbeats }));
    } finally { clearInterval(timer); }
  `);
  const child = spawn(process.execPath, [cli, '--ssh', 'test-vps', '--ssh-config', fixture.config,
    '--claude', process.execPath, '--', fake], { env: { ...process.env, XDG_CONFIG_HOME: fixture.directory } });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.statuses, [502, 200]);
  assert.ok(result.heartbeats >= 2, 'the isolated child must keep running after the failed request');
  assert.equal(requests, 2, 'neither request may be replayed');
});

for (const parent of ['/tmp', '/dev/shm', `/run/user/${process.getuid!()}`]) {
  test(`private proxy, gateway and diagnostic sockets remain reachable with TMPDIR under ${parent}`, { timeout: 20_000 }, async t => {
    const fixture = await sshFixture(t);
    const port = await listen(t, createServer((_req, res) => res.end('via-private-ipc')));
    const fake = join(fixture.directory, 'tmpdir-probe.mjs');
    await writeFile(fake, `
      import { existsSync, readFileSync } from 'node:fs';
      import { request } from 'node:http';
      import { execFileSync } from 'node:child_process';
      const proxy = await new Promise((resolve, reject) => {
        const req = request(process.env.HTTP_PROXY, { path: 'http://127.0.0.1:${port}/' }, res => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('error', reject).on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject).end();
      });
      const gateway = await fetch(process.env.ANTHROPIC_BASE_URL);
      const diagnostic = JSON.parse(execFileSync(process.execPath, [${JSON.stringify(cli)}, 'doctor', '--inotify', '--json'], { encoding: 'utf8' }));
      console.log(JSON.stringify({ proxy, gateway: { status: gateway.status, body: await gateway.text() },
        diagnostic: { uid: diagnostic.uid, limit: diagnostic.maxUserWatches },
        siblingVisible: existsSync(process.env.TETHER_TEST_SIBLING),
        routes: readFileSync('/proc/net/route', 'utf8').trim().split('\\n').length }));
    `);
    // A disposable outer /run makes this work on CI hosts without a user runtime
    // directory, without creating or changing anything in the host's /run.
    const runner = join(fixture.directory, 'tmpdir-runner.mjs');
    const args = ['--ssh', 'test-vps', '--ssh-config', fixture.config, '--claude', process.execPath, '--ccproxy-port', String(port)];
    await writeFile(runner, `
      import { execFile } from 'node:child_process';
      import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { promisify } from 'node:util';
      const run = promisify(execFile);
      const directory = await mkdtemp(join(${JSON.stringify(parent)}, 'tether-ipc-'));
      try {
        const sibling = join(directory, 'host-only');
        await writeFile(sibling, 'must remain hidden below /dev and /run');
        const env = { ...process.env, TMPDIR: directory, TETHER_TEST_SIBLING: sibling };
        const args = ${JSON.stringify(args)};
        await run(process.execPath, [${JSON.stringify(cli)}, 'doctor', ...args], { env, timeout: 8000 });
        const result = await run(process.execPath, [${JSON.stringify(cli)}, ...args, '--', ${JSON.stringify(fake)}], { env, timeout: 8000 });
        console.log(JSON.stringify({ result: JSON.parse(result.stdout), remaining: await readdir(directory) }));
      } finally { await rm(directory, { recursive: true, force: true }); }
    `);
    const runDirectory = parent.startsWith('/run/');
    const child = spawn(runDirectory ? 'bwrap' : process.execPath, runDirectory
      ? ['--unshare-user', '--unshare-pid', '--bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/run', '--dir', parent,
        '--die-with-parent', '--', process.execPath, runner]
      : [runner], { env: { ...process.env, XDG_CONFIG_HOME: fixture.directory } });
    t.after(() => child.kill('SIGKILL'));
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, stderr);
    const { result, remaining } = JSON.parse(stdout);
    assert.deepEqual(result.proxy, { status: 200, body: 'via-private-ipc' });
    assert.deepEqual(result.gateway, result.proxy);
    assert.equal(result.diagnostic.uid, process.getuid!()); assert.ok(result.diagnostic.limit > 0);
    assert.equal(result.siblingVisible, parent === '/tmp', 'binding IPC must not expose its parent or siblings');
    assert.equal(result.routes, 1, 'the namespace must still have no external route');
    assert.deepEqual(remaining, ['host-only'], 'the private IPC directory must be cleaned up');
  });
}

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

for (const processes of ['host', 'isolated']) {
for (const signal of ['exit', 'SIGTERM', 'SIGKILL'] as const) {
  test(`${processes} process mode cleans double-forked tools after launcher ${signal} without killing host peers`, { timeout: 15_000 }, async t => {
    const fixture = await sshFixture(t);
    const heartbeat = join(fixture.directory, 'heartbeat');
    const fake = join(fixture.directory, 'descendants.mjs');
    const daemon = `process.on('SIGTERM', () => {}); setInterval(() => require('node:fs').writeFileSync(process.argv[1], String(Date.now())), 40); setTimeout(() => process.exit(), 10000);`;
    const intermediate = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(daemon)}, ${JSON.stringify(heartbeat)}], { detached: true, stdio: 'ignore' }).unref();`;
    await writeFile(fake, `
      import { spawn } from 'node:child_process';
      spawn(process.execPath, ['-e', ${JSON.stringify(intermediate)}], { detached: true, stdio: 'ignore' }).unref();
      console.log('ready');
      ${signal === 'exit' ? 'setTimeout(() => process.exit(7), 350);' : 'setInterval(() => {}, 1000);'}
    `);
    const peer = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 12000)'], { stdio: 'ignore' });
    t.after(() => peer.kill('SIGKILL'));
    const child = spawn(process.execPath, [cli, '--ssh', 'test-vps', '--ssh-config', fixture.config,
      '--processes', processes, '--claude', process.execPath, '--', fake], { env: { ...process.env, XDG_CONFIG_HOME: fixture.directory } });
    t.after(() => child.kill('SIGKILL'));
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.resume();
    const closed = once(child, 'close');
    await until(() => stdout.includes('ready'));
    await delay(200);
    if (signal !== 'exit') child.kill(signal);
    const [code] = await closed;
    if (signal === 'exit') assert.equal(code, 7);
    if (signal === 'SIGTERM') assert.equal(code, 143);
    await delay(200);
    const stopped = await readFile(heartbeat, 'utf8');
    await delay(200);
    assert.equal(await readFile(heartbeat, 'utf8'), stopped, 'detached tools must also stop');
    assert.equal(peer.exitCode, null); assert.equal(peer.signalCode, null);
    process.kill(peer.pid!, 0);
  });
}
}

test('missing Python supervisor fails closed, while explicit PID isolation needs no Python', { timeout: 5_000 }, async t => {
  const fixture = await sshFixture(t);
  const bin = join(fixture.directory, 'bin'); await mkdir(bin);
  await symlink('/usr/bin/bwrap', join(bin, 'bwrap'));
  for (const processes of ['host', 'isolated']) {
    const child = spawn(process.execPath, [cli, '--ssh', 'test-vps', '--processes', processes, '--claude', '/missing-claude'], {
      env: { ...process.env, PATH: bin, XDG_CONFIG_HOME: fixture.directory },
    });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    assert.equal((await once(child, 'close'))[0], 1);
    assert.match(stderr, processes === 'host' ? /Host process mode requires Python/ : /Local Claude Code is unavailable/);
  }
});

test('missing isolation never falls back to an unconfined Claude process', { timeout: 5_000 }, async t => {
  const fixture = await sshFixture(t);
  const child = spawn(process.execPath, [cli, '--ssh', 'test-vps', '--claude', process.execPath], {
    env: { ...process.env, PATH: fixture.directory, XDG_CONFIG_HOME: fixture.directory },
  });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 1); assert.match(stderr, /No direct fallback was used/);
});
