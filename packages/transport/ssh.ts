import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { BridgeError } from '../protocol/index.js';

export interface SshOptions {
  /** An entry in the chosen OpenSSH executable's existing config. */
  alias: string;
  executable?: string;
  relayPort?: number;
}

export function validateSshOptions(options: SshOptions): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(options.alias))
    throw new BridgeError(
      'USAGE',
      'Use an SSH config alias containing letters, digits, dots, underscores or hyphens.',
    );
  const port = options.relayPort ?? 8787;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new BridgeError('USAGE', 'Relay port must be between 1 and 65535.');
  if (
    options.executable !== undefined &&
    (!options.executable || options.executable.includes('\0'))
  )
    throw new BridgeError('USAGE', 'Use an SSH executable path without command arguments.');
}

/** Byte transport through OpenSSH; it never reads private keys or parses relay credentials. */
export async function openSshTunnel(options: SshOptions): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  validateSshOptions(options);
  const sockets = new Set<Socket>();
  const workers = new Set<{ stop(): void; done: Promise<void> }>();
  let closing: Promise<void> | undefined;
  const server = createServer((socket) => {
    if (closing || sockets.size >= 16) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    // -W gives one stream to the remote loopback relay. No shell or remote command is used.
    // This also works with Windows OpenSSH from WSL without copying its private key.
    const child = spawn(
      options.executable ?? 'ssh',
      [
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        'ConnectTimeout=8',
        '-o',
        'ServerAliveInterval=15',
        '-o',
        'ServerAliveCountMax=3',
        '-W',
        '127.0.0.1:' + (options.relayPort ?? 8787),
        options.alias,
      ],
      { shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let killTimer: NodeJS.Timeout | undefined;
    let stopped = false;
    const worker: { stop(): void; done: Promise<void> } = {
      stop: () => {
        if (stopped || child.exitCode !== null || child.signalCode !== null) return;
        stopped = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 500);
        killTimer.unref();
      },
      done: new Promise<void>((resolve) => {
        child.once('close', () => {
          if (killTimer) clearTimeout(killTimer);
          workers.delete(worker);
          socket.destroy();
          resolve();
        });
      }),
    };
    workers.add(worker);
    child.on('error', () => socket.destroy());
    child.stdin.on('error', () => socket.destroy());
    child.stdout.on('error', () => socket.destroy());
    child.stderr.resume(); // Do not forward arbitrary SSH diagnostics or account details.
    socket.on('error', () => {});
    socket.once('close', () => {
      sockets.delete(socket);
      worker.stop();
    });
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new BridgeError('SSH_CONNECTION_FAILED', 'Could not create a local SSH transport.');
  return {
    url: `ws://127.0.0.1:${address.port}/v1/bridge`,
    close: () =>
      (closing ??= (async () => {
        for (const socket of sockets) socket.destroy();
        const pending = [...workers];
        for (const worker of pending) worker.stop();
        await Promise.all(pending.map((worker) => worker.done));
        await new Promise<void>((resolve) => server.close(() => resolve()));
      })()),
  };
}
