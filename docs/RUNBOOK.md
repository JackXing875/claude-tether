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
claude-tether setup my-vps
cd your-project
claude-tether
```

Setup checks the local Claude executable and the SSH/SOCKS listener. It saves preferences only after those checks pass, using an atomic replacement and a private file mode. It does not make a model request or prove that the VPS can reach every upstream destination. Existing working preferences survive a failed setup.

To change the default, run setup again. To override it temporarily, use `--ssh`, `--ssh-config`, or `--claude` on a normal launch. A temporary override does not modify saved preferences.

```bash
claude-tether setup my-vps --ssh-config ~/.ssh/tether-config
claude-tether --ssh another-vps
claude-tether doctor
```

Preferences live at `$XDG_CONFIG_HOME/claude-tether/config.json`, falling back to `~/.config/claude-tether/config.json`. Saved file paths are absolute, so launching from another project does not change their meaning. Delete that file to remove Tether's preferences; Claude and SSH credentials are stored elsewhere and are unaffected.

Run Tether from the project you want Claude to work on. `npm --prefix ...` changes the working directory and should not be used as a substitute for the installed launcher.

## Official Claude login and sessions

```bash
claude-tether -- auth login
claude-tether -- auth status
claude-tether -- --continue
claude-tether -- --resume SESSION_ID
```

The official local CLI manages authentication and refresh. Tether does not export credentials or clear existing API key/provider settings. Confirm your account and authentication method in Claude itself.

A browser opened for authorization does not inherit the CLI's proxy environment. If the authorization page cannot load, use the browser's supported network configuration. Do not paste authorization codes or tokens into issue reports or Tether settings.

An earlier VPS-based prototype may have left software on the server. That installation is not used by this version; removal is a separate administrative action. Local Claude authentication is independent of any login saved on the VPS.

## Connection recovery

SSH sends keepalives every 15 seconds and exits after three unanswered probes. Tether reconnects with jittered exponential backoff, starting around 0.5 seconds and capped at 30 seconds. A connection that stays ready for 30 seconds resets the backoff.

The local proxy and Claude process remain in place during reconnection. A new CONNECT has a 30-second establishment deadline. An established stream has no Tether idle deadline; a pause in model output does not trigger an application timeout.

Existing connections close when their SSH transport is lost. Tether does not resend model requests, tool calls, or complete tasks. Follow Claude's error/retry behavior and inspect any local changes before explicitly repeating an operation.

Normal terminal Ctrl+C remains available to Claude. Exiting Claude closes Tether's proxy and SSH child. Use SIGTERM when stopping the complete launcher as a background process.

## Network scope

Tether sets upper- and lower-case HTTP/HTTPS proxy variables only in Claude's process environment. Claude's child tools inherit them. `NO_PROXY` is limited to localhost, 127.0.0.1 and ::1; an inherited `NO_PROXY=*` cannot silently bypass the tunnel.

The proxy accepts HTTPS CONNECT only. Ordinary HTTP receives `405`; UDP, browsers and tools that ignore proxy variables are not routed. This is not a system-wide VPN. Destination DNS for tunneled connections is resolved through the VPS. TLS stays between the local client and its destination.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Local Claude is unavailable | Install the official CLI, check `claude --version`, or specify `--claude` |
| Unknown host or permission denied | Verify the same destination with ordinary SSH, including the same `-F` configuration when used |
| Setup never becomes ready | Check keys/ssh-agent, known_hosts, the SSH port and network reachability; startup stops after 30 seconds |
| SSH disconnected | Allow the reconnect loop to recover; the local Claude process stays alive |
| Proxy `502` | A tunnel or destination connection could not be established; inspect SSH and VPS outbound access |
| Proxy `405` | The application attempted ordinary HTTP, which this beta does not support |
| Model output is interrupted | Use Claude's own retry/session recovery; Tether cannot resume a broken TCP stream |
| Invalid settings | Inspect the named local preferences file; it accepts only `ssh`, `sshConfig` and `claude` strings |

Tether logs connection state and OpenSSH's diagnostics. It does not log model request bodies or credentials. Redact hostnames, usernames and local paths before sharing diagnostic output.

## Upgrade and uninstall

Install the tarball from a newer GitHub prerelease using the same global npm command shown in its release notes. Saved preferences remain outside the package.

```bash
npm uninstall --global claude-tether
```

Uninstalling removes the launcher. Remove the preferences file separately if desired; do not delete Claude or SSH state to troubleshoot Tether.
