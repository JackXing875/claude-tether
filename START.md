# Architecture and development notes

Tether runs the official Claude Code CLI locally and uses an SSH-accessible VPS as the HTTP(S) network exit. The application should remain small enough to understand without a framework or a service deployment.

## Responsibilities

| Component | Location | Responsibility |
| --- | --- | --- |
| Official Claude Code | Local | Authentication, agent loop, terminal interface, permissions, files, commands, project settings, sessions |
| `src/cli.ts` | Local | Commands, executable checks, process environment and lifecycle |
| `src/vscode.ts` | Local | Official extension wrapper contract: bundled binary, literal SDK arguments and duplex stdio |
| `src/settings.ts` | Local | Small, atomic preferences file; no credentials |
| `src/update.ts` | Local | GitHub release discovery, HTTPS/checksum verification, staged self-update and rollback |
| `src/tunnel.ts` | Local | OpenSSH lifecycle, readiness, keepalives and bounded reconnect backoff |
| `src/proxy.ts` | Local | HTTP and HTTPS CONNECT to SOCKS5, remote DNS and byte streams |
| `src/isolation.ts`, `src/isolated-child.ts` | Local | Linux network namespace, optional PID namespace, native CLI lifecycle |
| `src/process-supervisor.py` | Local host | Subreaper and parent-death cleanup for this invocation's descendants in host process mode |
| `src/diagnostics.ts` | Local host / child | Fixed read-only current-user inotify diagnostic over private IPC |
| `src/bridge.ts` | Local | Bounded Unix/TCP bridges across the network namespace; optional gateway |
| OpenSSH sshd | VPS | SSH authentication and outbound TCP forwarding |

The default path has no custom VPS daemon, remote agent, tool bridge, database or credential service. An optional, separately installed ccproxy gateway is experimental and disabled by default. The official CLI remains responsible for project behavior and model request semantics.

## Design rules

1. Keep npm runtime dependencies at zero unless a concrete requirement justifies one. System Python 3.9+ is used only for host-mode descendant supervision; its standard library supplies Linux subreaper/parent-death handling without a compiled addon or privileged daemon.
2. Keep the daily entry point to `tether`; prefer a one-time setup command over manual configuration.
3. Retain the caller's working directory, terminal behavior, authentication settings and literal Claude arguments.
4. Keep SSH reconnection independent of the local Claude process. Do not replay requests or restart a complete agent task.
5. Apply connection deadlines only to connection establishment, never to an established model stream.
6. Use native stream backpressure, bounded pending buffers and explicit cancellation.
7. Preserve SSH host verification and TLS verification. Do not introduce direct-connection fallback.
8. Stop only the processes started by this invocation. Do not modify the user's SSH configuration or copy login credentials.

The tunnel changes the network exit, not the identity or local environment described to a model. Project content required by Claude can still reach the upstream provider. A broken TCP stream cannot be made lossless by reconnecting SSH.

The VS Code adapter confines the spawned Claude process, not the entire extension host. Keep SDK stdin/stdout free of launcher text. Native panel callbacks can use stdio; do not open general host loopback access to accommodate a separate CLI IDE connection. GPU device access is independent of the IP boundary and uses explicit character-device mounts.

Self-update is an explicit host-side maintenance command, independent of Claude and SSH. Use published GitHub assets, retain TLS/checksum verification, stage with npm scripts disabled and never overwrite a source checkout. Preserve the invoked installation path and profile/configuration files. Keep current sessions running and retain a recovery copy; do not claim that the two-rename activation survives arbitrary power loss atomically.

## Development workflow

Read README and the operations guide, then run `npm ci`, `npm test` and `npm run test:package`. Cloud tasks already have isolated checkouts; use the existing checkout and do not create a Git worktree unless explicitly requested.

Transport tests must exercise actual sockets, OpenSSH, TLS, cancellation, fragmentation, backpressure and recovery. CLI substitutes validate process contracts only; they are not evidence of live Claude compatibility. Keep the validation boundaries in `docs/TEST-REPORT.md` current.

Record completed changes, verification evidence and outstanding acceptance work in [the development log](docs/DEVELOPMENT-LOG.md). The beta.6 process-mode candidate passed the normal-use real CLI/SDK checks in [its live report](docs/PROCESS-MODE-LIVE-REPORT.md); previous-version live results do not substitute for a changed runtime's acceptance. Actual desktop UI observations and long-duration/fault acceptance remain separate claims.

The first real VPS/Pro validation is recorded in `docs/LIVE-TEST-REPORT.md`: streamed requests, local project tools, MCP/hooks, model selection and native resume were exercised. New HTTPS connections recovered after three controlled SSH interruptions. Extended use and recovery of an active model turn during an outage remain separate validation work. Do not infer those results from local fixtures or successful short requests.

The default isolated mode enforces an IP egress boundary with rootless bubblewrap, a loopback-only network namespace and private Unix bridges. Settings may still override proxy variables, but cannot restore direct IP egress. Proxy-unaware traffic is blocked, not transparently converted. Compatibility mode is explicitly opt-in. This is not a hostile-code filesystem sandbox or identity mask; see `docs/NETWORK.md`.

Process visibility defaults to `host` independently of isolated networking. Keep user/mount/network restrictions; offer `--processes isolated` for the former private PID namespace. Shared PIDs do not override ptrace/procfs permissions. The host diagnostic supports only current-user inotify statistics: never extend it into arbitrary host execution, filesystem access or signaling. Its absence must be an error, not a misleading namespace-only zero. A host-mode subreaper cleans only descendants it owns; use neither same-user process scans nor broad process-group/name kills. Test normal exit, launcher death, detached children and preservation of unrelated peers with disposable local fixtures.

The optional ccproxy connector tunnels a VPS loopback port and preserves the official client's request semantics. It does not inject credentials or implement request shaping. The audited upstream writes TLS key logs, retains request content and disables upstream TLS verification by default; synthetic tests are not approval for personal Pro use. See `docs/CCPROXY.md`.

## Earlier architecture

The initial prototype ran a remote agent with a local tool bridge. That design was replaced by the local-CLI/SSH architecture. Its source and evidence remain in Git history at `af82f6b` and earlier commits; its 37 tests are not part of the current transport test results.
