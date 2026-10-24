# Operations guide

## First-time SSH access

If you already use an SSH key or ssh-agent to connect to your VPS, reuse that access. Confirm the server's host fingerprint with your hosting provider and make an initial interactive connection before running Tether:

```bash
ssh user@your-vps
```

An SSH alias is optional. For a non-default port or key, a standard SSH config entry keeps the launcher command short:

```sshconfig
Host my-vps
    HostName your-vps.example
    User your-user
    Port 22
    IdentityFile ~/.ssh/your_key
    IdentitiesOnly yes
```

Password-only SSH is not supported for automatic reconnects. Configure a key using your hosting provider's instructions or load your existing passphrase-protected key into ssh-agent. Tether uses `BatchMode=yes` and `StrictHostKeyChecking=yes`; it does not collect passwords or automatically accept unknown host keys.

The VPS must allow TCP forwarding. If a connection reports `administratively prohibited`, check sshd's `AllowTcpForwarding`, `DisableForwarding`, `PermitOpen`, and authorized_keys restrictions. Keep an existing administrative session open while validating and reloading any server configuration changes.

No additional public port, TLS certificate, VPS Node runtime, Claude installation, or project checkout is required.

## Setup and everyday use

```bash
tether setup my-vps
cd your-project
tether
```

Setup checks bubblewrap/user namespace support, the local Claude executable inside isolation, and the SSH/SOCKS listener. It saves preferences only after those checks pass, using an atomic replacement and a private file mode. It does not make a model request or prove that the VPS can reach every upstream destination. Existing working preferences survive a failed setup.

To change the default, run setup again. To override it temporarily, use `--ssh`, `--ssh-config`, `--claude`, `--network`, `--ccproxy-port` or `--no-ccproxy` on a normal launch. A temporary override does not modify saved preferences.

```bash
tether setup my-vps --ssh-config ~/.ssh/tether-config
tether --ssh another-vps
tether doctor
```

Preferences live at `$XDG_CONFIG_HOME/claude-tether/config.json`, falling back to `~/.config/claude-tether/config.json`. Saved file paths are absolute, so launching from another project does not change their meaning. Delete that file to remove Tether's preferences; Claude and SSH credentials are stored elsewhere and are unaffected.

Run Tether from the project you want Claude to work on. `npm --prefix ...` changes the working directory and should not be used as a substitute for the installed launcher.

## Official Claude login and sessions

```bash
tether -- auth login
tether -- auth status
tether -- --continue
tether -- --resume SESSION_ID
```

The official local CLI manages authentication and refresh. Tether does not export credentials or clear existing API key/provider settings. Confirm your account and authentication method in Claude itself.

A browser opened for authorization does not inherit the CLI's proxy environment. Default isolation disables Windows interop and separates host loopback. Use the official manual URL/code login flow if offered; if a browser callback requires host loopback, explicitly use `tether --network proxy -- auth login` for that login and then return to isolated mode. If the authorization page cannot load, use the browser's supported network configuration. Do not paste authorization codes or tokens into issue reports or Tether settings.

An earlier VPS-based prototype may have left software on the server. That installation is not used by this version; removal is a separate administrative action. Local Claude authentication is independent of any login saved on the VPS.

### Separating a personal Pro login

In the 2.1.267 live test, `CLAUDE_CONFIG_DIR` alone still inherited an authentication profile under `~/.config/anthropic`. Isolate `XDG_CONFIG_HOME` as well when you need to verify a separate login. This also changes where Tether looks for preferences, so pass the SSH destination explicitly or run setup again in that environment. Keep the same environment for login and daily use.

```bash
claude-pro() (
  unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL
  unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_API_KEY
  unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY
  export CLAUDE_CONFIG_DIR="$HOME/.config/claude-tether/pro/claude"
  export XDG_CONFIG_HOME="$HOME/.config/claude-tether/pro/xdg"
  tether --ssh my-vps -- "$@"
)
claude-pro auth login --claudeai
claude-pro auth status
```

Confirm `claude.ai` and the expected subscription in the official status output. Project and managed settings still apply. Do not move credentials from the VPS or overwrite an existing Claude profile to troubleshoot login.

For WSL, the Linux `ssh` executable needs its own usable configuration and host trust. A Windows SSH alias is not automatically available in WSL. Passing `--ssh-config` selects a Linux-readable configuration; it does not change the SSH executable. Windows `ssh.exe -D` also listens in Windows' network namespace, which was not reachable through WSL loopback in the tested NAT configuration. The live validation used native Linux OpenSSH and a dedicated forwarding key.

## Connection recovery

SSH sends keepalives every 15 seconds and exits after three unanswered probes. Tether reconnects with jittered exponential backoff, starting around 0.5 seconds and capped at 30 seconds. A connection that stays ready for 30 seconds resets the backoff.

The local proxy and Claude process remain in place during reconnection. A new CONNECT has a 30-second establishment deadline. An established stream has no Tether idle deadline; a pause in model output does not trigger an application timeout.

Existing connections close when their SSH transport is lost. Tether does not resend model requests, tool calls, or complete tasks. Follow Claude's error/retry behavior and inspect any local changes before explicitly repeating an operation.

Normal terminal Ctrl+C remains available to Claude. Exiting Claude closes Tether's proxy and SSH child. Use SIGTERM when stopping the complete launcher as a background process.

## Network scope

Default `--network isolated` runs Claude and Linux child tools with loopback as their only network interface. Proxy-aware HTTP and HTTPS use private Unix bridges and SSH. Settings that override proxy variables can cause connection failures but cannot restore direct external IP connectivity. Raw sockets, direct DNS and UDP are blocked. This is not a system-wide VPN or a hostile-code sandbox.

