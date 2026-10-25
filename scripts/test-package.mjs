import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Exercise the actual distributable, including npm's executable link and source files.
const directory = await mkdtemp(join(tmpdir(), 'tether-package-test-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
try {
  const [{ filename, files }] = JSON.parse(execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { encoding: 'utf8' }));
  for (const path of ['dist/src/cli.js', 'dist/src/vscode.js', 'dist/src/update.js', 'dist/src/isolated-child.js', 'dist/src/diagnostics.js', 'src/process-supervisor.py', 'src/cli.ts', 'src/vscode.ts', 'src/update.ts', 'src/settings.ts', 'tsconfig.json', 'LICENSE',
    'docs/VSCODE.md', 'docs/NETWORK.md', 'docs/CCPROXY.md', 'docs/TEST-REPORT.md', 'CONTRIBUTING.md', 'SECURITY.md', 'START.md']) {
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
    assert.match(execFileSync(executable, ['update', '--help'], { encoding: 'utf8' }), /Usage: tether update/);
    assert.match(execFileSync(executable, ['doctor', '--inotify', '--help'], { encoding: 'utf8' }), /host inotify/);
  }
  const vscode = spawnSync(join(directory, 'bin', 'tether-vscode'), [], { encoding: 'utf8', env });
  assert.equal(vscode.status, 1); assert.equal(vscode.stdout, '');
  assert.match(vscode.stderr, /claudeCode.claudeProcessWrapper/);

  // Exercise the shipped updater itself with the real packed artifact. Only release
  // discovery/download are substituted; installation, activation and probes are real.
  const root = join(directory, 'lib', 'node_modules', 'claude-tether');
  const { checkIsolation } = await import(pathToFileURL(join(root, 'dist/src/isolation.js')).href);
  checkIsolation('host'); // Includes locating and executing the shipped Python helper.
  const installed = join(root, 'package.json');
  await writeFile(installed, JSON.stringify({ ...metadata, version: '0.0.0-beta.0' }));
  const { update } = await import(pathToFileURL(join(root, 'dist/src/update.js')).href);
  const archive = await readFile(join(directory, filename));
  const hash = createHash('sha256').update(archive).digest('hex');
  const tag = `v${metadata.version}`;
  const release = { tag_name: tag, draft: false, prerelease: true, published_at: new Date().toISOString(),
    assets: [filename, 'SHA256SUMS'].map(name => ({ name, state: 'uploaded',
      browser_download_url: `https://github.com/JackXing875/claude-tether/releases/download/${tag}/${name}` })) };
  await update({ getBytes: async url => {
    if (url.includes('/releases?')) return Buffer.from(JSON.stringify([release]));
    return url.endsWith('/SHA256SUMS') ? Buffer.from(`${hash}  ./${filename}\n`) : archive;
  } });
  for (const name of ['tether', 'claude-tether']) {
    assert.equal(execFileSync(join(directory, 'bin', name), ['--version'], { encoding: 'utf8' }).trim(), metadata.version);
  }
  const updatedVscode = spawnSync(join(directory, 'bin', 'tether-vscode'), [], { encoding: 'utf8', env });
  assert.equal(updatedVscode.status, 1); assert.match(updatedVscode.stderr, /claudeCode.claudeProcessWrapper/);
  console.log('Packed installation and self-update, CLI/VS Code entry points, version and source contents verified.');
} finally { await rm(directory, { recursive: true, force: true }); }
