import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertOutsideWorkspace,
  clientState,
  readCredential,
  stateHome,
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
