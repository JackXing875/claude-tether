# Network modes

Version 0.3 defaults to `--network isolated`. Existing settings files without a `network` field also select isolation. It requires Linux/WSL2, bubblewrap 0.9+ and permission to create user namespaces. Starting in beta.6, the process mode defaults to `--processes host`, which additionally needs Python 3.9+. `doctor` checks these before starting Claude. Failure stops startup; there is no automatic fallback.

```bash
sudo apt-get install bubblewrap python3
tether setup my-vps
tether doctor
tether
```

On systems restricting user namespaces, ask the system administrator to allow the installed `/usr/bin/bwrap` through the distribution's AppArmor policy. Do not run the launcher as root or disable the machine's security policy globally. `--network proxy` is an explicit alternative with a weaker routing guarantee.

## Process visibility and cleanup

Network isolation and process visibility are independent choices. The beta.6 default is `--network isolated --processes host`; an existing preferences file without `processes` adopts `host`. `tether setup --processes isolated` saves the previous private PID namespace behavior, and a one-time `--processes host` or `--processes isolated` overrides it. Both CLI and VS Code use the saved setting. `--network proxy --processes isolated` is rejected; proxy compatibility mode supports only the host process view.

| Behavior | `--processes host` (default) | `--processes isolated` |
| --- | --- | --- |
| Host process list / ordinary `ps` | Visible subject to host permissions | Hidden by a private PID namespace |
| User/network/mount restrictions | Retained | Retained |
| Direct external IPv4/IPv6, UDP, DNS | Blocked by network isolation | Blocked by network isolation |
| Signaling existing host jobs | Possible where the current user's permissions allow | Host PIDs are not addressable |
| Reading host `/proc/<pid>/fdinfo`, `environ`, debugger state | May still be denied by Linux ptrace/user-namespace checks | Host processes are hidden |
| Host inotify diagnostic IPC | Read-only fixed operation | Not exposed |
| Descendant cleanup | Python subreaper, scoped to this invocation | Kernel PID namespace teardown |

Sharing the PID view does not grant root, host ptrace capabilities or unrestricted access to process internals. It does let ordinary tools signal accessible same-user jobs; use Claude's normal command approval for operations that stop or modify existing processes. It does not change the IP routing boundary or disguise local machine information.

For the inotify use case, run this from a normal terminal or ask Claude to run it inside a host-process Tether session:

```bash
tether doctor --inotify
tether doctor --inotify --json
```

The host launcher scans only its own UID's processes. Inside isolation, a private mode-0600 Unix socket accepts only the literal inotify operation; it cannot execute a host command, read an arbitrary path or send signals. It returns PID, process name, observed watch records, actual kernel limits and unreadable/incomplete counts. A scan is limited to five seconds, replies to 2 MiB, and active clients to eight. Duplicated/inherited descriptors can be counted more than once; the result is not a unique watch total. Other users and inaccessible records are excluded. Suppressing `/proc` errors and seeing zero is not evidence that the host has zero watches. Strict process mode instead tells you to run the diagnostic in a host terminal.

In host mode a Linux [subreaper](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html) adopts detached/double-forked descendants and signals only its own children. It handles normal exit, SIGTERM and launcher SIGKILL via a [parent-death signal](https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html), escalating surviving descendants to SIGKILL after one second. It does not scan and kill unrelated host jobs. If a child remains uninterruptible after five seconds, it reports incomplete cleanup. Killing the supervisor itself with SIGKILL bypasses this userspace cleanup; `--processes isolated` retains kernel teardown for stronger lifecycle containment. A private socket directory can remain after abrupt launcher death, but cannot forward without its owner. Existing sessions retain their mode until restarted.

## GPU access

Isolated mode keeps the host filesystem and local compute available. It mounts existing GPU character devices into the otherwise minimal `/dev`: WSL `/dev/dxg`, NVIDIA numbered/control/UVM/modeset and capability devices, DRM card/render nodes, and AMD `/dev/kfd`. Symlinks and unrelated devices are excluded. Bind-mounted devices are checked by inode type, not just directory-entry type. This does not mount the entire host `/dev`, grant extra host permissions, or restore Windows interop or external IP routes.

WSL GPU access was restored in beta.3. **Native Linux NVIDIA users need beta.5 or later**: beta.3/beta.4 matched the UVM and modeset names without their hyphens, omitting `/dev/nvidia-uvm`, `/dev/nvidia-uvm-tools` and `/dev/nvidia-modeset`. `nvidia-smi` could still work while CUDA initialization failed with error 999 (`CUDA unknown error`).

