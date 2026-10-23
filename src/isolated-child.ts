import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { localSocket, startBridge } from './bridge.js';
import { proxyEnvironment } from './environment.js';

// This helper and every Claude descendant run inside the same network/PID
// namespace. When its PID 1 dies, the kernel kills the remaining descendants.
async function main(): Promise<number> {
  const [proxySocket, gatewaySocket, executable, ...args] = process.argv.slice(2);
  if (!proxySocket || !executable) throw new Error('Invalid isolated launcher arguments');
  const proxy = await startBridge(signal => localSocket(proxySocket, signal));
  let gateway: Awaited<ReturnType<typeof startBridge>> | undefined;
  try {
    if (gatewaySocket) gateway = await startBridge(signal => localSocket(gatewaySocket, signal));
    const env = proxyEnvironment(process.env, `http://127.0.0.1:${proxy.port}`);
    if (gateway) env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${gateway.port}`;
    const child = spawn(executable, args, { stdio: 'inherit', env, shell: false });
    const stop = (signal: NodeJS.Signals) => {
      if (signal === 'SIGINT' && process.stdin.isTTY) return; // Foreground group gets Ctrl+C.
      child.kill(signal);
    };
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const signal of signals) process.on(signal, stop);
    try {
      return await new Promise<number>((resolve, reject) => {
        child.once('error', () => reject(new Error('Cannot start official Claude Code inside network isolation.')));
        child.once('close', (code, signal) => resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)));
      });
    } finally { for (const signal of signals) process.off(signal, stop); }
  } finally { await gateway?.close(); await proxy.close(); }
}

if (import.meta.main) {
  main().then(code => { process.exitCode = code; }, error => {
    console.error('[tether] ' + (error instanceof Error ? error.message : 'Isolated launcher failed'));
    process.exitCode = 1;
  });
}
