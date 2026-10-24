# Architecture and development notes

Tether runs the official Claude Code CLI locally and uses an SSH-accessible VPS as the HTTP(S) network exit. The application should remain small enough to understand without a framework or a service deployment.

## Responsibilities

| Component | Location | Responsibility |
| --- | --- | --- |
| Official Claude Code | Local | Authentication, agent loop, terminal interface, permissions, files, commands, project settings, sessions |
| `src/cli.ts` | Local | Commands, executable checks, process environment and lifecycle |
| `src/vscode.ts` | Local | Official extension wrapper contract: bundled binary, literal SDK arguments and duplex stdio |
| `src/settings.ts` | Local | Small, atomic preferences file; no credentials |
| `src/tunnel.ts` | Local | OpenSSH lifecycle, readiness, keepalives and bounded reconnect backoff |
| `src/proxy.ts` | Local | HTTP and HTTPS CONNECT to SOCKS5, remote DNS and byte streams |
| `src/isolation.ts`, `src/isolated-child.ts` | Local | Linux network/PID namespaces, native CLI lifecycle |
| `src/bridge.ts` | Local | Bounded Unix/TCP bridges across the network namespace; optional gateway |
| OpenSSH sshd | VPS | SSH authentication and outbound TCP forwarding |

The default path has no custom VPS daemon, remote agent, tool bridge, database or credential service. An optional, separately installed ccproxy gateway is experimental and disabled by default. The official CLI remains responsible for project behavior and model request semantics.

## Design rules

1. Keep runtime dependencies at zero unless a concrete requirement justifies one.
2. Keep the daily entry point to `tether`; prefer a one-time setup command over manual configuration.
3. Retain the caller's working directory, terminal behavior, authentication settings and literal Claude arguments.
4. Keep SSH reconnection independent of the local Claude process. Do not replay requests or restart a complete agent task.
5. Apply connection deadlines only to connection establishment, never to an established model stream.
6. Use native stream backpressure, bounded pending buffers and explicit cancellation.
7. Preserve SSH host verification and TLS verification. Do not introduce direct-connection fallback.
8. Stop only the processes started by this invocation. Do not modify the user's SSH configuration or copy login credentials.

The tunnel changes the network exit, not the identity or local environment described to a model. Project content required by Claude can still reach the upstream provider. A broken TCP stream cannot be made lossless by reconnecting SSH.

The VS Code adapter confines the spawned Claude process, not the entire extension host. Keep SDK stdin/stdout free of launcher text. Native panel callbacks can use stdio; do not open general host loopback access to accommodate a separate CLI IDE connection. GPU device access is independent of the IP boundary and uses explicit character-device mounts.

## Development workflow

Read README and the operations guide, then run `npm ci`, `npm test` and `npm run test:package`. Cloud tasks already have isolated checkouts; use the existing checkout and do not create a Git worktree unless explicitly requested.

Transport tests must exercise actual sockets, OpenSSH, TLS, cancellation, fragmentation, backpressure and recovery. CLI substitutes validate process contracts only; they are not evidence of live Claude compatibility. Keep the validation boundaries in `docs/TEST-REPORT.md` current.

The first real VPS/Pro validation is recorded in `docs/LIVE-TEST-REPORT.md`: streamed requests, local project tools, MCP/hooks, model selection and native resume were exercised. New HTTPS connections recovered after three controlled SSH interruptions. Extended use and recovery of an active model turn during an outage remain separate validation work. Do not infer those results from local fixtures or successful short requests.

The default isolated mode enforces an IP egress boundary with rootless bubblewrap, a loopback-only network namespace and private Unix bridges. Settings may still override proxy variables, but cannot restore direct IP egress. Proxy-unaware traffic is blocked, not transparently converted. Compatibility mode is explicitly opt-in. This is not a hostile-code filesystem sandbox or identity mask; see `docs/NETWORK.md`.

The optional ccproxy connector tunnels a VPS loopback port and preserves the official client's request semantics. It does not inject credentials or implement request shaping. The audited upstream writes TLS key logs, retains request content and disables upstream TLS verification by default; synthetic tests are not approval for personal Pro use. See `docs/CCPROXY.md`.

## Earlier architecture

The initial prototype ran a remote agent with a local tool bridge. That design was replaced by the local-CLI/SSH architecture. Its source and evidence remain in Git history at `af82f6b` and earlier commits; its 37 tests are not part of the current transport test results.
