// TCP-only OpenSSH substitute. Never connects to an external host or reads keys.
import { connect } from 'node:net';
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.TETHER_SSH_AUDIT)
  appendFileSync(process.env.TETHER_SSH_AUDIT, JSON.stringify({ pid: process.pid, args }) + '\n');
if (process.env.TETHER_SSH_HANG === '1') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
  const target = args[args.indexOf('-W') + 1]!;
  const socket = connect(Number(target.split(':')[1]), '127.0.0.1');
  socket.on('error', () => {
    process.exitCode = 1;
    process.stdin.destroy();
  });
  socket.on('close', () => {
    process.stdin.destroy();
  });
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
}
