import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type NetworkMode = 'isolated' | 'proxy';

export function networkMode(value: string): NetworkMode {
  if (value !== 'isolated' && value !== 'proxy') throw new Error('--network must be isolated or proxy');
  return value;
}

export function namespaceArgs(command: string[]): string[] {
  return ['--unshare-user', '--unshare-net', '--unshare-pid', '--unshare-ipc',
    '--disable-userns', '--cap-drop', 'ALL', '--bind', '/', '/', '--proc', '/proc',
    '--dev', '/dev', '--tmpfs', '/run',
    // WSL interop would otherwise start Windows programs outside this namespace.
    ...(existsSync('/init') ? ['--ro-bind', '/dev/null', '/init'] : []),
    '--unsetenv', 'WSL_INTEROP', '--unsetenv', 'WSLENV', '--unsetenv', 'SSH_AUTH_SOCK',
    '--die-with-parent', '--', ...command];
}

export function checkIsolation(): void {
  if (process.platform !== 'linux') throw new Error('Isolated networking requires Linux/WSL and bubblewrap. Use --network proxy explicitly for compatibility mode.');
  const check = spawnSync('bwrap', namespaceArgs(['/bin/true']), { encoding: 'utf8', timeout: 10_000 });
  if (check.status !== 0) {
    throw new Error('Network isolation unavailable: install bubblewrap >= 0.9 and enable user namespaces for bwrap. No direct fallback was used. See docs/NETWORK.md or explicitly select --network proxy.');
  }
}

export function isolatedCommand(executable: string, args: string[], proxySocket: string, gatewaySocket?: string) {
  return { executable: 'bwrap', args: namespaceArgs([process.execPath,
    fileURLToPath(new URL('./isolated-child.js', import.meta.url)), proxySocket, gatewaySocket ?? '', executable, ...args]) };
}
