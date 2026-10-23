import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
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

const cli = fileURLToPath(new URL('../../bin/tether.mjs', import.meta.url));
interface Audit {
  phase: string;
  requestedId?: string;
  available?: string;
  prompt?: string;
  pid: number;
  mcp_pid?: number;
}
function setup(t: TestContext, mode: string) {
  const base = mkdtempSync(join(tmpdir(), 'tether-probe-'));
  const cwd = join(base, 'private-probe');
  const audit = join(base, 'fixture-audit.jsonl');
  const executable = join(base, 'synthetic-claude.mjs');
  writeFileSync(
    executable,
    '#!/usr/bin/env node\nprocess.argv.push("--fixture-mode",' +
      JSON.stringify(mode) +
      ',"--fixture-audit",' +
      JSON.stringify(audit) +
      ');\nawait import(' +
      JSON.stringify(new URL('./fixtures/probe-cli.js', import.meta.url).href) +
      ');\n',
    { mode: 0o700 },
  );
  const args = [cli, 'probe', '--cwd', cwd, '--claude', executable];
  const options = {
    cwd: base,
    env: { HOME: base, PATH: process.env.PATH },
    encoding: 'utf8' as const,
    timeout: 15_000,
  };
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const records = (): Audit[] =>
    existsSync(audit)
      ? readFileSync(audit, 'utf8')
          .split('\n')
          .slice(0, -1)
          .map((line) => JSON.parse(line) as Audit)
      : [];
  return {
    base,
    cwd,
    audit,
    args,
    options,
    records,
    run: () => spawnSync(process.execPath, args, options),
  };
}
async function stopped(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if (/\) [ZX] /.test(readFileSync('/proc/' + pid + '/stat', 'utf8'))) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Probe child process did not stop');
}

void test('P0 requires a fresh MCP challenge and recalls it across the explicit session without leaking or retaining probe files', async (t) => {
  const f = setup(t, 'normal');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const summary = JSON.parse(result.stdout) as Record<string, unknown>;
  for (const flag of [
    'auth_verified',
    'first_turn',
    'explicit_resume',
    'mcp_marker_seen',
    'mcp_call_seen',
    'resumed_marker_seen',
  ])
    assert.equal(summary[flag], true);
  const first = f.records().find((r) => r.phase === 'first')!;
  const resume = f.records().find((r) => r.phase === 'resume')!;
  assert.equal(first.requestedId, resume.requestedId);
  assert.notEqual(first.available, resume.available);
  assert.ok(!first.prompt!.includes(first.available!));
  assert.ok(!resume.prompt!.includes(first.available!));
  assert.ok(!result.stdout.includes(first.available!) && !result.stdout.includes(f.base));
  assert.deepEqual(readdirSync(f.cwd), []);
  for (const r of f.records()) {
    await stopped(r.pid);
    if (r.mcp_pid) await stopped(r.mcp_pid);
  }
});

void test('P0 rejects success responses that forget the marker, switch session, repeat a tool or lack first-turn evidence', async (t) => {
  for (const [mode, code] of [
    ['forget', 'RESUME_NOT_VERIFIED'],
    ['wrong-session', 'RUNTIME_SESSION_MISMATCH'],
    ['repeat-tool', 'RESUME_TOOL_USED'],
    ['no-tool', 'MCP_NOT_VERIFIED'],
    ['extra-tool', 'PROBE_TOOL_MISMATCH'],
    ['no-auth', 'AUTH_REQUIRED'],
  ]) {
    const f = setup(t, mode!);
    const result = f.run();
    assert.equal(result.status, 1, result.stderr + result.stdout);
    const summary = JSON.parse(result.stdout) as {
      explicit_resume: boolean;
      error: { code: string };
    };
    assert.equal(summary.explicit_resume, false);
    assert.equal(summary.error.code, code);
    assert.deepEqual(readdirSync(f.cwd), []);
    for (const r of f.records()) {
      await stopped(r.pid);
      if (r.mcp_pid) await stopped(r.mcp_pid);
    }
  }
});

void test('cancelling P0 stops both CLI and MCP process groups and removes only its temporary files', async (t) => {
  const f = setup(t, 'hang');
  const child = spawn(process.execPath, f.args, {
    ...f.options,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  child.stdout.resume();
  child.stderr.resume();
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await closed;
    }
  });
  let mcp: Audit | undefined;
  for (let attempt = 0; attempt < 1000; attempt++) {
    mcp = f.records().find((record) => record.phase === 'mcp');
    if (mcp) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(mcp?.mcp_pid, 'Synthetic MCP child became ready');
  const keep = join(f.cwd, 'keep.txt');
  writeFileSync(keep, 'pre-existing infrastructure file');
  child.kill('SIGINT');
  const [code] = await closed;
  assert.equal(code, 1);
  await stopped(mcp.pid);
  await stopped(mcp.mcp_pid);
  assert.deepEqual(readdirSync(f.cwd), ['keep.txt']);
});

void test('P0 refuses a public infrastructure directory without silently changing its permissions', (t) => {
  const f = setup(t, 'normal');
  // Use the already existing base as the caller-provided probe parent.
  chmodSync(f.base, 0o755);
  f.args[f.args.indexOf('--cwd') + 1] = f.base;
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /STATE_PERMISSIONS/);
  assert.equal(statSync(f.base).mode & 0o777, 0o755);
  assert.equal(existsSync(f.audit), false);
});
