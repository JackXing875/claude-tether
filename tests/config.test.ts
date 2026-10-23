import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertOutsideWorkspace,
  clientState,
  readCredential,
  readWorkspaceIdentity,
  stateHome,
  validatePrivateDirectory,
} from '../packages/config/index.js';

void test('state identities separate relays, devices, projects and policy', () => {
  const original = ['/root', 'device', 'wss://one/v1/bridge', 'ask'] as const;
  const baseline = clientState(...original, '/state');
  for (let i = 0; i < 4; i++) {
    const next: [string, string, string, string] = [...original];
    next[i] += '-different';
    assert.notEqual(clientState(...next, '/state'), baseline);
  }
  assert.equal(clientState(...original, '/state'), baseline);
  assert.throws(() => stateHome({ XDG_STATE_HOME: 'relative' }), { code: 'INVALID_CONFIG' });
});

void test('session discovery reads only a private identity matching the original project, device and policy', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'tether-identity-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const expected = {
    root: '/workspace',
    directory_identity: '1:2',
    policy: 'ask' as const,
    device_id: 'laptop',
  };
  const binding = {
    device_id: 'laptop',
    workspace_id: 'project',
    workspace_generation: 1,
    execution_target_id: 'local',
    policy_revision: 1,
  };
  const path = join(base, 'workspace.json');
  assert.equal(readWorkspaceIdentity(path, expected), undefined);
  assert.equal(existsSync(path), false);
  const missing = join(base, 'missing');
  assert.throws(() => validatePrivateDirectory(missing), { code: 'ENOENT' });
  assert.equal(existsSync(missing), false);
  assert.equal(validatePrivateDirectory(base), base);
  const { device_id: _device, ...identity } = expected;
  writeFileSync(path, JSON.stringify({ ...identity, binding }), { mode: 0o600 });
  assert.deepEqual(readWorkspaceIdentity(path, expected), binding);
  for (const changed of [
    { root: '/different' },
    { directory_identity: '1:3' },
    { device_id: 'other-device' },
  ]) {
    assert.throws(() => readWorkspaceIdentity(path, { ...expected, ...changed }), {
      code: 'WORKSPACE_MISMATCH',
    });
  }
  assert.throws(() => readWorkspaceIdentity(path, { ...expected, policy: 'read-only' }), {
    code: 'POLICY_CHANGED',
  });
  const link = join(base, 'alias.json');
  symlinkSync(path, link);
  assert.throws(() => readWorkspaceIdentity(link, expected), { code: 'ELOOP' });
  chmodSync(path, 0o644);
  assert.throws(() => readWorkspaceIdentity(path, expected), { code: 'STATE_PERMISSIONS' });
  const fifo = join(base, 'fifo');
  execFileSync('mkfifo', ['-m', '600', fifo]);
  assert.throws(() => readWorkspaceIdentity(fifo, expected), { code: 'STATE_PERMISSIONS' });
});

void test('credential links, public credentials and state symlinks into the project are rejected', () => {
  const base = mkdtempSync(join(tmpdir(), 'tether-config-'));
  try {
    const project = join(base, 'project');
    mkdirSync(project);
    const internal = join(project, '..hidden-state');
    mkdirSync(internal);
    const alias = join(base, 'state-alias');
    symlinkSync(internal, alias);
    assert.throws(() => assertOutsideWorkspace(project, alias), { code: 'STATE_IN_WORKSPACE' });
    assert.throws(() => assertOutsideWorkspace(project, internal), { code: 'STATE_IN_WORKSPACE' });
    assertOutsideWorkspace(project, base);
    const path = join(base, 'device.json');
    writeFileSync(path, JSON.stringify({ device_id: 'laptop', token: 'x'.repeat(43) }), {
      mode: 0o600,
    });
    assert.equal(readCredential(path).device_id, 'laptop');
    const link = join(base, 'credential-alias');
    symlinkSync(path, link);
    assert.throws(() => readCredential(link));
    chmodSync(path, 0o644);
    assert.throws(() => readCredential(path), { code: 'CREDENTIAL_PERMISSIONS' });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
