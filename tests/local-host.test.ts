import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalHost } from '../packages/local-host/index.js';
import { contentRevision } from '../packages/protocol/index.js';
import { fixture } from './helpers.js';

void test('read returns local UTF-8/BOM/CRLF and explicit partial-read metadata', async (t) => {
  const f = await fixture(t);
  const content = '\uFEFF第一行\r\nsecond\r\n';
  await writeFile(join(f.root, '空 格.txt'), content);
  const result = await f.host.execute(
    f.operation('read_file', { path: '空 格.txt', start_line: 2, end_line: 2 }),
  );
  assert.equal(result.status, 'SUCCEEDED');
  assert.deepEqual(result.output, {
    path: '空 格.txt',
    content: 'second\r',
    revision: contentRevision(Buffer.from(content)),
    start_line: 2,
    end_line: 2,
    total_lines: 3,
    partial: true,
    encoding: 'utf-8',
    bom: true,
    newline: 'CRLF',
  });
});

void test('approved edit preserves BOM and CRLF', async (t) => {
  const f = await fixture(t);
  const before = '\uFEFFhello\r\nworld\r\n';
  await writeFile(join(f.root, 'x'), before);
  const result = await f.host.execute(
    f.operation('edit_text', {
      path: 'x',
      expected_revision: contentRevision(Buffer.from(before)),
      old_text: 'world',
      new_text: '世界',
    }),
  );
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(await readFile(join(f.root, 'x'), 'utf8'), '\uFEFFhello\r\n世界\r\n');
});

void test('recheck after approval rejects external changes instead of overwriting them', async (t) => {
  let path = '';
  const f = await fixture(t, {
    approve: async () => {
      await writeFile(path, 'external edit');
      return true;
    },
  });
  path = join(f.root, 'x');
  await writeFile(path, 'old');
  const result = await f.host.execute(
    f.operation('edit_text', {
      path: 'x',
      expected_revision: contentRevision(Buffer.from('old')),
      old_text: 'old',
      new_text: 'new',
    }),
  );
  assert.equal(result.error?.code, 'FILE_CHANGED');
  assert.equal(await readFile(path, 'utf8'), 'external edit');
});

void test('permission denial prevents both file writes and command startup', async (t) => {
  const f = await fixture(t, { approve: async () => false });
  for (const op of [
    f.operation('write_file', { path: 'no.txt', content: 'bad', expected_revision: null }),
    f.operation('run_command', {
      program: process.execPath,
      args: ['-e', "require('fs').writeFileSync('no.txt','bad')"],
    }),
  ])
    assert.equal((await f.host.execute(op)).status, 'DENIED');
  await assert.rejects(stat(join(f.root, 'no.txt')), { code: 'ENOENT' });
});

void test('approval timeout and a late allow cannot start a command', async (t) => {
  let allow: (v: boolean) => void = () => {};
  const f = await fixture(t, {
    approvalTimeoutMs: 15,
    approve: () =>
      new Promise((resolve) => {
        allow = resolve;
      }),
  });
  const op = f.operation('write_file', { path: 'no', content: 'late', expected_revision: null });
  assert.equal((await f.host.execute(op)).error?.code, 'APPROVAL_EXPIRED');
  allow(true);
  assert.equal((await f.host.execute(op)).status, 'DENIED');
  await assert.rejects(stat(join(f.root, 'no')), { code: 'ENOENT' });
});

void test('read-only forbids arbitrary commands even when described as reads', async (t) => {
  const f = await fixture(t, { policy: 'read-only' });
  const result = await f.host.execute(
    f.operation('run_command', { program: 'cat', args: ['README'] }),
  );
  assert.equal(result.status, 'DENIED');
});

void test('traversal, symlink escapes, directories and binary encodings are rejected', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.base, 'secret'), 'outside');
  await symlink(join(f.base, 'secret'), join(f.root, 'link'));
  await writeFile(join(f.root, 'binary'), Buffer.from([0xff, 0xfe]));
  for (const path of ['../secret', '/etc/passwd', 'link', '.', 'binary']) {
    assert.equal((await f.host.execute(f.operation('read_file', { path }))).status, 'FAILED', path);
  }
});

