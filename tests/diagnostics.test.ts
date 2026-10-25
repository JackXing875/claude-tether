import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { watch } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { inotifyDiagnostic, scanInotify, startHostDiagnostics } from '../src/diagnostics.js';
import { sshFixture } from './helpers.js';

const cli = new URL('../src/cli.js', import.meta.url).pathname;

for (const processes of ['host', 'isolated']) {
  test(`${processes} mode has the selected PID view and bounded host diagnostics`, { timeout: 20_000 }, async t => {
    const fixture = await sshFixture(t);
    const watcher = watch(fixture.directory, () => {});
    t.after(() => watcher.close());
    const fake = join(fixture.directory, 'process-view.mjs');
    await writeFile(fake, `
      import { existsSync, readdirSync } from 'node:fs';
      import { spawnSync } from 'node:child_process';
      let fdinfo;
      try { readdirSync('/proc/${process.pid}/fdinfo'); fdinfo = 'readable'; } catch (e) { fdinfo = e.code; }
      const diagnostic = spawnSync(process.execPath, [${JSON.stringify(cli)}, 'doctor', '--inotify', '--json'], { encoding: 'utf8' });
      console.log(JSON.stringify({ hostVisible: existsSync('/proc/${process.pid}/comm'), fdinfo,
        network: process.env.TETHER_NETWORK_MODE, processes: process.env.TETHER_PROCESS_MODE,
        socket: process.env.TETHER_HOST_SOCKET ?? null, diagnostic: { code: diagnostic.status, stdout: diagnostic.stdout, stderr: diagnostic.stderr } }));
    `);
    const child = spawn(process.execPath, [cli, '--ssh', 'test-vps', '--ssh-config', fixture.config,
      ...(processes === 'host' ? [] : ['--processes', processes]), '--claude', process.execPath, '--', fake], {
      env: { ...process.env, XDG_CONFIG_HOME: fixture.directory, TETHER_HOST_SOCKET: '/stale-inherited-socket' },
    });
    t.after(() => child.kill('SIGKILL'));
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    assert.equal((await once(child, 'close'))[0], 0, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.network, 'isolated'); assert.equal(result.processes, processes);
    assert.equal(result.hostVisible, processes === 'host');
    if (processes === 'host') {
      assert.equal(result.fdinfo, 'EACCES', 'shared PID view does not bypass ptrace/user-namespace permissions');
      assert.equal(result.diagnostic.code, 0, result.diagnostic.stderr);
      const report = JSON.parse(result.diagnostic.stdout);
      assert.ok(report.processes.some((p: { pid: number; watchRecords: number }) => p.pid === process.pid && p.watchRecords >= 1));
      assert.equal(report.maxUserWatches, Number(await readFile('/proc/sys/fs/inotify/max_user_watches', 'utf8')));
      await assert.rejects(stat(result.socket), { code: 'ENOENT' }, 'host socket must be cleaned up');
    } else {
      assert.equal(result.socket, null);
      assert.equal(result.diagnostic.code, 1);
      assert.match(result.diagnostic.stderr, /Host inotify diagnostics are unavailable/);
    }
  });
}

test('host diagnostic IPC rejects arbitrary operations and closes every connection', { timeout: 15_000 }, async t => {
  const fixture = await sshFixture(t);
  const path = join(fixture.directory, 'diagnostics.sock');
  const server = await startHostDiagnostics(path);
  t.after(() => server.close());
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  for (const request of ['exec /bin/true\n', 'read /etc/passwd\n', 'inotify /proc/1\n', 'x'.repeat(1024)]) {
    const socket = createConnection(path); let reply = '';
    socket.on('data', data => { reply += data; });
    socket.on('connect', () => socket.write(request));
    await once(socket, 'close');
    assert.deepEqual(JSON.parse(reply), { error: 'Unsupported diagnostic' });
  }
  const idle = createConnection(path);
  const closed = once(idle, 'close'); await once(idle, 'connect');
  await server.close(); await closed;
  await assert.rejects(inotifyDiagnostic({ TETHER_NETWORK_MODE: 'isolated', TETHER_PROCESS_MODE: 'host', TETHER_HOST_SOCKET: path }));
});

test('doctor inotify is a local maintenance command with no SSH or Claude dependency', { timeout: 15_000 }, async () => {
  const child = spawn(process.execPath, [cli, 'doctor', '--inotify', '--json'], {
    env: { ...process.env, XDG_CONFIG_HOME: '/missing-settings', TETHER_NETWORK_MODE: '', TETHER_HOST_SOCKET: '/stale' },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  assert.equal((await once(child, 'close'))[0], 0, stderr);
  assert.equal(JSON.parse(stdout).uid, process.getuid!());
  assert.doesNotMatch(stderr, /SSH/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(scanInotify(aborted.signal), { name: 'AbortError' });
});
