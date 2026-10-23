import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
const artifacts = join(root, 'artifacts');
mkdirSync(artifacts, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), 'tether-install-'));
const run = (program, args, options = {}) => {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  assert.equal(
    result.status,
    0,
    program + ' failed:\n' + (result.stderr || result.error || result.stdout),
  );
  return result.stdout;
};
try {
  // npm's lifecycle hook builds from source. Install the real tarball without devDependencies.
  const output = run('npm', ['pack', '--json', '--pack-destination', artifacts]);
  const packed = JSON.parse(output.slice(output.indexOf('[')))[0];
  const names = packed.files.map((entry) => entry.path);
  for (const name of names) {
    assert.ok(
      !/(?:^|\/)(?:tests|node_modules|coverage|\.git)(?:\/|$)|\.(?:sqlite|pem|key|tgz)$|(?:^|\/)\.env/.test(
        name,
      ),
      'Unexpected packaged file: ' + name,
    );
  }
  for (const required of [
    'bin/tether.mjs',
    'dist/apps/cli/index.js',
    'dist/packages/client/index.d.ts',
    'packages/client/index.ts',
    'LICENSE',
    'CONTRIBUTING.md',
    'SECURITY.md',
    '.nvmrc',
  ]) {
    assert.ok(names.includes(required), 'Missing packaged file: ' + required);
  }
  const tarball = join(artifacts, packed.filename);
  writeFileSync(
    join(artifacts, 'SHA256SUMS'),
    createHash('sha256').update(readFileSync(tarball)).digest('hex') +
      '  ' +
      packed.filename +
      '\n',
  );
  const prefix = join(temporary, 'installation');
  run(
    'npm',
    ['install', '--global', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', tarball],
    { cwd: temporary },
  );
  const executable = join(prefix, 'bin', 'tether');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(run(executable, ['--version'], { cwd: temporary }).trim(), pkg.version);
  assert.match(run(executable, ['--help'], { cwd: temporary }), /Usage: tether/);
  assert.match(run(executable, ['demo'], { cwd: temporary }), /演示验收通过/);
  const installed = join(prefix, 'lib', 'node_modules', pkg.name);
  // Import public exports from a consumer, not through unpublished source paths.
  run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const a=await import('claude-tether/client'); const b=await import('claude-tether/relay'); if(!a.BridgeClient||!b.RelayServer)process.exit(1);",
    ],
    { cwd: installed },
  );
  console.log(
    'Package smoke passed: clean production install, public exports, help, version, and full offline demo.',
  );
  console.log('Artifact: ' + packed.filename + ' (' + packed.files.length + ' files)');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
