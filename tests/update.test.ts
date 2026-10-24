import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { renameSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { Agent, createServer } from 'node:https';
import { createServer as createProxy } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { activatePackage, compareVersions, download, selectRelease, update, verifyArchive } from '../src/update.js';
import { certificate, listen } from './helpers.js';

const run = promisify(execFile);
const bins = { tether: 'dist/src/cli.js', 'claude-tether': 'dist/src/cli.js', 'tether-vscode': 'dist/src/vscode.js' };
const old = '0.3.0-beta.4', next = '0.3.0-beta.10';
function release(version = next, archive = Buffer.from('archive')) {
  const tag = `v${version}`, filename = `claude-tether-${version}.tgz`;
  const hash = createHash('sha256').update(archive).digest('hex');
  return { tag_name: tag, draft: false, prerelease: version.includes('-'), published_at: '2026-10-24T00:00:00Z', assets: [filename, 'SHA256SUMS'].map(name => ({
    name, state: 'uploaded', browser_download_url: `https://github.com/JackXing875/claude-tether/releases/download/${tag}/${name}`,
    ...(name === filename ? { digest: `sha256:${hash}` } : {}),
  })) };
}

async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'tether update test '));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function fixture(t: TestContext, overrides: Record<string, unknown> = {}, entrySource?: string) {
  const path = await directory(t), prefix = join(path, 'prefix'), library = join(prefix, 'lib');
  const root = join(library, 'node_modules', 'claude-tether');
  await mkdir(join(root, 'dist', 'src'), { recursive: true });
  await mkdir(join(prefix, 'bin'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'claude-tether', version: old, type: 'module', bin: bins }));
  const script = '#!/usr/bin/env node\nimport {readFileSync} from "node:fs"; console.log(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url))).version); if(process.argv.includes("--hold")) setInterval(()=>{},1000);';
  await writeFile(join(root, bins.tether), script, { mode: 0o755 });
  await writeFile(join(root, bins['tether-vscode']), script, { mode: 0o755 });
  for (const [name, bin] of Object.entries(bins)) await symlink(`../lib/node_modules/claude-tether/${bin}`, join(prefix, 'bin', name));
  const profile = join(prefix, 'profile.json');
  await writeFile(profile, '{"ssh":"fixture-vps","model":"keep-this-preference"}');
  const source = join(path, 'release');
  await mkdir(join(source, 'dist', 'src'), { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'claude-tether', version: next, type: 'module', bin: bins,
    scripts: { postinstall: 'node -e "process.exit(99)"' }, ...overrides }));
  await writeFile(join(source, bins.tether), entrySource ?? script, { mode: 0o755 });
  await writeFile(join(source, bins['tether-vscode']), script, { mode: 0o755 });
  const packed = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', path], { cwd: source });
  const archive = await readFile(join(path, JSON.parse(packed.stdout)[0].filename));
  const hash = createHash('sha256').update(archive).digest('hex');
  const manifest = Buffer.from(`${hash}  ./claude-tether-${next}.tgz\n`);
  const listing = [release(next, archive)];
  const calls: string[] = [], logs: string[] = [];
  const getBytes = async (url: string) => {
    calls.push(url);
    if (url.includes('/releases?')) return Buffer.from(JSON.stringify(listing));
    return url.endsWith('/SHA256SUMS') ? manifest : archive;
  };
  return { path, prefix, library, root, profile, archive, manifest, listing, calls, logs, getBytes, options: { root, getBytes, log: (message: string) => logs.push(message) } };
}

test('release selection compares numeric beta versions, skips drafts and keeps stable installs on stable releases', () => {
  assert.equal(selectRelease([release('0.3.0-beta.9'), release(), { ...release('9.0.0'), draft: true }], old).version, next);
  assert.equal(selectRelease([release('0.3.0-beta.9'), release('0.3.0')], old).version, '0.3.0');
  assert.equal(selectRelease([release('0.4.0-beta.1'), release('0.3.0')], '0.3.0').version, '0.3.0');
  assert.equal(compareVersions('0.3.0', '0.3.0'), 0);
  assert.equal(compareVersions('0.3.0-beta.10', '0.3.0-beta.9'), 1);
  assert.throws(() => selectRelease([release('0.3.0-rc.1')], old), /no published release/);
  assert.throws(() => selectRelease([{ ...release(), assets: [] }], old), /missing a valid/);
  const untrusted = release(); untrusted.assets[0]!.browser_download_url = 'https://example.invalid/package.tgz';
  assert.throws(() => selectRelease([untrusted], old), /missing a valid/);
});

