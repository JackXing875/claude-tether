import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { terminalText } from '../packages/diagnostics/index.js';
import { MAX_FILE_BYTES } from '../packages/protocol/index.js';

test('oversized files fail explicitly without a partial file masquerading as a full read', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'large'), Buffer.alloc(MAX_FILE_BYTES + 1, 'a'));
  const result = await f.host.execute(f.operation('read_file', { path: 'large' }));
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error?.code, 'FILE_TOO_LARGE');
  assert.equal(result.output, undefined);
});

test('unknown fields cannot enable shell, PTY, background or environment injection', async (t) => {
  const f = await fixture(t);
  for (const field of [{ shell: true }, { pty: true }, { background: true }, { env: { PATH: '/injected' } }]) {
    assert.throws(() => f.host.execute(f.operation('run_command', { program: 'node', ...field })));
  }
});

test('replacing a workspace directory invalidates the original binding', async (t) => {
  const f = await fixture(t);
  await rename(f.root, join(f.base, 'old'));
  await mkdir(f.root);
  await writeFile(join(f.root, 'x'), 'new directory');
  const result = await f.host.execute(f.operation('read_file', { path: 'x' }));
  assert.equal(result.error?.code, 'WORKSPACE_MISMATCH');
});

test('terminal rendering strips title/cursor escapes, CR and backspace while preserving text/newlines', () => {
  assert.equal(terminalText('\u001b]0;injected title\u0007\u001b[2Jhello\rworld\b\n\tok'), 'helloworld\n\tok');
});
