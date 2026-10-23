import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

// Exercise the actual distributable, including npm's executable link and source files.
const directory = await mkdtemp(join(tmpdir(), 'tether-package-test-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
try {
  const [{ filename, files }] = JSON.parse(execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { encoding: 'utf8' }));
  for (const path of ['dist/src/cli.js', 'dist/src/isolated-child.js', 'src/cli.ts', 'src/settings.ts', 'tsconfig.json', 'LICENSE',
    'docs/NETWORK.md', 'docs/CCPROXY.md', 'docs/TEST-REPORT.md', 'CONTRIBUTING.md', 'SECURITY.md', 'START.md']) {
    assert.ok(files.some(file => file.path === path), `Missing package file: ${path}`);
  }
  assert.ok(files.every(file => !/^(tests|node_modules)\//.test(file.path)));
  // Install as a user would, without the checkout's TypeScript on PATH.
  const env = { ...process.env, PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter) };
  execFileSync(npm, ['install', '--global', '--prefix', directory, '--no-audit', '--no-fund', join(directory, filename)], { stdio: 'inherit', cwd: directory, env });
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of ['tether', 'claude-tether']) {
    const executable = join(directory, 'bin', name);
    assert.equal(execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim(), metadata.version);
    assert.match(execFileSync(executable, ['--help'], { encoding: 'utf8' }), /Usage: tether/);
    assert.match(execFileSync(executable, ['--help'], { encoding: 'utf8' }), /tether setup/);
  }
  console.log('Package installation, tether and compatibility entry points, version and source contents verified.');
} finally { await rm(directory, { recursive: true, force: true }); }
