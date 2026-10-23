# Claude Tether

**Local Claude Code. Your VPS as the network exit.**

Claude Tether is a lightweight launcher for the official Claude Code CLI. It connects through your VPS over SSH while keeping Claude, your project files, tools, permissions, and sessions on your own machine.

**Beta: `v0.2.0-beta.1`** · [Release notes](docs/releases/v0.2.0-beta.1.md) · [Operations guide](docs/RUNBOOK.md) · [Contributing](CONTRIBUTING.md)

## Quick start

You need:

- **Node.js 24.14 or later in the 24.x line** and npm.
- The [official Claude Code CLI](https://code.claude.com/docs/en/setup), installed locally.
- An OpenSSH client and a VPS you can reach using an SSH key or ssh-agent. The VPS must allow TCP forwarding.

If `claude --version` and key-based `ssh my-vps` already work, no additional server installation is needed. Verify the VPS host fingerprint on your first SSH connection. `my-vps` can be an SSH config alias or `user@host`.

**1. Install the beta**

```bash
npm install --global https://github.com/JackXing875/claude-tether/releases/download/v0.2.0-beta.1/claude-tether-0.2.0-beta.1.tgz
```

The release contains compiled JavaScript and source code. End users do not need TypeScript, Git, a database, or a build step. Beta packages are distributed through GitHub Releases; this command does not rely on an npm registry publication.

**2. Set up once**

```bash
claude-tether setup my-vps
```

Setup checks the local Claude executable and establishes an authenticated SSH tunnel before saving your preferences. It does not store passwords, private keys, or Claude credentials. You can also run `claude-tether setup` and enter the destination when prompted.

**3. Use it from your project**

```bash
cd your-project
claude-tether
```

That is the everyday command. The official Claude interface opens in your current directory. There are no proxy URLs, ports, or environment variables to configure manually.

## Common commands

| Command | Purpose |
| --- | --- |
| `claude-tether` | Start local Claude using the saved VPS |
| `claude-tether setup user@host` | Validate and save a new default destination |
| `claude-tether doctor` | Check the local executable and SSH tunnel without a model request |
| `claude-tether -- --continue` | Continue using Claude's own session handling |
| `claude-tether -- --resume SESSION_ID` | Resume a specific Claude session |
| `claude-tether -- auth login` | Run the official local login flow through the tunnel |
| `claude-tether --ssh another-vps` | Override the destination for one invocation |
| `claude-tether --help` | Show all options |

Arguments after `--` are passed to Claude unchanged. Claude's terminal interface, working directory, permissions, project configuration, and exit status are preserved.

For a custom SSH config or Claude executable:

```bash
claude-tether setup my-vps --ssh-config ~/.ssh/tether-config --claude /path/to/claude
```

Preferences are saved in `~/.config/claude-tether/config.json`, or under `$XDG_CONFIG_HOME` when set. Normal use does not require editing this file. SSH ports, identities, and other SSH options remain in standard OpenSSH configuration.

## How it works

```text
Your machine                                      Your VPS

Official Claude Code → loopback CONNECT proxy → SSH → sshd → Anthropic
  projects, tools,        stream forwarding          TCP exit
  login, sessions
```

Tether uses Node's built-in modules and OpenSSH. It has **zero npm runtime dependencies**. The VPS only needs sshd; it does not run Claude Code, a custom application service, a project checkout, or a database.

TLS remains between the local client and the destination. Tether and the VPS do not terminate TLS or parse model messages. The VPS resolves destination names and opens outbound TCP connections. SSH host verification and normal TLS certificate verification remain enabled.

## Connection behavior

- SSH keepalives detect an unresponsive connection. Reconnection uses exponential backoff with jitter, capped at 30 seconds.
- The local proxy address stays the same during a run. An SSH reconnect does not restart the Claude process.
- New connections wait up to 30 seconds for a tunnel. Established streams have no artificial idle deadline and use streaming backpressure.
- Requests are never buffered for replay. An interrupted TCP/TLS stream cannot be resumed by the proxy; Claude decides whether to retry, and its session tools remain available.
- Tether does not fall back to a direct connection when the tunnel fails.

This improves connection management without promising uninterrupted responses or lossless recovery from every outage.

## Authentication and network scope

Authentication remains with the official local Claude CLI. Tether does not export tokens, change the API base URL, or select a different billing method. Existing API key, provider, or managed settings still apply; use Claude's own account information to confirm the active authentication method.

Proxy variables are set only for Claude and its descendants. Tools that honor those variables may also send HTTPS traffic through the VPS. Localhost traffic bypasses the proxy; browsers, UDP, and programs that ignore proxy variables are outside its scope. The proxy supports HTTPS CONNECT only; ordinary HTTP requests receive `405`.

The browser opened during login does not automatically inherit the CLI's proxy. The [operations guide](docs/RUNBOOK.md) covers first-time SSH access, login, and troubleshooting.

## Beta status

Linux is the validated platform. WSL uses the same Linux workflow, but Windows native and macOS have not been tested. Tests exercise real local OpenSSH and TLS services, including reconnection and streaming failures. **Live Claude account requests, deployment to a user's VPS, and long-duration network behavior have not yet been validated.** See the [test report](docs/TEST-REPORT.md).

This is an independent project, not an Anthropic product or an officially endorsed integration.

## Development

```bash
git clone https://github.com/JackXing875/claude-tether.git
cd claude-tether
npm ci
npm test
npm run test:package
```

Development tests require OpenSSH client/server binaries and OpenSSL. They create isolated local fixtures and do not use your Claude account or personal SSH settings. See [CONTRIBUTING.md](CONTRIBUTING.md) for prerequisites and the release process.

## License

Claude Tether is licensed under **GPL-3.0-only**. See [LICENSE](LICENSE). This license covers Claude Tether; it does not include or replace the terms for Claude Code or OpenSSH.
