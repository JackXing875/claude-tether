# Architecture and development notes

Claude Tether runs the official Claude Code CLI locally and uses an SSH-accessible VPS as the HTTPS network exit. The application should remain small enough to understand without a framework or a service deployment.

## Responsibilities

| Component | Location | Responsibility |
| --- | --- | --- |
| Official Claude Code | Local | Authentication, agent loop, terminal interface, permissions, files, commands, project settings, sessions |
| `src/cli.ts` | Local | Commands, executable checks, process environment and lifecycle |
| `src/settings.ts` | Local | Small, atomic preferences file; no credentials |
| `src/tunnel.ts` | Local | OpenSSH lifecycle, readiness, keepalives and bounded reconnect backoff |
| `src/proxy.ts` | Local | Loopback HTTPS CONNECT to SOCKS5, remote DNS and byte streams |
| OpenSSH sshd | VPS | SSH authentication and outbound TCP forwarding |

There is no custom VPS daemon, remote agent, tool bridge, database, model gateway, or credential service. The official CLI remains responsible for project behavior and model request semantics.

## Design rules

1. Keep runtime dependencies at zero unless a concrete requirement justifies one.
2. Keep the daily entry point to `claude-tether`; prefer a one-time setup command over manual configuration.
3. Retain the caller's working directory, terminal behavior, authentication settings and literal Claude arguments.
4. Keep SSH reconnection independent of the local Claude process. Do not replay requests or restart a complete agent task.
5. Apply connection deadlines only to connection establishment, never to an established model stream.
6. Use native stream backpressure, bounded pending buffers and explicit cancellation.
7. Preserve SSH host verification and TLS verification. Do not introduce direct-connection fallback.
8. Stop only the processes started by this invocation. Do not modify the user's SSH configuration or copy login credentials.

The tunnel changes the network exit, not the identity or local environment described to a model. Project content required by Claude can still reach the upstream provider. A broken TCP stream cannot be made lossless by reconnecting SSH.

## Development workflow

Read README and the operations guide, then run `npm ci`, `npm test` and `npm run test:package`. Cloud tasks already have isolated checkouts; use the existing checkout and do not create a Git worktree unless explicitly requested.

Transport tests must exercise actual sockets, OpenSSH, TLS, cancellation, fragmentation, backpressure and recovery. CLI substitutes validate process contracts only; they are not evidence of live Claude compatibility. Keep the validation boundaries in `docs/TEST-REPORT.md` current.

The next external validation is a user's real VPS and official Claude account: complete a streamed request and a small local project task, then inspect behavior during a short outage and extended use. Do not report these checks as complete based on local fixtures.

## Earlier architecture

The initial prototype ran a remote agent with a local tool bridge. That design was replaced by the local-CLI/SSH architecture. Its source and evidence remain in Git history at `af82f6b` and earlier commits; its 37 tests are not part of the current transport test results.
