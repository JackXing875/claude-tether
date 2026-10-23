# Quick start / 快速开始

This guide runs the **existing remote-agent/local-tool prototype**. The [new product direction](PRODUCT.md) keeps official Claude Code local and uses ccproxy on the VPS, but that integration has no runnable Tether entrypoint yet. `tether connect` below opens the prototype UI, not the official Claude Code UI.

The supported environment is Linux or WSL2, Node 24.14+ within 24.x, npm, and ripgrep. For Ubuntu/WSL, install ripgrep with `sudo apt-get install ripgrep`. Test contributors also need `openssl`. If you already use nvm, `nvm install && nvm use` reads the checked-in version. See [compatibility](COMPATIBILITY.md) for unverified platforms.

Steps 1–3 use the **fake runtime** and issue no model requests. Step 4 enables the verified official Claude / Pro path and consumes subscription allowance. Keep the official Claude login on the VPS.

## 1. Run the disposable demo

```bash
git clone https://github.com/JackXing875/claude-tether.git
cd claude-tether
npm ci
npm run demo
```

Success ends with `演示验收通过`. The demo only modifies its own temporary project and removes it afterward. The sample addition function starts with a deliberate bug.

## 2. Install a standalone command (optional)

From the source checkout:

```bash
npm pack
npm install --global --prefix "$HOME/.local" ./claude-tether-0.1.0-alpha.1.tgz
export PATH="$HOME/.local/bin:$PATH"
tether --version
tether --help
```

`npm pack` builds the package first. Installation needs only production dependencies; no global TypeScript or source checkout is needed afterward. Add the PATH export to your shell profile if desired. Uninstall with `npm uninstall --global --prefix "$HOME/.local" claude-tether`. Private state is intentionally retained; see [RUNBOOK.md](RUNBOOK.md) before deleting it.

There is no npm registry publication yet. Release candidates are tarballs with SHA-256 checksums. The package contains original TypeScript source, built JS and declarations, and the GPL license. It contains no Claude binary or login material.

## 3. Start server and client separately

Use the installed `tether` command. Alternatively, replace it with `node /absolute/path/to/claude-tether/bin/tether.mjs` after `npm run build`.

Terminal A:

```bash
tether device create --id laptop --out "$HOME/.local/state/claude-tether/device.json"
tether server --runtime fake
```

This creates a mode-0600 device file without printing its token. The server listens only on `127.0.0.1:8787`. The default database is `${XDG_STATE_HOME:-$HOME/.local/state}/claude-tether/relay/relay.sqlite`; `--state` overrides it. Device creation/revocation requires the relay to be stopped because its state database has an exclusive process lease.

Terminal B, from the checkout:

```bash
TETHER_DEMO_PROJECT="$(mktemp -d)"
cp examples/minimal-workspace/* "$TETHER_DEMO_PROJECT/"
tether connect \
  --credential "$HOME/.local/state/claude-tether/device.json" \
  --url ws://127.0.0.1:8787/v1/bridge \
  --allow-insecure-loopback \
  --workspace "$TETHER_DEMO_PROJECT"
```

Enter `demo`; approve the edit and the test command separately with `y`. `read calc.mjs` reads the file; `/quit` exits. Ctrl-C cancels an active turn. Clean up the disposable directory after inspection. Do not use `demo` as an arbitrary coding prompt: the fake agent only knows this scripted task and `read <relative-path>`.

Client state is chosen automatically from the relay URL, device, canonical project path and policy, and stored outside the project. Keep those values unchanged to list matching sessions and explicitly choose an ID to resume:

```bash
tether sessions --credential "$HOME/.local/state/claude-tether/device.json" \
  --url ws://127.0.0.1:8787/v1/bridge --allow-insecure-loopback \
  --workspace "$TETHER_DEMO_PROJECT"

tether connect --credential "$HOME/.local/state/claude-tether/device.json" \
  --url ws://127.0.0.1:8787/v1/bridge --allow-insecure-loopback \
  --workspace "$TETHER_DEMO_PROJECT" --resume SESSION_ID
```

The list shows the latest turn state, whether a client is attached, and unresolved operation counts. Add `--json` for metadata only; prompt text, tool arguments and results are excluded. It uses the saved local workspace identity and does not create a session, start a model, execute tools or modify the local journal. If you used `--state` or `--read-only` with `connect`, use those options here too. An unused workspace returns an empty list without creating state. Keep the original state directory; discovery cannot reconstruct a lost workspace identity. Status is a snapshot, and resume still checks ownership and reconciles operations.

For a single unattended read, append `--prompt 'read calc.mjs'`. Without an interactive terminal, all mutations are denied. `--read-only` also denies all commands, including commands described as reads. An UNKNOWN operation requires inspection; restarting or inventing a new operation ID is not a recovery procedure.

