import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { connectSocks, openSocks } from './proxy.js';

export interface TunnelOptions {
  destination: string;
  config?: string;
  log?: (message: string) => void;
  // Injectable process boundary for failure tests; the CLI always uses OpenSSH.
  launch?: (args: string[]) => ChildProcess;
  retryMs?: number;
  connectTimeoutMs?: number;
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export function sshArgs(destination: string, port: number, config?: string): string[] {
  if (!destination || destination.startsWith('-') || !/^[a-zA-Z0-9_.@:[\]-]+$/.test(destination)) {
    throw new Error('--ssh must be an SSH config alias or user@host');
  }
  return [
    ...(config ? ['-F', config] : []), '-N', '-T', '-D', `127.0.0.1:${port}`,
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-o', 'ForwardAgent=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '--', destination,
  ];
}

export class SshTunnel {
  private readonly stopped = new AbortController();
  private child?: ChildProcess;
  private task?: Promise<void>;
  private readyPort?: number;
  private failure?: unknown;

  constructor(private readonly options: TunnelOptions) {
    sshArgs(options.destination, 1, options.config);
  }

  async start(timeoutMs = 30_000): Promise<void> {
    this.task ??= this.run().catch(error => { this.failure = error; this.stopped.abort(); });
    try { await this.waitReady(AbortSignal.timeout(timeoutMs)); }
    catch (error) { await this.stop(); throw this.failure ?? error; }
  }

  private async waitReady(signal: AbortSignal): Promise<number> {
    const waiting = AbortSignal.any([signal, this.stopped.signal]);
    while (this.readyPort === undefined) await delay(50, undefined, { signal: waiting });
    waiting.throwIfAborted();
    return this.readyPort;
  }

  async connect(host: string, port: number, signal: AbortSignal) {
    const timeout = AbortSignal.timeout(this.options.connectTimeoutMs ?? 30_000);
    const waiting = AbortSignal.any([signal, timeout, this.stopped.signal]);
    const socksPort = await this.waitReady(waiting);
    // The deadline applies only to establishment, not the lifetime of the stream.
    const controller = new AbortController();
    const abort = () => controller.abort();
    waiting.addEventListener('abort', abort, { once: true });
    try {
      waiting.throwIfAborted();
      return await connectSocks(socksPort, host, port, controller.signal);
    } finally {
      waiting.removeEventListener('abort', abort);
    }
  }

  private async run(): Promise<void> {
    let attempt = 0;
    const log = this.options.log ?? (() => {});
    while (!this.stopped.signal.aborted) {
      const port = await freePort();
      if (this.stopped.signal.aborted) break;
      const args = sshArgs(this.options.destination, port, this.options.config);
      const child = this.options.launch?.(args) ?? spawn('ssh', args, { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
      this.child = child;
      let exited = false;
      const closed = new Promise<void>(resolve => {
        child.once('error', error => { this.failure = error; this.stopped.abort(); });
        child.once('close', () => { exited = true; this.readyPort = undefined; resolve(); });
      });
      while (!exited && !this.stopped.signal.aborted) {
        try {
          const probe = await openSocks(port, AbortSignal.any([this.stopped.signal, AbortSignal.timeout(300)]));
          probe.destroy();
          if (!exited) this.readyPort = port;
          break;
        } catch { await Promise.race([closed, delay(100)]); }
      }
      const readyAt = this.readyPort === undefined ? 0 : Date.now();
      if (readyAt) log('SSH tunnel ready.');
      if (this.stopped.signal.aborted) child.kill('SIGTERM');
      await closed;
      this.child = undefined;
      if (this.stopped.signal.aborted) break;
      if (readyAt && Date.now() - readyAt >= 30_000) attempt = 0;
      const backoff = Math.min(30_000, (this.options.retryMs ?? 500) * 2 ** Math.min(attempt++, 8));
      const wait = Math.min(30_000, Math.round(backoff * (0.8 + Math.random() * 0.4)));
      log(`SSH disconnected; reconnecting in ${(wait / 1000).toFixed(1)}s.`);
      try { await delay(wait, undefined, { signal: this.stopped.signal }); } catch { break; }
    }
  }

  async stop(): Promise<void> {
    this.stopped.abort();
    this.readyPort = undefined;
    const child = this.child;
    child?.kill('SIGTERM');
    const timer = setTimeout(() => child?.kill('SIGKILL'), 2_000);
    timer.unref();
    try { await this.task; } finally { clearTimeout(timer); }
  }
}
