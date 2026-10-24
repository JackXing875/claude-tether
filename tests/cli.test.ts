import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { proxyEnvironment } from '../src/cli.js';
import { sshFixture, until } from './helpers.js';

const cli = new URL('../src/cli.js', import.meta.url).pathname;

test('proxy settings are confined to Claude and do not change authentication or permit NO_PROXY bypass', () => {
  const source = { HTTPS_PROXY: 'https://old.example', NO_PROXY: '*', ALL_PROXY: 'socks5://old.example', ANTHROPIC_BASE_URL: 'https://configured.example', SOME_PROJECT_SETTING: 'kept' };
  const env = proxyEnvironment(source, 'http://127.0.0.1:12345');
  assert.equal(source.HTTPS_PROXY, 'https://old.example');
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) assert.equal(env[key], 'http://127.0.0.1:12345');
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1'); assert.equal(env.no_proxy, env.NO_PROXY);
  assert.equal(env.ALL_PROXY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, source.ANTHROPIC_BASE_URL); assert.equal(env.SOME_PROJECT_SETTING, 'kept');
});

test('help works without SSH or a Claude installation', async () => {
  const child = spawn(process.execPath, [cli, '--help']);
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  const [code] = await once(child, 'close');
  assert.equal(code, 0); assert.match(output, /Runs official Claude Code locally/);
});

test('update help and source-checkout protection do not require a configured VPS or Claude', async () => {
  for (const args of [['update', '--help'], ['update']]) {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, XDG_CONFIG_HOME: '/missing-tether-config' } });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    const [code] = await once(child, 'close');
    assert.equal(code, args.length === 2 ? 0 : 1);
    assert.match(output, args.length === 2 ? /Usage: tether update/ : /Source checkouts/);
  }
});

test('npm-style symlink entry points execute the CLI', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tether-bin-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const link = join(directory, 'tether');
  await symlink(cli, link);
  const child = spawn(process.execPath, [link, '--help']);
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  const [code] = await once(child, 'close');
  assert.equal(code, 0); assert.match(output, /Usage: tether/);
});

test('launcher preserves working directory, literal arguments and Claude exit status', { timeout: 10_000 }, async t => {
  const fixture = await sshFixture(t);
  const fake = join(fixture.directory, 'fake claude.mjs');
  await writeFile(fake, `console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), proxy: process.env.HTTPS_PROXY, bypass: process.env.NO_PROXY })); process.exitCode = 7;`);
  const child = spawn(process.execPath, [cli, '--ssh', 'test-vps', '--ssh-config', fixture.config, '--claude', process.execPath, '--', fake, 'argument with spaces', '$(not-a-command)'], { cwd: fixture.directory, env: { ...process.env, XDG_CONFIG_HOME: fixture.directory } });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const [code] = await once(child, 'close');
  assert.equal(code, 7, stderr);
  const result = JSON.parse(stdout) as { cwd: string; args: string[]; proxy: string; bypass: string };
  assert.equal(result.cwd, fixture.directory);
  assert.deepEqual(result.args, ['argument with spaces', '$(not-a-command)']);
  assert.match(result.proxy, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(result.bypass, 'localhost,127.0.0.1,::1');
});

test('termination closes Claude and the SSH tunnel without leaving the wrapper running', { timeout: 10_000 }, async t => {
  const fixture = await sshFixture(t);
  const fake = join(fixture.directory, 'long-running-claude.mjs');
  await writeFile(fake, `console.log(process.pid); setInterval(() => {}, 1000);`);
  const child = spawn(process.execPath, [cli, '--network', 'proxy', '--ssh', 'test-vps', '--ssh-config', fixture.config, '--claude', process.execPath, '--', fake], { env: { ...process.env, XDG_CONFIG_HOME: fixture.directory } });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.resume();
  const closed = once(child, 'close');
  await until(() => /^\d+\s*$/.test(stdout));
  const claudePid = Number(stdout.trim());
  child.kill('SIGTERM');
  const [code] = await closed;
  assert.equal(code, 143);
  assert.throws(() => process.kill(claudePid, 0), { code: 'ESRCH' });
});

test('one-time setup enables plain launch and doctor without modifying saved preferences', { timeout: 15_000 }, async t => {
  const fixture = await sshFixture(t);
  const env = { ...process.env, XDG_CONFIG_HOME: fixture.directory };
  const invoke = async (args: string[]) => {
    const child = spawn(process.execPath, [cli, ...args], { env, cwd: fixture.directory });
    t.after(() => child.kill('SIGKILL'));
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const [code] = await once(child, 'close');
    return { code, stdout, stderr };
  };
  const setup = await invoke(['setup', 'test-vps', '--ssh-config', './ssh_config', '--claude', process.execPath]);
  assert.equal(setup.code, 0, setup.stderr);
  assert.match(setup.stdout, /Run tether from your project directory/);
  const path = join(fixture.directory, 'claude-tether', 'config.json');
  const saved = await readFile(path, 'utf8');
  assert.deepEqual(JSON.parse(saved), { ssh: 'test-vps', sshConfig: fixture.config, claude: process.execPath, network: 'isolated' });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const fake = join(fixture.directory, 'saved-default.mjs');
  await writeFile(fake, 'console.log("saved-default-launched");');
  const run = await invoke(['--', fake]);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /saved-default-launched/);
  const doctor = await invoke(['doctor']);
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.match(doctor.stdout, /No model request was made/);
  const override = await invoke(['--ssh', 'other-vps', '--claude', '/not-a-claude-executable']);
  assert.equal(override.code, 1);
  assert.match(override.stderr, /Local Claude Code is unavailable/);
  const failedSetup = await invoke(['setup', 'replacement-vps', '--claude', '/not-a-claude-executable']);
  assert.equal(failedSetup.code, 1);
  assert.equal(await readFile(path, 'utf8'), saved, 'failed setup/one-off options must not overwrite working preferences');
});