void test('duplicate delivery while approving and after completion has exactly one local effect', async (t) => {
  let release: (v: boolean) => void = () => {},
    approvals = 0;
  const f = await fixture(t, {
    approve: async () => {
      approvals++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const op = f.operation('run_command', {
    program: process.execPath,
    args: ['-e', "require('fs').appendFileSync('counter','x')"],
  });
  const a = f.host.execute(op),
    b = f.host.execute(op);
  await new Promise((resolve) => setImmediate(resolve));
  release(true);
  assert.deepEqual(await a, await b);
  assert.equal((await f.host.execute(op)).status, 'SUCCEEDED');
  assert.equal(approvals, 1);
  assert.equal(await readFile(join(f.root, 'counter'), 'utf8'), 'x');
});

void test('same operation ID with changed input is rejected while original is pending', async (t) => {
  let release: (v: boolean) => void = () => {};
  const f = await fixture(t, {
    approve: async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const op = f.operation('write_file', { path: 'x', content: 'original', expected_revision: null });
  const pending = f.host.execute(op);
  assert.throws(
    () =>
      f.host.execute({ ...op, input: { path: 'x', content: 'changed', expected_revision: null } }),
    { code: 'OPERATION_CONFLICT' },
  );
  await new Promise((resolve) => setImmediate(resolve));
  release(true);
  await pending;
  assert.equal(await readFile(join(f.root, 'x'), 'utf8'), 'original');
});

void test('caller input mutation during approval cannot alter the approved operation', async (t) => {
  let release: (v: boolean) => void = () => {};
  const f = await fixture(t, {
    approve: async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const input = { path: 'x', content: 'approved', expected_revision: null };
  const pending = f.host.execute(f.operation('write_file', input));
  input.content = 'injected';
  await new Promise((resolve) => setImmediate(resolve));
  release(true);
  await pending;
  assert.equal(await readFile(join(f.root, 'x'), 'utf8'), 'approved');
});

void test('stale epoch, device, policy and workspace requests fail before journal acceptance', async (t) => {
  const f = await fixture(t);
  for (const extra of [
    { worker_epoch: 2 },
    { device_id: randomUUID() },
    { workspace_id: randomUUID() },
    { workspace_generation: 2 },
    { policy_revision: 2 },
    { execution_target_id: randomUUID() },
  ]) {
    const op = f.operation('workspace_info', {}, extra);
    assert.throws(() => f.host.execute(op));
    assert.equal(f.host.journal.get(op.operation_id), undefined);
  }
});

void test('creation does not overwrite, ambiguous edits fail, and concurrent edits detect conflict', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'x'), 'a a');
  assert.equal(
    (
      await f.host.execute(
        f.operation('write_file', { path: 'x', content: 'overwrite', expected_revision: null }),
      )
    ).error?.code,
    'FILE_CHANGED',
  );
  assert.equal(
    (
      await f.host.execute(
        f.operation('edit_text', {
          path: 'x',
          expected_revision: contentRevision(Buffer.from('a a')),
          old_text: 'a',
          new_text: 'b',
        }),
      )
    ).error?.code,
    'AMBIGUOUS_EDIT',
  );
  const input = {
    path: 'x',
    expected_revision: contentRevision(Buffer.from('a a')),
    old_text: 'a a',
    new_text: 'b',
  };
  const results = await Promise.all([
    f.host.execute(f.operation('edit_text', input)),
    f.host.execute(f.operation('edit_text', input)),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ['SUCCEEDED', 'FAILED'],
  );
  assert.equal(results[1]!.error?.code, 'FILE_CHANGED');
});

void test('local env is inherited, shell metacharacters are literal, and output is bounded', async (t) => {
  const f = await fixture(t, { env: { ...process.env, RELAY_TEST_VALUE: 'local-only' } });
  const result = await f.host.execute(
    f.operation('run_command', {
      program: process.execPath,
      args: [
        '-e',
        'process.stdout.write(process.env.RELAY_TEST_VALUE+process.argv[1]);process.stdout.write("x".repeat(200000));',
        '$(touch injected)',
      ],
    }),
  );
  const output = result.output as { stdout: string; truncated: boolean };
  assert.equal(result.status, 'SUCCEEDED');
  assert.ok(output.stdout.startsWith('local-only$(touch injected)'));
  assert.ok(Buffer.byteLength(output.stdout) <= 65536);
  assert.equal(output.truncated, true);
  await assert.rejects(stat(join(f.root, 'injected')), { code: 'ENOENT' });
});

void test('search uses local ignore rules and literal query text', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, '.git'));
  await writeFile(join(f.root, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(f.root, 'ignored.txt'), 'needle.*\n');
  await writeFile(join(f.root, 'visible.txt'), 'needle.*\nneedlexx\n');
  const result = await f.host.execute(f.operation('search_text', { query: 'needle.*' }));
  const output = result.output as { matches: { path: string; line: number }[] };
  assert.deepEqual(
    output.matches.map((m) => [m.path.replace(/^\.\//, ''), m.line]),
    [['visible.txt', 1]],
  );
});

void test('the same state DB cannot be opened by two executors', async (t) => {
  const f = await fixture(t);
  assert.throws(() => new LocalHost({ root: f.root, journalPath: f.journalPath }), {
    code: 'STATE_IN_USE',
  });
});
