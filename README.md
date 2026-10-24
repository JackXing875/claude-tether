# Tether

**Local Claude Code. Your VPS as the network exit.**

Tether is a lightweight launcher for the official Claude Code CLI. It connects through your VPS over SSH while keeping Claude, your project files, tools, permissions, and sessions on your own machine.

The official **VS Code native panel** can use the same transport through `tether-vscode`; see the [extension setup](docs/VSCODE.md). Linux/WSL GPU compute remains available inside network isolation.

**Beta: `v0.3.0-beta.3`** · [Release notes](docs/releases/v0.3.0-beta.3.md) · [Operations guide](docs/RUNBOOK.md) · [Contributing](CONTRIBUTING.md)

## Quick start

You need:

- **Linux/WSL2 with bubblewrap 0.9+** and working unprivileged user namespaces (`sudo apt-get install bubblewrap` on Ubuntu).
- **Node.js 24.14 or later in the 24.x line** and npm.
- The [official Claude Code CLI](https://code.claude.com/docs/en/setup), installed locally.
- An OpenSSH client and a VPS you can reach using an SSH key or ssh-agent. The VPS must allow TCP forwarding.

If `claude --version` and key-based `ssh my-vps` already work, no additional server installation is needed. Verify the VPS host fingerprint on your first SSH connection. `my-vps` can be an SSH config alias or `user@host`.

**1. Install the beta**

```bash
npm install --global https://github.com/JackXing875/claude-tether/releases/download/v0.3.0-beta.3/claude-tether-0.3.0-beta.3.tgz
```

The release contains compiled JavaScript and source code. End users do not need TypeScript, Git, a database, or a build step. Beta packages are distributed through GitHub Releases; this command does not rely on an npm registry publication.

**2. Set up once**

```bash
tether setup my-vps
```

Setup checks network isolation and the local Claude executable, then establishes an authenticated SSH tunnel before saving your preferences. It does not store passwords, private keys, or Claude credentials. You can also run `tether setup` and enter the destination when prompted.

**3. Use it from your project**

```bash
cd your-project
tether
```

The display name and primary command are now **Tether** / `tether`. The package and GitHub repository remain named `claude-tether`; the old `claude-tether` command is retained as a compatibility alias. Existing saved preferences keep working.

That is the everyday command. The official Claude interface opens in your current directory. There are no proxy URLs, ports, or environment variables to configure manually.

## Common commands

| Command | Purpose |
| --- | --- |
| `tether` | Start local Claude using the saved VPS |
| `tether setup user@host` | Validate and save a new default destination |
| `tether doctor` | Check the local executable and SSH tunnel without a model request |
| `tether -- --continue` | Continue using Claude's own session handling |
| `tether -- --resume SESSION_ID` | Resume a specific Claude session |
| `tether -- auth login` | Run the official local login flow through the tunnel |
| `tether --ssh another-vps` | Override the destination for one invocation |
| `tether --network proxy` | Explicit compatibility mode; settings may bypass the proxy |
| `tether --ccproxy-port 4000` | Experimental SSH access to a VPS-local ccproxy gateway |
| `tether --no-ccproxy` | Disable a saved experimental gateway |
| `tether --help` | Show all options |

Arguments after `--` are passed to Claude unchanged. Claude's terminal interface, working directory, permissions, project configuration, and exit status are preserved.

For a custom SSH config or Claude executable:

```bash
tether setup my-vps --ssh-config ~/.ssh/tether-config --claude /path/to/claude
```

Preferences are saved in `~/.config/claude-tether/config.json`, or under `$XDG_CONFIG_HOME` when set. Normal use does not require editing this file. SSH ports, identities, and other SSH options remain in standard OpenSSH configuration.

## How it works

```text
Linux/WSL network namespace (loopback only)       Host               VPS
Official Claude + tools → local proxy → private Unix bridge → SSH → sshd → destination
  project files, login, sessions stay local
```

The default `isolated` mode gives Claude and its Linux descendants a network namespace with no external IP route. A private Unix socket connects its HTTP(S) proxy to the host's SSH tunnel. Overriding proxy settings cannot restore direct IP access. Exiting the launcher also stops its isolated descendants, including detached tools and SSH.

Tether has **zero npm runtime dependencies**. Isolation uses the system `bwrap` executable; the default VPS path still needs only sshd. No root daemon, global firewall change or TLS interception is required.

For HTTPS through the default SSH transport, TLS remains between the local client and the destination. Destination DNS is resolved on the VPS. Ordinary HTTP is also supported, with its normal lack of end-to-end encryption. The optional ccproxy path terminates API requests at the gateway; see its separate [experimental status](docs/CCPROXY.md).

## Connection behavior

- SSH keepalives detect an unresponsive connection. Reconnection uses exponential backoff with jitter, capped at 30 seconds.
- The local proxy address stays the same during a run. An SSH reconnect does not restart the Claude process.
- New connections wait up to 30 seconds for a tunnel. Established streams have no artificial idle deadline and use streaming backpressure.
- Requests are never buffered for replay. An interrupted TCP/TLS stream cannot be resumed by the proxy; Claude decides whether to retry, and its session tools remain available.
- Tether does not fall back to a direct connection when the tunnel fails.

This improves connection management without promising uninterrupted responses or lossless recovery from every outage.

## Authentication and network scope

Authentication remains with the official local Claude CLI. Tether does not export tokens or select a billing method. Existing API key, provider and managed settings still apply; check the active account in Claude. Only explicitly enabling `--ccproxy-port` changes `ANTHROPIC_BASE_URL` to an SSH-backed local gateway.

Default isolation routes proxy-aware HTTP(S) traffic through the VPS and **blocks other external IP traffic**. This is not transparent forwarding of every protocol: UDP, direct sockets and proxy-unaware tools cannot reach the Internet. Tools using host loopback services, Windows interop, a host SSH agent, or browser callbacks may need configuration changes. Existing host browsers and other applications remain outside the namespace. See [network modes and compatibility](docs/NETWORK.md).

`--network proxy` explicitly restores the old environment-only mode. It works without bubblewrap, but settings can override its routing. Tether never silently falls back to that mode. On macOS/Windows native, only this unverified compatibility mode is available.

The [operations guide](docs/RUNBOOK.md) covers SSH setup, separate Pro profiles, login and troubleshooting.

## Beta status

Linux/WSL2 isolation has passed real Pro calls with local tools, MCP/hooks, Sonnet-to-Opus session resume and native `/model`; see the [new validation report](docs/ISOLATED-LIVE-REPORT.md) and [automated coverage](docs/TEST-REPORT.md). Longer use and active model generation during outages remain unverified.

An optional ccproxy connector preserves HTTP bytes through SSH. Upstream compatibility was tested with synthetic credentials; **real Pro use through ccproxy is not validated or enabled by default**. Its current logging and TLS defaults need further work before routine use. No identity spoofing is included. Network isolation and fingerprint changes cannot establish immunity from account restrictions.

This is an independent project, not an Anthropic product or an officially endorsed integration.

## Development

```bash
git clone https://github.com/JackXing875/claude-tether.git
cd claude-tether
npm ci
npm test
npm run test:package
```

Development tests require OpenSSH client/server binaries, OpenSSL and bubblewrap with user namespaces enabled. They create isolated local fixtures and do not use your Claude account or personal SSH settings. See [CONTRIBUTING.md](CONTRIBUTING.md) for prerequisites and the release process.

## License

Tether is licensed under **GPL-3.0-only**. See [LICENSE](LICENSE). This license covers Tether; it does not include or replace the terms for Claude Code or OpenSSH.