test('checksum validation rejects damaged archives, ambiguous manifests and mismatched GitHub digests', () => {
  const archive = Buffer.from('archive'), selected = selectRelease([release(next, archive)], old);
  const line = `${createHash('sha256').update(archive).digest('hex')}  ./${selected.filename}\n`;
  verifyArchive(selected, Buffer.from(line), archive);
  assert.throws(() => verifyArchive(selected, Buffer.from(line), Buffer.from('damaged')), /SHA-256/);
  assert.throws(() => verifyArchive(selected, Buffer.from(line.repeat(2)), archive), /SHA-256/);
  assert.throws(() => verifyArchive({ ...selected, digest: `sha256:${'0'.repeat(64)}` }, Buffer.from(line), archive), /SHA-256/);
});

test('update installs a verified tarball into the invoked prefix, retains launchers/profile and backs up the old package', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const running = spawn(process.execPath, [join(f.root, bins.tether), '--hold']);
  const closed = once(running, 'close');
  t.after(async () => { running.kill('SIGTERM'); await closed; });
  await once(running.stdout, 'data');
  const before = await readFile(f.profile);
  await update(f.options);
  assert.equal(running.exitCode, null, 'existing processes must not be terminated');
  for (const [name, bin] of Object.entries(bins)) {
    const launcher = join(f.prefix, 'bin', name);
    assert.equal(await readlink(launcher), `../lib/node_modules/claude-tether/${bin}`);
    assert.equal((await run(launcher, ['--version'])).stdout.trim(), next);
  }
  assert.deepEqual(await readFile(f.profile), before);
  const siblings = await readdir(f.library);
  assert.ok(!siblings.some(name => name.startsWith('.tether-update')));
  const backup = siblings.find(name => name.startsWith('.tether-backup-'))!;
  assert.equal(JSON.parse(await readFile(join(f.library, backup, 'claude-tether', 'package.json'), 'utf8')).version, old);
  assert.match(f.logs.join('\n'), /Updated Tether/);
  const inodeBytes = await readFile(join(f.root, 'package.json'));
  f.calls.length = 0;
  await update(f.options);
  assert.equal(f.calls.length, 1, 'up-to-date installs must not download assets or run npm');
  assert.deepEqual(await readFile(join(f.root, 'package.json')), inodeBytes);
});

test('check-only and newer installed versions leave the installation untouched; listing follows pagination', async t => {
  const f = await fixture(t);
  const before = await readFile(join(f.root, 'package.json'));
  await update({ ...f.options, check: true });
  assert.equal(f.calls.length, 1);
  assert.match(f.logs.join('\n'), /Update available/);
  assert.deepEqual(await readFile(join(f.root, 'package.json')), before);
  const pages: string[] = [];
  await update({ ...f.options, getBytes: async url => {
    pages.push(url);
    return Buffer.from(JSON.stringify(url.endsWith('page=1') ? Array.from({ length: 100 }, () => release('0.2.0-beta.1')) : [release('0.3.0-beta.3')]));
  } });
  assert.equal(pages.length, 2);
  assert.match(f.logs.join('\n'), /installed version is newer/);
  assert.deepEqual(await readFile(join(f.root, 'package.json')), before);
});

test('failed download or checksum verification leaves the old executable intact and releases the lock', async t => {
  const f = await fixture(t);
  for (const failure of ['network', 'checksum']) {
    await assert.rejects(update({ ...f.options, getBytes: async url => {
      if (url.endsWith('.tgz')) {
        if (failure === 'network') throw new Error('fixture connection lost');
        return Buffer.from('corrupt');
      }
      return f.getBytes(url);
    } }), failure === 'network' ? /connection lost/ : /SHA-256/);
    assert.equal((await run(join(f.prefix, 'bin', 'tether'), ['--version'])).stdout.trim(), old);
    assert.deepEqual(await readdir(f.library), ['node_modules']);
  }
});

test('incompatible runtime, wrong package version and failed executable checks never replace the working installation', { timeout: 30_000 }, async t => {
  for (const scenario of [
    { metadata: { engines: { node: '>=999.0.0' } } },
    { metadata: { version: '0.3.0-beta.11' } },
    { metadata: { bin: { tether: 'missing.js' } } },
    { metadata: {}, entrySource: 'console.log("wrong-version");' },
  ]) {
    const f = await fixture(t, scenario.metadata, scenario.entrySource);
    await assert.rejects(update(f.options), /Staged npm installation failed|Release package metadata|Staged Tether version check/);
    assert.equal((await run(join(f.prefix, 'bin', 'tether'), ['--version'])).stdout.trim(), old);
    assert.deepEqual(await readdir(f.library), ['node_modules']);
  }
});

