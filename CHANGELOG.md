# Changelog

## 0.3.0-beta.6 — 2026-10-25

- Separate process visibility from network isolation with `--processes host|isolated`, persisted by setup. Default to host PIDs while retaining isolated networking, user/mount restrictions and GPU device access; explicit isolated PIDs retain the former behavior.
- Add a Python 3.9+ standard-library subreaper for host-mode cleanup on normal exit, SIGTERM and launcher death. Reap this invocation's detached/double-forked tools without killing unrelated host jobs. No silent fallback when supervision is unavailable.
- Add `tether doctor --inotify [--json]`: a fixed read-only host operation for current-user watch records, kernel limits and incomplete-read counts. It works through private IPC in host process mode without opening arbitrary host execution or relaxing procfs permissions.
- Cover both process modes' IP restrictions, process visibility, saved preferences, diagnostic permissions, cleanup and packaged supervisor availability. Document the remaining user-namespace permissions and supervisor lifecycle limits.
- Contain malformed ordinary HTTP responses within the affected request: validate final status codes and catch response callback failures, returning 502 without terminating the launcher or isolated Claude process.
- Preserve streaming request framing for GET, DELETE and other methods, including explicit content lengths and chunked uploads.
- Preserve TCP write-half-closes during bridge and CONNECT establishment, drain pending uploads before forwarding EOF, and keep the response direction open. Connection resets still cancel pending dials.
- Reject unsupported ordinary HTTP upgrades with 501 and unsolicited upstream 101 responses with 502; close the associated sockets. HTTPS upgrades carried inside CONNECT remain transparent.
- Bind the private IPC directories after the isolated `/dev` and `/run` mounts so custom `TMPDIR` locations keep working without exposing sibling host files.
- Read the installed version after acquiring the update lock, and recheck immediately before activation. Delayed updaters skip completed upgrades and stale release lists; detected external version changes stop activation.
- Add transport, isolated-launcher and independent-process update regression tests. Release workflow idempotency/concurrency and extended real-network recovery acceptance remain pending.
- Pass 75 automated tests, packed installation/self-update and production dependency audit. Verify the packaged candidate with real Pro/Claude Code 2.1.310 on WSL and native Linux: native tools, SDK permission callbacks, host watch/GPU discovery, Sonnet-to-Opus switching, CLI resume and normal descendant cleanup. Record real SDK coverage separately from untested desktop panel interactions.

## 0.3.0-beta.5 — 2026-10-24

- Fix native Linux NVIDIA CUDA access in isolated CLI and VS Code sessions: match the actual hyphenated `nvidia-uvm`, `nvidia-uvm-tools` and `nvidia-modeset` device names.
- Inspect device inodes with `lstat` so existing bind-mounted character devices are recognized; continue excluding symlinks, ordinary files and unrelated devices.
- Add hardware-independent regression coverage for NVIDIA/WSL/AMD/DRM device names and mount arguments, and record native NVIDIA driver/PyTorch discovery before and after the fix. External IP routes remain blocked.
- Require a new Tether session after upgrading; existing namespaces and running jobs are not restarted or modified.

## 0.3.0-beta.4 — 2026-10-24

- Add `tether update` and `tether update --check` using published GitHub release assets, with numeric beta ordering, stable-channel preservation and no automatic downgrades.
- Verify HTTPS, SHA-256 manifests and available GitHub asset digests before staging an offline npm installation with lifecycle scripts disabled and engine checks enabled.
- Preserve the invoked package path, CLI/VS Code links and external preferences; retain a previous-package backup and roll back failed activation renames.
- Reject source checkouts and unwritable installations, serialize concurrent upgrades, and clean up after normal cancellation. Document host-network scope and manual recovery after abrupt process/machine failure.
- Exercise successful and failed upgrades, TLS/redirect/download boundaries, cancellation, rollback and the shipped updater in the packed installation test.

## 0.3.0-beta.3 — 2026-10-24

- Add `tether-vscode`, an official VS Code process-wrapper adapter that selects the bundled CLI and preserves bidirectional SDK communication, permissions and lifecycle.
- Restore local GPU device access in isolated mode without opening external IP routes or Windows interop.
- Document Remote WSL setup and the distinction between isolated Claude child traffic and requests made by the extension host itself.
- Verify real Pro SDK file tools, MCP/hooks and permission callbacks, Sonnet-to-Opus switching, and WSL PyTorch CUDA computation. Add wrapper and GPU regression coverage.

## 0.3.0-beta.2 — 2026-10-24

- Use Tether as the display name and `tether` as the primary installed command.
- Retain `claude-tether` as a compatibility command and keep existing package, repository and configuration paths so upgrades reuse saved settings.
- Update command help and current operating guides, and verify both executable names in the packaged installation check.

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
