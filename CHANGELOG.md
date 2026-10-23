# Changelog

## 0.3.0-beta.1 — 2026-10-23

- Default Linux/WSL network isolation blocks direct IP egress even when Claude settings override proxy variables; unsupported isolation stops startup without fallback. Explicit proxy compatibility mode remains available.
- Add ordinary HTTP forwarding alongside HTTPS CONNECT, with streaming and hop-header cleanup.
- Supervise Claude, detached tools and SSH with PID namespaces and parent-death cleanup in isolated mode.
- Add an optional SSH connector for a VPS-local ccproxy gateway; synthetic upstream validation only, disabled by default because key-log/capture/listener concerns remain. No identity spoofing or account-safety guarantee.
- Include all referenced operating/security/validation documents in the package and publish version changes on main through validated GitHub Actions.

- Clear `dist` before compiling so upgrades do not run tests or package outputs left by the removed architecture.
- Record real WSL2/VPS/Pro validation of native Claude tools, MCP/hooks, model selection, session resume, permission denial and cancellation.
- Document settings that can override proxy variables, separate Pro authentication profiles and native WSL SSH configuration.

## 0.2.0-beta.1 — 2026-10-23

First beta of the local Claude Code / SSH transport architecture.

### Added

- One-time `claude-tether setup` and a plain `claude-tether` daily command.
- A `doctor` command, version output, saved defaults and temporary command-line overrides.
- Loopback HTTPS CONNECT forwarding through OpenSSH SOCKS5, with remote DNS and end-to-end TLS.
- SSH keepalives, bounded reconnect backoff, streaming backpressure, cancellation and process cleanup.
- Local OpenSSH/TLS integration tests and installation tests for the prebuilt npm package.
- English documentation, contribution and security guidance, and automated GitHub prereleases.

### Changed

- Claude, authentication, project tools, permissions and sessions now stay local; the VPS needs only sshd.
- Removed the remote-agent prototype, MCP tool bridge, SQLite state and npm runtime dependencies.
- Package metadata now matches the repository's existing GPLv3 license (`GPL-3.0-only`).

### Known limitations

- Linux is validated; macOS and Windows native are untested.
- Ordinary HTTP, UDP and system-wide traffic routing are not supported.
- Broken model streams are not replayed or transparently resumed by Tether.
- Live Claude account/VPS validation and long-duration network testing remain outstanding.
