#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { startProxy } from './proxy.js';
import { SshTunnel } from './tunnel.js';
import { readSettings, saveSettings, settingsPath } from './settings.js';
import { proxyEnvironment } from './environment.js';
import { localSocket, startBridge } from './bridge.js';
import { checkIsolation, isolatedCommand, namespaceArgs, networkMode } from './isolation.js';
export { proxyEnvironment } from './environment.js';

export async function main(argv: string[]): Promise<number> {
  const separator = argv.indexOf('--');
  const ownArgs = argv.slice(0, separator < 0 ? argv.length : separator);
  const command = ['setup', 'doctor'].includes(ownArgs[0] ?? '') ? ownArgs.shift()! : 'run';
  const { values, positionals } = parseArgs({ args: ownArgs, allowPositionals: command === 'setup', options: {
    ssh: { type: 'string' }, 'ssh-config': { type: 'string' },
    network: { type: 'string' }, 'ccproxy-port': { type: 'string' },
    'no-ccproxy': { type: 'boolean' },
    claude: { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } });
  if (values.help) {
    console.log(`Usage: tether [options] -- [Claude arguments]
       tether setup [SSH alias|user@host] [options]
       tether doctor [options]

Runs official Claude Code locally through an automatically reconnected SSH tunnel.

First use:  tether setup my-vps
Daily use:  tether
Resume:     tether -- --continue

Options:
  --ssh <destination>   Override the saved SSH destination for this invocation
  --ssh-config <file>  Use a specific OpenSSH configuration file
  --claude <path>      Use a specific official Claude executable
  --network <mode>     isolated (default, Linux/WSL) or proxy (compatibility)
  --ccproxy-port <n>   Use ccproxy on VPS loopback via SSH (experimental)
  --no-ccproxy         Disable a saved ccproxy gateway for this invocation
  -h, --help          Show this help
  -v, --version       Show the installed version

Setup checks local Claude and SSH before saving preferences; no credentials are saved.
Doctor checks the executable and SSH tunnel without sending a model request.
Isolated mode requires bubblewrap >= 0.9; proxy overrides cannot restore direct IP egress.
Proxy-unaware tools are blocked in isolated mode. This is not a system-wide VPN.
First verify the host key and key/agent login with ssh. VPS requires only OpenSSH.`);
    return 0;
  }
  if (values.version) {
    console.log((JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version);
    return 0;
  }
  if (positionals.length > 1) throw new Error('Setup accepts one SSH destination. Use --help for usage.');
  if (command !== 'run' && separator >= 0) throw new Error('Claude arguments are only accepted when launching Claude.');
  const saved = await readSettings();
  let destination = values.ssh ?? positionals[0] ?? saved.ssh;
  if (!destination && command === 'setup' && process.stdin.isTTY) {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try { destination = (await terminal.question('VPS SSH alias or user@host: ')).trim(); }
    finally { terminal.close(); }
  }
  if (!destination) throw new Error('First run: tether setup <SSH alias|user@host>. You can also use --ssh for a one-time connection.');
  const sshConfig = values['ssh-config'] ?? saved.sshConfig;
  const executable = values.claude ?? saved.claude ?? 'claude';
  const network = networkMode(values.network ?? saved.network ?? 'isolated');
  if (values['ccproxy-port'] && values['no-ccproxy']) throw new Error('Choose --ccproxy-port or --no-ccproxy, not both');
  const ccproxyPort = values['no-ccproxy'] ? undefined : values['ccproxy-port'] ?? saved.ccproxyPort;
  if (ccproxyPort !== undefined && (!/^\d{1,5}$/.test(ccproxyPort) || Number(ccproxyPort) < 1 || Number(ccproxyPort) > 65535)) {
    throw new Error('--ccproxy-port must be a port between 1 and 65535 on VPS 127.0.0.1');
  }
  if (network === 'isolated') checkIsolation();
  const available = network === 'isolated'
    ? spawnSync('bwrap', namespaceArgs([executable, '--version']), { stdio: 'ignore', timeout: 10_000 })
    : spawnSync(executable, ['--version'], { stdio: 'ignore', timeout: 10_000 });
  if (available.status !== 0) throw new Error('Local Claude Code is unavailable. Install the official CLI or use --claude /path/to/claude.');
  const args = separator < 0 ? [] : argv.slice(separator + 1);
  const tunnel = new SshTunnel({ destination, config: sshConfig, supervise: network === 'isolated', log: message => console.error('[tether] ' + message) });
  let claude: ReturnType<typeof spawn> | undefined;
  let stopSignal: NodeJS.Signals | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (signal: NodeJS.Signals) => {
    // Interactive Ctrl+C already reaches Claude's foreground process group.
    if (signal === 'SIGINT' && claude && process.stdin.isTTY) return;
    stopSignal = signal;
    claude?.kill(signal);
    if (claude && !killTimer) {
      killTimer = setTimeout(() => claude?.kill('SIGKILL'), 2_000);
      killTimer.unref();
    }
    void tunnel.stop();
  };
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, stop);
  let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
  const bridges: Awaited<ReturnType<typeof startBridge>>[] = [];
  let directory: string | undefined;
  try {
    await tunnel.start();
    if (stopSignal) return 128 + constants.signals[stopSignal];
    if (command !== 'run') {
      if (ccproxyPort) {
        const probe = await tunnel.connect('127.0.0.1', Number(ccproxyPort), AbortSignal.timeout(10_000));
        probe.destroy();
      }
      if (command === 'setup') {
        await saveSettings({ ssh: destination, ...(sshConfig ? { sshConfig: resolve(sshConfig) } : {}),
          claude: /[/\\]/.test(executable) ? resolve(executable) : executable,
          network, ...(ccproxyPort ? { ccproxyPort } : {}) });
        console.log(`Saved preferences to ${settingsPath()}.\nReady. Run tether from your project directory.`);
      } else console.log(`Local Claude executable and SSH tunnel are ready (network: ${network}${ccproxyPort ? ', ccproxy TCP reachable; authentication not tested' : ''}). No model request was made.`);
      return 0;
    }
    proxy = await startProxy((host, port, signal) => tunnel.connect(host, port, signal));
    const env = proxyEnvironment(process.env, proxy.url);
    let launch = { executable, args };
    if (network === 'isolated') {
      directory = await mkdtemp(join(tmpdir(), 'tether-network-'));
      const proxySocket = join(directory, 'proxy.sock');
      bridges.push(await startBridge(signal => localSocket(Number(new URL(proxy!.url).port), signal), proxySocket));
      let gatewaySocket: string | undefined;
      if (ccproxyPort) {
        gatewaySocket = join(directory, 'gateway.sock');
        bridges.push(await startBridge(signal => tunnel.connect('127.0.0.1', Number(ccproxyPort), signal), gatewaySocket));
      }
      launch = isolatedCommand(executable, args, proxySocket, gatewaySocket);
    } else if (ccproxyPort) {
      const gateway = await startBridge(signal => tunnel.connect('127.0.0.1', Number(ccproxyPort), signal));
      bridges.push(gateway);
      env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${gateway.port}`;
    }
    if (stopSignal) return 128 + constants.signals[stopSignal];
    console.error(`[tether] Network: ${network}${ccproxyPort ? '; experimental ccproxy via VPS loopback' : ''}.`);
    claude = spawn(launch.executable, launch.args, { stdio: 'inherit', env, shell: false });
    return await new Promise<number>((resolve, reject) => {
      claude!.once('error', error => reject(new Error(`Cannot start local Claude Code (${(error as NodeJS.ErrnoException).code ?? 'spawn error'}). Install the official CLI or use --claude.`)));
      claude!.once('close', (code, signal) => resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)));
    });
  } catch (error) {
    if (stopSignal) return 128 + constants.signals[stopSignal];
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('SSH did not become ready in time. Verify host trust and key/ssh-agent login with ssh, then run setup again.');
    }
    throw error;
  } finally {
    if (killTimer) clearTimeout(killTimer);
    for (const signal of signals) process.off(signal, stop);
    try {
      for (const bridge of bridges) await bridge.close();
      await proxy?.close();
    } finally {
      await tunnel.stop();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error('[tether] ' + (error instanceof Error ? error.message : 'Startup failed'));
    process.exitCode = 1;
  });
}
