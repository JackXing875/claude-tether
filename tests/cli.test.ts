import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { OperationJournal } from '../packages/operation-journal/index.js';
import type { SessionSummary } from '../packages/protocol/index.js';

const cli = fileURLToPath(new URL('../../bin/tether.mjs', import.meta.url));

function setup(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), 'tether-cli-'));
  const project = join(base, 'project');
  mkdirSync(project);
  const env = { ...process.env, XDG_STATE_HOME: join(base, 'private-state') };
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: project,
      env,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 512 * 1024,
    });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, project, env, run };
}

void test('CLI help/version are side effect free and bad options do not echo secrets', (t) => {
  const f = setup(t);
  for (const args of [
    ['--help'],
    ['--version'],
    ['connect', '--help'],
    ['sessions', '--help'],
    ['server', '--help'],
    ['device', '--help'],
  ]) {
    const result = f.run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.length > 0);
  }
  const bad = f.run('connect', '--secret-do-not-echo');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown option/);
  assert.ok(!bad.stderr.includes('secret-do-not-echo'));
  assert.deepEqual(readdirSync(f.base), ['project']);
});

void test('CLI rejects implicit runtime and malformed ports before creating state', (t) => {
  const f = setup(t);
  for (const args of [
    ['server'],
    ['server', '--runtime', 'fake', '--port', 'NaN'],
    ['server', '--runtime', 'fake', '--port', '65536'],
  ]) {
    const result = f.run(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /USAGE/);
  }
  assert.deepEqual(readdirSync(f.base), ['project']);
});

void test('device credentials are private, never printed or overwritten, and revocable', (t) => {
  const f = setup(t);
  const credential = join(f.base, 'credentials', 'device.json');
  const provision = f.run('device', 'create', '--id', 'laptop', '--out', credential);
  assert.equal(provision.status, 0, provision.stderr);
  const contents = readFileSync(credential, 'utf8');
  const { token } = JSON.parse(contents) as { token: string };
  assert.equal(statSync(credential).mode & 0o777, 0o600);
  assert.ok(!provision.stdout.includes(token) && !provision.stderr.includes(token));
  assert.equal(f.run('device', 'create', '--id', 'laptop2', '--out', credential).status, 1);
  assert.equal(readFileSync(credential, 'utf8'), contents);
  assert.equal(f.run('device', 'revoke', '--id', 'laptop').status, 0);
});

void test('separate CLI processes connect, resume, deny unattended mutations, and release the state lease', async (t) => {
  const f = setup(t);
  const credential = join(f.base, 'credentials', 'device.json');
  assert.equal(f.run('device', 'create', '--out', credential).status, 0);
  writeFileSync(join(f.project, 'calc.mjs'), 'export function add(a, b) { return a - b; }\n');
  const child = spawn(process.execPath, [cli, 'server', '--runtime', 'fake', '--port', '0'], {
    cwd: f.project,
    env: f.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const closed = once(child, 'close');
  let stopped = false;
  t.after(async () => {
    if (!stopped) {
      child.kill('SIGKILL');
      await closed;
    }
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not become ready')), 10_000);
    let output = '';
    child.stdout.on('data', (bytes: Buffer) => {
      output += bytes.toString();
      const match = /Listening: (ws:\/\/[^\s]+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Server exited before readiness'));
    });
  });
  const args = ['connect', '--credential', credential, '--url', url, '--allow-insecure-loopback'];
  const listArgs = ['sessions', ...args.slice(1)];
  const initial = f.run(...listArgs, '--json');
  assert.equal(initial.status, 0, initial.stderr);
  assert.deepEqual(JSON.parse(initial.stdout), []);
  const states = join(f.env.XDG_STATE_HOME, 'claude-tether', 'workspaces');
  assert.equal(existsSync(states), false);
  const read = f.run(...args, '--prompt', 'read calc.mjs');
  assert.equal(read.status, 0, read.stderr);
  assert.match(read.stdout, /return a - b/);
  const session = /Session: ([a-z0-9-]+)/.exec(read.stdout)![1]!;
  const state = join(states, readdirSync(states)[0]!);
  const journal = new OperationJournal(join(state, 'operations.sqlite'));
  try {
    const cursor = journal.cursor(session);
    const identity = readFileSync(join(state, 'workspace.json'), 'utf8');
    const listed = f.run(...listArgs, '--json');
    assert.equal(listed.status, 0, listed.stderr);
    const sessions = JSON.parse(listed.stdout) as SessionSummary[];
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.session_id, session);
    assert.equal(sessions[0]!.latest_turn_state, 'COMPLETED');
    assert.equal(sessions[0]!.worker_epoch, 1);
    assert.equal(journal.cursor(session), cursor);
    assert.equal(readFileSync(join(state, 'workspace.json'), 'utf8'), identity);
    assert.ok(!listed.stdout.includes('return a - b'));
    const human = f.run(...listArgs);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /SESSION ID/);
    assert.match(human.stdout, /connect.*--resume/);
    assert.equal(f.run(...listArgs, '--read-only', '--json').stdout.trim(), '[]');
    assert.equal(readdirSync(states).length, 1);
  } finally {
    journal.close();
  }
  const resume = f.run(...args, '--resume', session, '--prompt', 'read calc.mjs');
  assert.equal(resume.status, 0, resume.stderr);
  assert.match(resume.stdout, new RegExp('Session: ' + session));
  const afterResume = JSON.parse(f.run(...listArgs, '--json').stdout) as SessionSummary[];
  assert.equal(afterResume[0]!.worker_epoch, 2);
  const denied = f.run(...args, '--prompt', 'demo');
  assert.equal(denied.status, 1);
  assert.match(denied.stdout, /DENIED/);
  assert.equal(
    readFileSync(join(f.project, 'calc.mjs'), 'utf8'),
    'export function add(a, b) { return a - b; }\n',
  );
  assert.deepEqual(readdirSync(f.project), ['calc.mjs']);
  assert.equal(readdirSync(join(f.env.XDG_STATE_HOME, 'claude-tether', 'workspaces')).length, 1);
  const whileRunning = f.run('device', 'revoke', '--id', 'anything');
  assert.equal(whileRunning.status, 1);
  assert.match(whileRunning.stderr, /STATE_IN_USE/);
  child.kill('SIGTERM');
  const [code] = await closed;
  stopped = true;
  assert.equal(code, 0);
  assert.equal(f.run('device', 'revoke', '--id', 'anything').status, 0);
});
