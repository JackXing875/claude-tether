import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync, readFileSync, renameSync } from 'node:fs';
import { access, lstat, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { Agent, get } from 'node:https';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repository = 'JackXing875/claude-tether';
const api = `https://api.github.com/repos/${repository}/releases`;
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const bins = { tether: 'dist/src/cli.js', 'claude-tether': 'dist/src/cli.js', 'tether-vscode': 'dist/src/vscode.js' };
type Download = (url: string, limit: number, signal: AbortSignal) => Promise<Buffer>;
type Release = { version: string; tag: string; filename: string; archive: string; checksums: string; digest?: string };

// Only the project's stable and beta release formats are automatic upgrade targets.
function versionParts(version: string): number[] | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/.exec(version);
  if (!match) return;
  const parts = match.slice(1, 4).map(Number);
  if (match[4] !== undefined) parts.push(Number(match[4]));
  if (!parts.every(Number.isSafeInteger)) return;
  return [...parts.slice(0, 3), match[4] === undefined ? Infinity : parts[3]!];
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a), right = versionParts(b);
  if (!left || !right) throw new Error('Unsupported Tether version; install a published stable or beta package first.');
  for (let i = 0; i < left.length; i++) {
    if (left[i]! !== right[i]!) return left[i]! > right[i]! ? 1 : -1;
  }
  return 0;
}

export function selectRelease(releases: unknown[], current: string): Release {
  compareVersions(current, current);
  const candidates = releases.filter((value): value is Record<string, unknown> => {
    if (!value || typeof value !== 'object') return false;
    const item = value as Record<string, unknown>;
    if (item.draft !== false || typeof item.published_at !== 'string' || typeof item.tag_name !== 'string') return false;
    const version = item.tag_name.slice(1);
    return item.tag_name.startsWith('v') && !!versionParts(version)
      && (current.includes('-beta.') || (item.prerelease === false && !version.includes('-')));
  }).sort((a, b) => compareVersions((b.tag_name as string).slice(1), (a.tag_name as string).slice(1)));
  const release = candidates[0];
  if (!release) throw new Error('GitHub has no published release for this update channel.');
  const tag = release.tag_name as string, version = tag.slice(1);
  const filename = `claude-tether-${version}.tgz`;
  const assets = Array.isArray(release.assets) ? release.assets as Record<string, unknown>[] : [];
  const asset = (name: string) => {
    const matching = assets.filter(item => item && item.name === name && item.state === 'uploaded');
    const expected = `https://github.com/${repository}/releases/download/${tag}/${name}`;
    if (matching.length !== 1 || matching[0]!.browser_download_url !== expected) {
      throw new Error(`${tag} is missing a valid ${name} release asset. Try again after publishing finishes.`);
    }
    return matching[0]!;
  };
  const archive = asset(filename), checksums = asset('SHA256SUMS');
  return { version, tag, filename, archive: archive.browser_download_url as string,
    checksums: checksums.browser_download_url as string,
    ...(typeof archive.digest === 'string' ? { digest: archive.digest } : {}) };
}

// Use a separate agent so host proxy settings do not change Claude's transport.
// Deadlines and body limits include redirects; no credentials are sent to GitHub.
export async function download(url: string, limit: number, signal: AbortSignal,
  agent = new Agent({ proxyEnv: process.env, rejectUnauthorized: true })) : Promise<Buffer> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const target = new URL(url);
      if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Update downloads require HTTPS without URL credentials.');
      const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        const request = get(target, { agent, signal: deadline, headers: {
          'User-Agent': 'claude-tether-updater', Accept: 'application/vnd.github+json',
        } }, resolve);
        request.on('error', reject);
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        url = new URL(response.headers.location, target).href;
        response.destroy();
        continue;
      }
      if (response.statusCode !== 200) {
        response.destroy();
        throw new Error(`GitHub download returned HTTP ${response.statusCode}.${[403, 429].includes(response.statusCode ?? 0) ? ' Rate limit or access restriction; retry later.' : ''}`);
      }
      if (Number(response.headers['content-length']) > limit) {
        response.destroy();
        throw new Error('Update download exceeds its size limit.');
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        size += (chunk as Buffer).length;
        if (size > limit) throw new Error('Update download exceeds its size limit.');
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks);
    }
    throw new Error('Too many redirects while downloading an update.');
  } finally { agent.destroy(); }
}

