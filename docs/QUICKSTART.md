# Quick start / 快速开始

The supported environment is Linux or WSL2, Node 24.14+ within 24.x, npm, and ripgrep. For Ubuntu/WSL, install ripgrep with `sudo apt-get install ripgrep`. Test contributors also need `openssl`. If you already use nvm, `nvm install && nvm use` reads the checked-in version. See [compatibility](COMPATIBILITY.md) for unverified platforms.

All commands below are for a development alpha with the **fake runtime**. No model requests occur. Keep the official Claude login on the VPS when the real-runtime gate is ready.

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

## 4. Use your VPS over SSH

Install the same package and supported Node runtime on your own server. Run the relay as a dedicated non-root user and keep its state private. Provision the device **on that server**, then copy only its device JSON to a private client path using SCP and set `chmod 600`. Do not copy a Claude subscription token to the client.

Run `tether server --runtime fake` on the server, then open a tunnel on the client:

```bash
ssh -N -L 8787:127.0.0.1:8787 YOUR_SSH_ALIAS
```

Use the same loopback URL as step 3. The relay requires no public listening port. If using direct WSS, configure `--cert` and `--key`, and use `--ca` for your own certificate authority; certificate verification is never disabled. See [RUNBOOK.md](RUNBOOK.md) for lifecycle and troubleshooting.

## Troubleshooting

| Symptom                                        | Action                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Unsupported Node version                       | Use `.nvmrc` or a supported Node 24.x version; restart the shell after changing PATH             |
| `rg` is missing                                | Install ripgrep on the client; the VPS does not search project files                             |
| `STATE_IN_USE`                                 | Stop the other process using that database; do not delete its lease file                         |
| `STATE_PERMISSIONS` / `CREDENTIAL_PERMISSIONS` | Use a private state directory (`700`) and regular credential file (`600`)                        |
| `ECONNREFUSED`                                 | Check that the relay and, if applicable, SSH tunnel are running                                  |
| `TLS_REQUIRED`                                 | Use WSS, or explicitly enable a numeric loopback URL for a tunnel/demo                           |
| `WORKSPACE_MISMATCH`                           | Restore the original project/device/state; do not reuse identity files for a different directory |
| `OUTCOME_UNKNOWN`                              | Inspect local effects and journal evidence before further writes; see the runbook                |
| `METHOD_NOT_FOUND` from `sessions`             | Upgrade the relay and client together; early prototypes do not implement session discovery       |
| Claude is absent in `doctor`                   | Expected on a client and allowed for the offline demo                                            |

`tether doctor --json` produces an allowlisted diagnostic summary. It never calls the model and does not establish subscription compatibility. Never attach raw state databases or credentials to issues.