test('source checkouts and read-only installations are rejected before network activity', async t => {
  const path = await directory(t);
  await writeFile(join(path, 'package.json'), JSON.stringify({ name: 'claude-tether', version: old }));
  const getBytes = async () => { throw new Error('network must not be used'); };
  await assert.rejects(update({ root: path, getBytes }), /Source checkouts/);
  if (process.getuid?.() === 0) return; // root can write despite chmod; CI and WSL exercise this as a user.
  const f = await fixture(t);
  await chmod(dirname(f.root), 0o555);
  try { await assert.rejects(update({ root: f.root, getBytes }), /not writable/); }
  finally { await chmod(dirname(f.root), 0o755); }
});

test('simultaneous updates cannot replace the same package; interrupted downloads retain the current executable', async t => {
  const f = await fixture(t);
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const first = update({ ...f.options, getBytes: async (_url, _limit, signal) => {
    started();
    return new Promise<Buffer>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  await ready;
  await assert.rejects(update(f.options), /Another update may be running/);
  process.emit('SIGINT');
  await assert.rejects(first, /Update cancelled/);
  assert.equal((await run(join(f.prefix, 'bin', 'tether'), ['--version'])).stdout.trim(), old);
  assert.deepEqual(await readdir(f.library), ['node_modules']);
});

test('activation rolls back if the second filesystem rename fails', async t => {
  const path = await directory(t), current = join(path, 'current'), prepared = join(path, 'prepared'), backup = join(path, 'backup');
  await mkdir(current); await mkdir(prepared);
  await writeFile(join(current, 'identity'), 'old'); await writeFile(join(prepared, 'identity'), 'new');
  assert.throws(() => activatePackage(current, prepared, backup, (from, to) => {
    if (from === prepared) throw new Error('fixture rename failure');
    renameSync(from, to);
  }), /fixture rename failure/);
  assert.equal(await readFile(join(current, 'identity'), 'utf8'), 'old');
  assert.equal(await readFile(join(prepared, 'identity'), 'utf8'), 'new');
});

test('HTTPS downloader verifies TLS, handles redirects, bounds bodies, reports rate limits and cancels stalled responses', { timeout: 10_000 }, async t => {
  const path = await directory(t), tls = await certificate(path);
  let requests = 0;
  const server = createServer(tls, (req, res) => {
    requests++;
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/ok' }); res.end(); }
    else if (req.url === '/insecure') { res.writeHead(302, { Location: 'http://localhost/not-allowed' }); res.end(); }
    else if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); }
    else if (req.url === '/limit') { res.writeHead(429); res.end(); }
    else if (req.url === '/stall') { res.writeHead(200); res.flushHeaders(); }
    else if (req.url === '/truncated') { res.writeHead(200, { 'Content-Length': 100 }); res.write('short'); setImmediate(() => res.destroy()); }
    else { res.writeHead(200); res.write('hello'); res.end(' world'); }
  });
  const port = await listen(t, server), base = `https://localhost:${port}`;
  const getBytes = (route: string, limit = 100, signal = AbortSignal.timeout(2_000)) => download(base + route, limit, signal, new Agent({ ca: tls.cert }));
  assert.equal((await getBytes('/redirect')).toString(), 'hello world');
  await assert.rejects(download(base + '/ok', 100, AbortSignal.timeout(2_000), new Agent()), /self-signed certificate/);
  await assert.rejects(getBytes('/insecure'), /require HTTPS/);
  await assert.rejects(getBytes('/loop'), /Too many redirects/);
  await assert.rejects(getBytes('/ok', 5), /size limit/);
  await assert.rejects(getBytes('/limit'), /Rate limit/);
  await assert.rejects(getBytes('/stall', 100, AbortSignal.timeout(100)), /abort/i);
  await assert.rejects(getBytes('/truncated'), /abort|socket hang up/i);
  const proxy = createProxy();
  let proxyRequests = 0;
  proxy.on('connect', (_request, socket) => { proxyRequests++; socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); });
  const proxyPort = await listen(t, proxy), before = requests;
  await assert.rejects(download(base + '/ok', 100, AbortSignal.timeout(2_000), new Agent({ ca: tls.cert,
    proxyEnv: { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: '' },
  })), /502/);
  assert.equal(proxyRequests, 1); assert.equal(requests, before, 'a failed host proxy must not fall back to direct access');
});