For programs requiring host loopback, Windows interop or unsupported protocols, see [network modes and compatibility](NETWORK.md). Explicit `--network proxy` retains the older environment-only mode, where project settings can bypass the proxy. No automatic fallback occurs.

The optional `--ccproxy-port` connects a gateway on VPS loopback over SSH; read its [experimental limitations](CCPROXY.md) before use. It is disabled unless selected and is not required for `/model` or local tools.

## Troubleshooting

For the official VS Code native panel, use the dedicated [`tether-vscode` adapter](VSCODE.md) in the Linux/WSL extension host. An ordinary terminal alias is not a compatible process wrapper.

| Symptom | Action |
| --- | --- |
| Local Claude is unavailable | Install the official CLI, check `claude --version`, or specify `--claude` |
| Unknown host or permission denied | Verify the same destination with ordinary SSH, including the same `-F` configuration when used |
| Setup never becomes ready | Check keys/ssh-agent, known_hosts, the SSH port and network reachability; startup stops after 30 seconds |
| SSH disconnected | Allow the reconnect loop to recover; the local Claude process stays alive |
| Proxy `502` | A tunnel or destination connection could not be established; inspect SSH and VPS outbound access |
| Network isolation unavailable | Install bubblewrap 0.9+ and check the distribution user-namespace policy; see NETWORK.md |
| A tool reports network unreachable or cannot reach host localhost | Check isolated-mode compatibility; do not assume a VPS outage |
| GPU works in an ordinary terminal but is hidden in Tether | Upgrade to 0.3.0-beta.3 or later, start a new session and use the same Python environment; see NETWORK.md |
| ccproxy connection refused/prohibited | Check the gateway loopback listener and SSH key forwarding restrictions |
| Model output is interrupted | Use Claude's own retry/session recovery; Tether cannot resume a broken TCP stream |
| Invalid settings | Inspect the named local preferences file; it accepts `ssh`, `sshConfig`, `claude`, `network` (isolated/proxy) and `ccproxyPort` strings |

Tether logs connection state and OpenSSH's diagnostics. It does not log model request bodies or credentials. Redact hostnames, usernames and local paths before sharing diagnostic output.

## Upgrade and uninstall

Starting with `0.3.0-beta.4`:

```bash
tether update          # fetch, verify and install the newest release
tether update --check  # report availability without changing files
tether --version
```

The updater selects the highest published stable/beta version, including newer betas when the installed version is a beta. A stable installation only receives stable releases. Drafts, unsupported tag formats and downgrades are excluded. Already-current installations do not download or reinstall the package. No Git checkout, GitHub token, Claude login or reachable VPS is needed.

The tarball and `SHA256SUMS` come from this repository's GitHub Releases over verified HTTPS. SHA-256 is checked before npm runs; the GitHub asset digest is also checked when present. npm stages the verified local tarball offline with lifecycle scripts disabled and engine requirements enforced. Version, package layout and executable checks must pass before replacing the invoked installation. Download, integrity and staging failures leave the old installation intact; a failed activation rename restores the previous package. The updater retains a backup and prints its location.

The package path and existing npm executable links stay the same, including `tether-vscode`. Saved preferences, SSH keys, Claude profiles and VS Code settings are outside the package and are not modified. Running sessions are not restarted: open a new CLI/panel session to use the new version. This updates **Tether only**, not the official Claude binary, Node.js, the VS Code extension or a remote machine.

Self-update supports writable global npm prefixes on Linux/WSL and macOS; macOS transport compatibility remains unverified. It uses the running package's location rather than npm's default prefix, so it also works with `npm install --global --prefix /your/path`. Source checkouts, linked packages and Windows-native layouts are not overwritten. Tether does not request sudo. If the directory is not writable, install into a user-owned prefix using the release's npm command. A Node.js engine mismatch requires updating Node before retrying.

Update downloads run on the **host network**, separately from Claude's SSH tunnel, and honor the host's `HTTPS_PROXY`/`https_proxy` and `NO_PROXY` settings. A configured proxy failure does not fall back to direct access. GitHub API rate limits or download errors stop the update; retry later. These public requests contain no Claude credentials.

Concurrent updates to one installation are locked. If a process was killed abruptly, the error identifies the lock file; remove it only after verifying no updater is still running. Normal cancellation removes the lock and staging directory. Activation uses two filesystem renames with rollback on errors, not a crash-proof filesystem transaction: after a machine crash during activation, restore the retained `claude-tether` backup directory to its original `lib/node_modules/claude-tether` path, or reinstall the release tarball. Backups are not automatically deleted; after closing old sessions and verifying the upgrade, remove obsolete backup directories if desired.

For beta.3 or earlier, install beta.4 or later once using the npm command in its release notes. If a personal shell wrapper puts every argument after `--`, route `update` to Tether **before** that separator; otherwise it becomes a Claude argument. Use stable package paths in custom CLI and VS Code wrappers. An `update` intended for Claude can still be passed explicitly as `tether -- update`.

Version 0.3.0-beta.2 added the short `tether` command while retaining `claude-tether` as an alias. If an old alpha installation still owns a `tether` command, upgrade that npm installation or back up its launcher before replacing it. Verify `command -v tether` after upgrading. Upgrading from 0.2 selects isolated mode unless `network: "proxy"` was explicitly saved; install bubblewrap first.

To uninstall, use the same npm prefix used for installation:

```bash
npm uninstall --global claude-tether
```

Uninstalling removes the launcher. Remove the preferences file separately if desired; do not delete Claude or SSH state to troubleshoot Tether.
