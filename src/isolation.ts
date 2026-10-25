import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type NetworkMode = 'isolated' | 'proxy';
export type ProcessMode = 'host' | 'isolated';
const supervisor = fileURLToPath(new URL('../../src/process-supervisor.py', import.meta.url));

export function networkMode(value: string): NetworkMode {
  if (value !== 'isolated' && value !== 'proxy') throw new Error('--network must be isolated or proxy');
  return value;
}

export function processMode(value: string): ProcessMode {
  if (value !== 'host' && value !== 'isolated') throw new Error('--processes must be host or isolated');
  return value;
}

// Keep compute devices available without exposing all of the host's /dev.
// Symlinks, ordinary files and unrelated devices are deliberately excluded.
export function gpuDevices(root = '/dev'): string[] {
  const devices: string[] = [];
  for (const [directory, pattern] of [
    [root, /^(dxg|kfd|nvidia(?:\d+|ctl|-uvm|-uvm-tools|-modeset))$/],
    [join(root, 'dri'), /^(card\d+|renderD\d+)$/],
    [join(root, 'nvidia-caps'), /^nvidia-cap\d+$/],
  ] as const) {
    try {
      if (!lstatSync(directory).isDirectory()) continue;
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        // A bind-mounted device can have a regular-file directory entry. Inspect
        // the mounted inode without following symlinks instead of trusting d_type.
        if (pattern.test(name) && lstatSync(path).isCharacterDevice()) devices.push(path);
      }
    } catch (error) {
      if (!['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  return devices.sort();
}

export function namespaceArgs(command: string[], ipcDirectories: string[] = [], processes: ProcessMode = 'host'): string[] {
  return ['--unshare-user', '--unshare-net', ...(processes === 'isolated' ? ['--unshare-pid'] : []), '--unshare-ipc',
    '--disable-userns', '--cap-drop', 'ALL', '--bind', '/', '/', '--proc', '/proc',
    '--dev', '/dev', ...gpuDevices().flatMap(path => ['--dev-bind', path, path]), '--tmpfs', '/run',
    // TMPDIR may live below /run or /dev. Re-expose only our private IPC
    // directories after those parents have been replaced, not their siblings.
    ...ipcDirectories.flatMap(path => ['--bind', path, path]),
    // WSL interop would otherwise start Windows programs outside this namespace.
    ...(existsSync('/init') ? ['--ro-bind', '/dev/null', '/init'] : []),
    '--unsetenv', 'WSL_INTEROP', '--unsetenv', 'WSLENV', '--unsetenv', 'SSH_AUTH_SOCK',
    '--die-with-parent', '--', ...command];
}

export function checkIsolation(processes: ProcessMode = 'host'): void {
  if (process.platform !== 'linux') throw new Error('Isolated networking requires Linux/WSL and bubblewrap. Use --network proxy explicitly for compatibility mode.');
  const check = spawnSync('bwrap', namespaceArgs(['/bin/true'], [], processes), { encoding: 'utf8', timeout: 10_000 });
  if (check.status !== 0) {
    throw new Error('Network isolation unavailable: install bubblewrap >= 0.9 and enable user namespaces for bwrap. No direct fallback was used. See docs/NETWORK.md or explicitly select --network proxy.');
  }
  if (processes === 'host') {
    const supervision = spawnSync('python3', ['-I', supervisor, '--check'], { encoding: 'utf8', timeout: 10_000 });
    if (supervision.status !== 0) throw new Error('Host process mode requires Python >= 3.9 with Linux subreaper support. Install python3 or use --processes isolated. No unconfined fallback was used.');
  }
}

export function isolatedCommand(executable: string, args: string[], proxySocket: string, gatewaySocket?: string, processes: ProcessMode = 'host') {
  const directories = [...new Set([proxySocket, ...(gatewaySocket ? [gatewaySocket] : [])].map(dirname))];
  const bwrap = namespaceArgs([process.execPath,
    fileURLToPath(new URL('./isolated-child.js', import.meta.url)), proxySocket, gatewaySocket ?? '', executable, ...args], directories, processes);
  return processes === 'host'
    ? { executable: 'python3', args: ['-I', supervisor, '--parent', String(process.pid), '--', 'bwrap', ...bwrap] }
    : { executable: 'bwrap', args: bwrap };
}