## 4. Connect to real Claude on your VPS

Install the same tested tarball and supported Node runtime on both ends. On the VPS, use the dedicated non-root account prepared by `deploy/bootstrap-vps.sh`; complete [official subscription login](AUTH.md) as that account. Run `tether doctor --json` and the explicit two-turn `tether probe --cwd "$HOME/probe/session" --claude "$HOME/.local/bin/claude"` before serving your device.

As the dedicated VPS account, with the relay stopped:

```bash
tether device create --id laptop --state "$HOME/tether/relay.sqlite" \
  --out "$HOME/tether/laptop.json"
tether server --runtime claude --state "$HOME/tether/relay.sqlite" \
  --claude "$HOME/.local/bin/claude"
```

The default listener is `127.0.0.1:8787`; no public port is required. The default turn deadline is 120 seconds (`--turn-timeout-ms` accepts up to 600000). Store runtime state beside the relay database; keep it for explicit session recovery. For persistent operation and boot startup, use the [systemd instructions](RUNBOOK.md#systemd-常驻服务) instead of a foreground server.

Copy **only the newly provisioned device JSON** from the server to a private client path, for example `$HOME/.local/state/claude-tether/laptop.json`, with directory mode 700 and file mode 600. Keep the Claude subscription credential on the VPS. Configure key/agent authentication and verify the host key in your usual OpenSSH config first; the managed transport requires this and does not prompt for passwords.

From any client project directory:

```bash
tether connect --credential "$HOME/.local/state/claude-tether/laptop.json" --ssh YOUR_SSH_ALIAS
```

This command starts and closes its own SSH connection; you do not need a second SSH terminal. Approve each local diff or command with `y`; `/quit` exits and Ctrl-C cancels the active task. Ordinary commands execute with your local account permissions. There is no automatic reconnection or task replay after a lost connection.

If your SSH alias/key is configured in **Windows OpenSSH** and the client runs in WSL, append:

```bash
--ssh-command /mnt/c/Windows/System32/OpenSSH/ssh.exe
```

No private key is copied into WSL. Use `--relay-port` if the remote relay listens on a port other than 8787; the SSH server port/user are taken from your SSH config.

Discover and explicitly resume a session using the same connection options:

```bash
tether sessions --credential "$HOME/.local/state/claude-tether/laptop.json" --ssh YOUR_SSH_ALIAS
tether connect --credential "$HOME/.local/state/claude-tether/laptop.json" \
  --ssh YOUR_SSH_ALIAS --resume SESSION_ID
```

Keep the alias, remote relay port, device, workspace, policy and any explicit `--state` unchanged. State uses the stable SSH destination, never the temporary local TCP port. Changing between `--ssh` and a direct `--url` selects a different default client state; preserve the original connection identity for recovery.

Direct WSS remains available using `--url` and optionally `--ca`. Existing manually managed tunnels still work with `--url ws://127.0.0.1:8787/v1/bridge --allow-insecure-loopback`; these options cannot be combined with `--ssh`.

## Troubleshooting

| Symptom                                        | Action                                                                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unsupported Node version                       | Use `.nvmrc` or a supported Node 24.x version; restart the shell after changing PATH                                                               |
| `rg` is missing                                | Install ripgrep on the client; the VPS does not search project files                                                                               |
| `STATE_IN_USE`                                 | Stop the other process using that database; do not delete its lease file                                                                           |
| `STATE_PERMISSIONS` / `CREDENTIAL_PERMISSIONS` | Use a private state directory (`700`) and regular credential file (`600`)                                                                          |
| `ECONNREFUSED`                                 | Check that the relay and, if applicable, SSH tunnel are running                                                                                    |
| `ECONNRESET` with `--ssh`                      | Check that the server is running and the chosen SSH executable can authenticate with a trusted host key; reconnect the original session explicitly |
| `AUTH_REQUIRED`                                | Complete official subscription login as the VPS service account; client login is unrelated                                                         |
| `RUNTIME_VERSION`                              | Restore the verified official CLI version; validate upgrades before changing the pin                                                               |
| `TLS_REQUIRED`                                 | Use WSS, or explicitly enable a numeric loopback URL for a tunnel/demo                                                                             |
| `WORKSPACE_MISMATCH`                           | Restore the original project/device/state; do not reuse identity files for a different directory                                                   |
| `OUTCOME_UNKNOWN`                              | Inspect local effects and journal evidence before further writes; see the runbook                                                                  |
| `METHOD_NOT_FOUND` from `sessions`             | Upgrade the relay and client together; early prototypes do not implement session discovery                                                         |
| Claude is absent in `doctor`                   | Expected on a client and allowed for the offline demo                                                                                              |

`tether doctor --json` produces an allowlisted diagnostic summary. It never calls the model and does not establish subscription compatibility. Never attach raw state databases or credentials to issues.