async function listReleases(getBytes: Download, signal: AbortSignal): Promise<unknown[]> {
  const releases: unknown[] = [];
  for (let page = 1; page <= 10; page++) {
    const items: unknown = JSON.parse((await getBytes(`${api}?per_page=100&page=${page}`, 8 * 1024 * 1024, signal)).toString('utf8'));
    if (!Array.isArray(items)) throw new Error('GitHub returned an invalid release list.');
    releases.push(...items);
    if (items.length < 100) return releases;
  }
  throw new Error('Release listing exceeded its page limit; upgrade using the release notes.');
}

export function verifyArchive(release: Release, manifest: Buffer, archive: Buffer): void {
  const matching = manifest.toString('utf8').split(/\r?\n/).map(line => /^([a-fA-F0-9]{64}) [ *](?:\.\/)?([^\s]+)$/.exec(line))
    .filter(match => match?.[2] === release.filename);
  const actual = createHash('sha256').update(archive).digest('hex');
  if (matching.length !== 1 || matching[0]![1]!.toLowerCase() !== actual
    || (release.digest !== undefined && release.digest !== `sha256:${actual}`)) {
    throw new Error('SHA-256 verification failed. The installed version was not changed.');
  }
}

// Synchronous renames keep normal signals outside this short activation window.
// The previous package remains available if activation or a subsequent check fails.
export function activatePackage(current: string, prepared: string, backup: string, move = renameSync): void {
  move(current, backup);
  try { move(prepared, current); }
  catch (error) {
    try { move(backup, current); }
    catch { throw new Error(`Update activation and rollback failed. Restore the previous package from ${backup} to ${current}.`); }
    throw error;
  }
}

