import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { saveSettings } from '../src/settings.js';
import { sshFixture, until } from './helpers.js';

const wrapper = new URL('../src/vscode.js', import.meta.url).pathname;

test('VS Code wrapper uses the supplied executable and preserves duplex stdio, cwd, environment, literal SDK arguments and exit status', { timeout: 15_000 }, async t => {
  const fixture = await sshFixture(t);
  await saveSettings({ ssh: 'test-vps', sshConfig: fixture.config, claude: '/unused-saved-claude' }, join(fixture.directory, 'claude-tether/config.json'));
  const executable = join(fixture.directory, 'bundled claude');
  await symlink(process.execPath, executable);
  const fake = join(fixture.directory, 'sdk-child.mjs');
  await writeFile(fake, `
    import { createInterface } from 'node:readline';
    import { readFileSync } from 'node:fs';
    console.error('child diagnostic');
    console.log(JSON.stringify({ type: 'ready', args: process.argv.slice(2), cwd: process.cwd(),
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT, profile: process.env.CLAUDE_CONFIG_DIR,
      proxy: process.env.HTTPS_PROXY, routes: readFileSync('/proc/net/route', 'utf8').trim().split('\\n').length }));
    const lines = createInterface({ input: process.stdin });
    for await (const line of lines) console.log(JSON.stringify({ echo: JSON.parse(line) }));
    process.exitCode = 7;
  `);
  const args = ['--model', 'sonnet', '--ssh', 'literal-not-a-tether-option', '--network', 'proxy', '--', 'a b', '$(not-a-command)'];
  const child = spawn(process.execPath, [wrapper, executable, fake, ...args], {
    cwd: fixture.directory,
    env: { ...process.env, XDG_CONFIG_HOME: fixture.directory, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', CLAUDE_CONFIG_DIR: '/test-profile' },
  });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close');
  await until(() => stdout.includes('\n'));
  const ready = JSON.parse(stdout.trim());
  assert.equal(ready.type, 'ready'); assert.deepEqual(ready.args, args);
  assert.equal(ready.cwd, fixture.directory); assert.equal(ready.entrypoint, 'claude-vscode');
  assert.equal(ready.profile, '/test-profile'); assert.equal(ready.routes, 1);
  assert.match(ready.proxy, /^http:\/\/127\.0\.0\.1:\d+$/);
  const request = { type: 'control_request', request: { subtype: 'set_model', model: 'opus' } };
  const input = JSON.stringify(request) + '\n';
  child.stdin.write(input.slice(0, 17)); child.stdin.write(input.slice(17));
  await until(() => stdout.trim().split('\n').length === 2);
  assert.deepEqual(JSON.parse(stdout.trim().split('\n')[1]!), { echo: request });
  child.stdin.end();
  assert.equal((await closed)[0], 7);
  assert.match(stderr, /Network: isolated/); assert.match(stderr, /child diagnostic/);
  assert.equal(stdout.trim().split('\n').length, 2, 'no launcher text may pollute SDK stdout');
});

test('VS Code cancellation stops the isolated process and detached tools', { timeout: 15_000 }, async t => {
  const fixture = await sshFixture(t);
  await saveSettings({ ssh: 'test-vps', sshConfig: fixture.config }, join(fixture.directory, 'claude-tether/config.json'));
  const heartbeat = join(fixture.directory, 'heartbeat');
  const fake = join(fixture.directory, 'sdk-long-running.mjs');
  await writeFile(fake, `
    import { spawn } from 'node:child_process';
    spawn(process.execPath, ['-e', 'setInterval(() => require("node:fs").writeFileSync(process.argv[1], String(Date.now())), 30)', ${JSON.stringify(heartbeat)}], { detached: true, stdio: 'ignore' }).unref();
    console.log('ready'); setInterval(() => {}, 1000);
  `);
  const child = spawn(process.execPath, [wrapper, process.execPath, fake], { env: { ...process.env, XDG_CONFIG_HOME: fixture.directory } });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.resume();
  const closed = once(child, 'close');
  await until(() => stdout.includes('ready')); await delay(150);
  child.kill('SIGTERM'); assert.equal((await closed)[0], 143);
  await delay(150); const stopped = await readFile(heartbeat, 'utf8');
  await delay(150); assert.equal(await readFile(heartbeat, 'utf8'), stopped);
});

test('VS Code wrapper rejects missing or flag-like executable arguments before starting SSH', async () => {
  for (const args of [[], ['--model', 'sonnet']]) {
    const child = spawn(process.execPath, [wrapper, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    assert.equal((await once(child, 'close'))[0], 1);
    assert.equal(stdout, ''); assert.match(stderr, /absolute path.*first argument/);
    assert.doesNotMatch(stderr, /SSH tunnel ready/);
  }
});
