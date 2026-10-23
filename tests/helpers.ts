import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';

export async function listen(t: TestContext, server: Server): Promise<number> {
  const sockets = new Set<Socket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return (server.address() as { port: number }).port;
}

export async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Condition timed out');
    await delay(20);
  }
}

export function connectProxy(url: string, target: string) {
  return new Promise<{ status: number; socket: Socket; head: Buffer }>((resolve, reject) => {
    const proxy = new URL(url);
    const req = request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: target });
    req.on('connect', (res, socket, head) => resolve({ status: res.statusCode!, socket, head }));
    req.on('error', reject);
    req.end();
  });
}

export async function sshFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tether-ssh-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ['host', 'client']) {
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(directory, name)]);
  }
  const reserve = createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const config = join(directory, 'ssh_config');
  await writeFile(join(directory, 'known_hosts'), `[127.0.0.1]:${port} ${await readFile(join(directory, 'host.pub'), 'utf8')}`);
  await writeFile(config, `Host test-vps\n  HostName 127.0.0.1\n  Port ${port}\n  User ${userInfo().username}\n  IdentityFile ${directory}/client\n  IdentitiesOnly yes\n  UserKnownHostsFile ${directory}/known_hosts\n`);
  const serverConfig = join(directory, 'sshd_config');
  // Isolated test keys live under /tmp, not the system user's home directory.
  await writeFile(serverConfig, `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${directory}/host\nPidFile ${directory}/pid\nAuthorizedKeysFile ${directory}/client.pub\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nAllowTcpForwarding local\nLogLevel ERROR\n`);
  const server = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', serverConfig], { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = '';
  server.stderr.on('data', chunk => { diagnostics += String(chunk); });
  const closed = once(server, 'close');
  t.after(async () => { server.kill('SIGTERM'); await closed; });
  await delay(100);
  if (server.exitCode !== null) throw new Error('Test sshd could not start: ' + diagnostics);
  return { directory, config };
}

export async function certificate(directory: string) {
  const keyPath = join(directory, 'tls.key'), certPath = join(directory, 'tls.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
    '-out', certPath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  return { key: await readFile(keyPath), cert: await readFile(certPath) };
}