export async function update(options: { check?: boolean; root?: string; getBytes?: Download; log?: (message: string) => void } = {}): Promise<void> {
  const root = options.root ?? packageRoot;
  const getBytes = options.getBytes ?? download, log = options.log ?? console.log;
  const installedVersion = () => {
    const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; version: string };
    if (metadata.name !== 'claude-tether') throw new Error('This is not a Tether installation.');
    compareVersions(metadata.version, metadata.version);
    return metadata.version;
  };
  const modules = dirname(root.replace(/\/$/, '')), library = dirname(modules);
  if (!options.check) {
    if (process.platform === 'win32' || basename(root.replace(/\/$/, '')) !== 'claude-tether' || basename(modules) !== 'node_modules'
      || basename(library) !== 'lib' || !(await lstat(root)).isDirectory() || existsSync(join(root, '.git'))) {
      throw new Error('Self-update requires a global npm installation on Linux/WSL or macOS. Source checkouts and linked packages are not overwritten; use the install command in the release notes.');
    }
    try { await access(modules, constants.W_OK); await access(library, constants.W_OK); }
    catch { throw new Error(`The installation at ${root} is not writable. Reinstall into a user-owned npm prefix; Tether does not invoke sudo.`); }
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Update cancelled; retry with tether update.'));
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, cancel);
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  const lockPath = join(library, '.tether-update.lock');
  let staging: string | undefined;
  try {
    if (!options.check) {
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Another update may be running (lock: ${lockPath}). If a previous updater was interrupted, verify it has stopped before removing this lock.`);
        throw error;
      }
      await lock.writeFile(`${process.pid}\n`);
    }
    // Decide from the package protected by this lock, not a pre-lock snapshot.
    const current = installedVersion();
    log(`Checking GitHub Releases (installed: ${current})...`);
    const release = selectRelease(await listReleases(getBytes, controller.signal), current);
    if (compareVersions(release.version, current) <= 0) {
      log(`Tether ${current} is up to date${release.version !== current ? ' (installed version is newer than the published release)' : ''}.`);
      return;
    }
    if (options.check) { log(`Update available: ${current} -> ${release.version}. Run tether update to install.`); return; }
    log(`Downloading ${release.tag} and verifying SHA-256...`);
    const manifest = await getBytes(release.checksums, 64 * 1024, controller.signal);
    const archive = await getBytes(release.archive, 32 * 1024 * 1024, controller.signal);
    verifyArchive(release, manifest, archive);
    controller.signal.throwIfAborted();
    staging = await mkdtemp(join(library, '.tether-update-'));
    const tarball = join(staging, release.filename);
    await writeFile(tarball, archive, { mode: 0o600 });
    const npm = existsSync(join(dirname(process.execPath), 'npm')) ? join(dirname(process.execPath), 'npm') : 'npm';
    try {
      await run(npm, ['install', '--global', '--prefix', staging, '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--engine-strict', '--force=false', '--package-lock=false', tarball], {
        cwd: staging, env: { ...process.env, PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter) },
        signal: controller.signal, timeout: 120_000, maxBuffer: 256 * 1024,
      });
    } catch (error) {
      controller.signal.throwIfAborted();
      const engine = /EBADENGINE/.test(String((error as { stderr?: string }).stderr));
      throw new Error(`Staged npm installation failed; the installed version was not changed. ${engine ? 'Update Node.js/npm to meet the new release requirements.' : 'Check that npm is available and the installation directory has enough free space.'}`);
    }
    const prepared = join(staging, 'lib', 'node_modules', 'claude-tether');
    const next = JSON.parse(await readFile(join(prepared, 'package.json'), 'utf8'));
    if (next.name !== 'claude-tether' || next.version !== release.version || Object.keys(next.bin ?? {}).length !== Object.keys(bins).length
      || Object.entries(bins).some(([name, path]) => next.bin?.[name] !== path)
      || Object.keys(next.dependencies ?? {}).length || Object.keys(next.optionalDependencies ?? {}).length || next.bundleDependencies?.length || next.bundledDependencies?.length) {
      throw new Error('Release package metadata does not match the expected version, launchers or dependency-free layout. Use the release notes to upgrade manually.');
    }
    const childOptions = { cwd: staging, timeout: 10_000, signal: controller.signal };
    const probe = await run(process.execPath, [join(prepared, bins.tether), '--version'], childOptions);
    if (probe.stdout.trim() !== release.version) throw new Error('Staged Tether version check failed; the installed version was not changed.');
    await run(process.execPath, ['--check', join(prepared, bins['tether-vscode'])], childOptions);
    controller.signal.throwIfAborted();
    const backupDirectory = await mkdtemp(join(library, '.tether-backup-'));
    const backup = join(backupDirectory, 'claude-tether');
    try {
      controller.signal.throwIfAborted();
      // External/manual installers may not honor our lock. Refuse any changed
      // installation; re-read synchronously immediately before the renames.
      if (installedVersion() !== current) throw new Error('The installed Tether version changed during the update. No package was replaced; run tether update again.');
      activatePackage(root, prepared, backup);
    }
    catch (error) {
      if (!existsSync(backup)) await rm(backupDirectory, { recursive: true, force: true });
      throw error;
    }
    log(`Updated Tether ${current} -> ${release.version}. Start a new Claude or VS Code session to use it.`);
    log(`Previous package: ${backup}`);
  } finally {
    try { if (staging) await rm(staging, { recursive: true, force: true }); }
    finally {
      try { if (lock) { await lock.close(); await rm(lockPath, { force: true }); } }
      finally { for (const signal of signals) process.off(signal, cancel); }
    }
  }
}
