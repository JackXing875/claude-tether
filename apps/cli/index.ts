import { readFileSync } from 'node:fs';
import { BridgeError, failure } from '../../packages/protocol/index.js';
import { terminalText } from '../../packages/diagnostics/index.js';

const help: Record<string, string> = {
  root: `Claude Tether — remote Claude runtime, locally authorized tools

Usage: tether <command> [options]

  demo       Run a complete offline demo in a disposable workspace
  connect    Attach a local workspace to a relay
  sessions   List sessions for the current device, workspace and policy
  server     Start a relay (requires an explicit runtime)
  device     Create or revoke a device credential while the relay is stopped
  doctor     Inspect Node, ripgrep and optional Claude installation (no model calls)
  probe      Run the official Claude compatibility probe after subscription login

Use tether <command> --help for options. Linux and WSL2; Node.js 24.14+ (24.x).
Development alpha. The offline demo does not require a Claude subscription.`,
  demo: 'Usage: tether demo\nCreates, tests and removes its own temporary project. No model requests.',
  connect: `Usage: tether connect --credential <device.json> --url <wss://host/v1/bridge> [options]
  --workspace <path>          Local project (default: current directory)
  --state <directory>         Private state outside the project (default: automatic)
  --resume <session-id>       Explicitly resume using the same device, project and policy
  --read-only                Forbid file changes and all command execution
  --ca <certificate>         Trust a private TLS certificate
  --allow-insecure-loopback  Allow ws://127.0.0.1 for an SSH tunnel or local demo
  --prompt <text>            Submit one turn, then exit; non-TTY mutations are denied
Interactive commands: /quit and /help. Ctrl-C cancels the active turn.`,
  sessions: `Usage: tether sessions --credential <device.json> --url <bridge-url> [options]
  --workspace <path>          Local project (default: current directory)
  --state <directory>         Same private client state used by connect (default: automatic)
  --read-only                Select sessions created with the read-only policy
  --ca <certificate>         Trust a private TLS certificate
  --allow-insecure-loopback  Allow a numeric loopback URL for a local demo/SSH tunnel
  --json                     Emit bounded session metadata as JSON
Lists only the exact saved workspace binding. No session creation, model calls or local tools.
Keep the original state directory; choose an ID explicitly with connect --resume <session-id>.`,
  server: `Usage: tether server --runtime fake [options]
  --state <database>   Default: $XDG_STATE_HOME/claude-tether/relay/relay.sqlite
  --host <address>     Default: 127.0.0.1; non-loopback requires TLS
  --port <number>      Default: 8787 (0 selects a free port)
  --cert <file> --key <file>   TLS certificate and private key
The fake runtime makes no Claude requests. See docs/ROADMAP.md for the real-runtime gate.`,
  device: `Usage: tether device create --out <device.json> [--id <name>] [--state <database>]
       tether device revoke --id <name> [--state <database>]
Stop the relay first. Credentials are written once with mode 0600, never printed.
The database defaults to the same private state path as tether server.`,
  doctor:
    'Usage: tether doctor [--json]\nRead-only dependency and authentication summary. Never issues a model request.',
  probe: `Usage: tether probe --cwd <private-infrastructure-directory> [--claude <executable>]
Runs two real Claude turns and consumes your subscription allowance.
Run on the VPS as its dedicated non-root user, after official claude auth login.
This checks compatibility; it does not expose the workspace or start a relay.`,
};

export async function main(args: string[]): Promise<void> {
  try {
    const [command, ...rest] = args;
    if (command === '--version' || command === '-v') {
      const pkg = JSON.parse(
        readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
      ) as { version: string };
      console.log(pkg.version);
      return;
    }
    if (!command || ['--help', '-h', 'help'].includes(command)) {
      console.log(help.root);
      return;
    }
    if (!Object.hasOwn(help, command) || command === 'root') {
      throw new BridgeError('USAGE', 'Unknown command. Run tether --help.');
    }
    if (rest.includes('--help') || rest.includes('-h')) {
      console.log(help[command]);
      return;
    }
    if (process.platform !== 'linux')
      throw new BridgeError(
        'UNSUPPORTED_PLATFORM',
        'Use Linux or WSL2. Native Windows and macOS have not been validated.',
      );
    switch (command) {
      case 'demo': {
        if (rest.length) throw new BridgeError('USAGE', help.demo!);
        await (await import('../bridge-cli/demo.js')).runDemo();
        break;
      }
      case 'connect':
        await (await import('../bridge-cli/main.js')).runClient(rest);
        break;
      case 'sessions':
        await (await import('./sessions.js')).runSessions(rest);
        break;
      case 'server':
        await (await import('../relay-server/main.js')).runServer(rest);
        break;
      case 'device':
        await (await import('./device.js')).runDevice(rest);
        break;
      case 'doctor':
        await (await import('../bridge-cli/doctor.js')).runDoctor(rest);
        break;
      case 'probe':
        await (await import('../bridge-cli/probe.js')).runProbe(rest);
        break;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const hints: Record<string, string> = {
      ENOENT: 'A required file or executable was not found. Check paths and run tether doctor.',
      EEXIST:
        'The destination already exists. Choose a new path; credentials are never overwritten.',
      EACCES: 'Access denied. Check file ownership and permissions.',
      ECONNREFUSED: 'Relay connection refused. Check the server and SSH tunnel.',
      ERR_PARSE_ARGS_UNKNOWN_OPTION: 'Unknown option. Run tether <command> --help.',
      ERR_PARSE_ARGS_INVALID_OPTION_VALUE:
        'Missing or invalid option value. Run tether <command> --help.',
      ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL:
        'Unexpected positional argument. Run tether <command> --help.',
    };
    const detail = code && hints[code] ? { code, message: hints[code] } : failure(error);
    console.error(terminalText(detail.code + ': ' + detail.message));
    process.exitCode = 1;
  }
}
