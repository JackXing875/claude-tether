# Network modes

Version 0.3 defaults to `--network isolated`. Existing settings files without a `network` field also select isolation. It requires Linux/WSL2, bubblewrap 0.9+ and permission to create user namespaces. `doctor` checks this before starting Claude. Failure stops startup; there is no automatic fallback.

```bash
sudo apt-get install bubblewrap
claude-tether setup my-vps
claude-tether doctor
claude-tether
```

On systems restricting user namespaces, ask the system administrator to allow the installed `/usr/bin/bwrap` through the distribution's AppArmor policy. Do not run the launcher as root or disable the machine's security policy globally. `--network proxy` is an explicit alternative with a weaker routing guarantee.

## What goes through the VPS

| Traffic | Default isolated mode | Explicit proxy mode |
| --- | --- | --- |
| Claude HTTP(S) using the supplied proxy | SSH → VPS | SSH → VPS |
| Tool HTTP(S) honoring proxy variables | SSH → VPS | SSH → VPS |
| Settings override proxy / `NO_PROXY=*` | Direct external IP connections fail | Direct connections may succeed |
| DNS for proxy destinations | Resolved by VPS | Resolved by VPS |
| Raw sockets, direct DNS, UDP | No external route; blocked | Outside Tether's control |
| Local services started inside Claude's namespace | Reachable on its loopback | Reachable on host loopback |
| Services already running on host loopback | Not reachable by IP | Reachable |
| Other host applications and browsers | Unchanged | Unchanged |

The namespace has only loopback, no external interface or default route. A private Unix socket carries proxy bytes to the host-side SSH transport. Both uppercase and lowercase proxy variables are initially set; overriding them can break access but cannot add a route. An SSH outage closes existing streams; new requests wait for reconnection. Tether does not replay requests or restart the agent task.

This provides an IP egress restriction for Claude and ordinary Linux descendants. It **does not transparently route every protocol**. Whole-machine TCP/UDP routing would need a separately operated VPN such as WireGuard, with IPv4/IPv6 routes, DNS and a firewall that blocks traffic when the tunnel is down. That mode is not implemented by this release. See the [WireGuard namespace design](https://www.wireguard.com/netns/).

## Compatibility

- Files, working directory, terminal input and native Claude arguments remain available. Read/Edit/Bash, stdio MCP, hooks, resume and `/model` were tested with official Claude Code 2.1.267.
- Tools connecting to a database, development server, HTTP MCP service or SSH agent already running on the host need a different arrangement. Start required local services inside the same Claude session, use stdio MCP, or deliberately select compatibility mode. Host loopback is not exposed automatically.
- Windows interop is disabled inside the WSL namespace. A tool cannot use `powershell.exe`, `cmd.exe` or a Windows browser as a normal route around this restriction. `/run` is private and `SSH_AUTH_SOCK` is removed from Claude; host-side OpenSSH can still use the caller's agent.
- Browser login is outside the namespace. Use the official manual URL/code flow when offered. If the CLI requires a callback to host loopback, complete the official login using `claude-tether --network proxy -- auth login`, then return to isolated mode for daily use. That one login uses the weaker mode explicitly; it does not change saved preferences.
- Nested user namespaces are disabled. Tools requiring their own namespace sandbox/container may fail. This release does not enable an automatic unconfined fallback.
- Background tools launched by Claude stop when the isolated session exits, even if detached. SIGTERM closes the launcher normally. PID namespaces and parent-death supervision also stop its Claude and SSH descendants after launcher SIGKILL. A private temporary socket directory can remain after SIGKILL; it cannot continue forwarding without the parent process.
- macOS and Windows native do not support this implementation. `--network proxy` remains available but unverified there.

## Trust boundary and identity

This is a network namespace, **not a sandbox for hostile local code**. The project filesystem remains writable. Programs can still communicate with accessible filesystem Unix sockets or a cooperating host process; root, other host services and another process of the same user are outside the boundary. Do not use it to execute untrusted malware or as multi-user tenant isolation. Bubblewrap's security depends on how it is configured; see the [upstream explanation](https://github.com/containers/bubblewrap#sandbox-security).

The VPS changes the network exit. It does not remove account identity, project content, OS details, telemetry fields or other information that the official client sends in encrypted requests. Tether does not rewrite client identity, forge headers, disable TLS verification or claim protection from account restrictions.

For optional diagnostic traffic controls, use the official client's [documented data settings](https://code.claude.com/docs/en/data-usage), such as `DISABLE_TELEMETRY=1` and `DISABLE_ERROR_REPORTING=1`. These reduce specific diagnostics; they are not identity masking. The [official network documentation](https://code.claude.com/docs/en/network-config) describes supported proxy variables.