Run `tether update`, then start a new Tether CLI/panel session. Device mounts are fixed at startup; updating the package cannot change an already-running namespace. Devices must also exist on the host when the new session starts. Test the same Python environment outside and inside Tether: a CPU-only PyTorch build, missing host driver/device or device permission cannot be fixed by a network launcher.

WSL detection and PyTorch CUDA matrix multiplication were verified in the [SDK/GPU report](VSCODE-LIVE-REPORT.md). Native Linux NVIDIA driver initialization and PyTorch CUDA discovery were verified separately in the [native GPU report](GPU-LIVE-REPORT.md); that test did not allocate GPU tensors or run kernels alongside existing workloads. AMD/ROCm and native DRM compute remain unverified.

This is network isolation, not a promise to hide the host hardware or operating system from Claude. Claude's own optional Bash sandbox is another layer and can impose additional restrictions; do not disable Tether's networking to solve a device or Python-environment issue.

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

The IPC directory follows `TMPDIR` and is explicitly bound into the namespace, including when it is below `/run/user/...` or `/dev/shm`. Only that private directory is re-exposed after mounting the isolated `/run` and `/dev`; sibling host files remain hidden. `doctor` checks executable availability and SSH readiness, not a model request or the complete IPC request path.

Ordinary HTTP requests retain their content length or streaming transfer encoding regardless of method. Invalid upstream responses fail the current request with 502, or close that response if headers have already been sent. Ordinary HTTP protocol upgrades are unsupported: a client upgrade receives 501, and an unsolicited upstream 101 receives 502. HTTPS/WebSocket byte streams inside CONNECT remain transparent. A TCP write-half-close forwards buffered bytes and EOF while retaining the response direction; a reset cancels the connection.

This provides an IP egress restriction for Claude and ordinary Linux descendants. It **does not transparently route every protocol**. Whole-machine TCP/UDP routing would need a separately operated VPN such as WireGuard, with IPv4/IPv6 routes, DNS and a firewall that blocks traffic when the tunnel is down. That mode is not implemented by this release. See the [WireGuard namespace design](https://www.wireguard.com/netns/).

## Compatibility

- Files, working directory, terminal input and native Claude arguments remain available. Read/Edit/Bash, stdio MCP, hooks, resume and `/model` were tested with official Claude Code 2.1.267.
- Tools connecting to a database, development server, HTTP MCP service or SSH agent already running on the host need a different arrangement. Start required local services inside the same Claude session, use stdio MCP, or deliberately select compatibility mode. Host loopback is not exposed automatically.
- Windows interop is disabled inside the WSL namespace. A tool cannot use `powershell.exe`, `cmd.exe` or a Windows browser as a normal route around this restriction. `/run` is private and `SSH_AUTH_SOCK` is removed from Claude; host-side OpenSSH can still use the caller's agent.
- Browser login is outside the namespace. Use the official manual URL/code flow when offered. If the CLI requires a callback to host loopback, complete the official login using `tether --network proxy --processes host -- auth login`, then return to isolated mode for daily use. That one login uses the weaker mode explicitly; it does not change saved preferences.
- Nested user namespaces are disabled. Tools requiring their own namespace sandbox/container may fail. This release does not enable an automatic unconfined fallback.
- Background tools belong to the session even if detached; see [process visibility and cleanup](#process-visibility-and-cleanup) for shutdown behavior and limits. The SSH transport keeps its own PID namespace and parent-death supervision in both process modes.
- macOS and Windows native do not support this implementation. `--network proxy` remains available but unverified there.

## Trust boundary and identity

This is a network namespace, **not a sandbox for hostile local code**. The project filesystem remains writable. Programs can still communicate with accessible filesystem Unix sockets or a cooperating host process; root, other host services and another process of the same user are outside the boundary. Do not use it to execute untrusted malware or as multi-user tenant isolation. Bubblewrap's security depends on how it is configured; see the [upstream explanation](https://github.com/containers/bubblewrap#sandbox-security).

The VPS changes the network exit. It does not remove account identity, project content, OS details, telemetry fields or other information that the official client sends in encrypted requests. Tether does not rewrite client identity, forge headers, disable TLS verification or claim protection from account restrictions.

For optional diagnostic traffic controls, use the official client's [documented data settings](https://code.claude.com/docs/en/data-usage), such as `DISABLE_TELEMETRY=1` and `DISABLE_ERROR_REPORTING=1`. These reduce specific diagnostics; they are not identity masking. The [official network documentation](https://code.claude.com/docs/en/network-config) describes supported proxy variables.
