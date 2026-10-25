# Beta validation record

Target: `0.3.0-beta.6`, including P1/P2 reliability fixes and independent process modes. Recorded on 2026-10-25 (Asia/Shanghai).

Validation uses Linux x64, Node.js 24.14.0, TypeScript 7.0.2, Python 3.12.3 and OpenSSH 10.0p2. Tests create temporary loopback sshd and TLS services with isolated keys and bubblewrap namespaces; they do not access personal SSH configuration, a real VPS or a Claude account.

Current local results: **75 tests passed, 0 failed, 0 cancelled, 0 skipped**, including the TypeScript build (29 additional cases compared with beta.5). The actual packed tarball installed, self-updated and ran successfully without access to the checkout's TypeScript toolchain. The production dependency audit reported **0 vulnerabilities**. Documentation links and package/lockfile version and license consistency were also checked.

## P1/P2 regression results

| Defect | Verified behavior |
| --- | --- |
| Malformed upstream HTTP response | Invalid final status codes return 502, subsequent requests succeed and no request is replayed. A real isolated launcher stays alive with a heartbeat-producing CLI substitute through a `000` response and a subsequent successful request. |
| Request body framing | GET, DELETE and POST stream chunks to the origin before the upload ends. GET/DELETE with explicit content length also preserve their body without conflicting transfer encoding. |
| Update version race | Two independent updaters are interleaved before lock acquisition. The late updater reads the newly installed version, downloads no assets and leaves the package inode and single backup unchanged, even with an older release list. A version changed externally during staging stops activation and cleans staging/lock/unused backup files. |
| TCP half-close | Small and 2 MiB uploads followed by FIN during bridge establishment retain the complete response. CONNECT retains its response after an early FIN. An upstream FIN still permits client writes; TCP resets cancel pending dials. |
| HTTP upgrade | Unsolicited upstream 101 responses produce 502 and close sockets. Ordinary client Upgrade requests receive 501 without dialing the origin. |
| Custom temporary directories | Actual isolated proxy and gateway requests work with temporary directories below `/tmp`, `/dev/shm` and `/run/user/<uid>`. Masked sibling files stay hidden, no external route appears and IPC directories are cleaned up. The `/run` fixture provisions a private runtime directory so CI does not need a pre-existing host user runtime directory. |

The release workflow (P3) is unchanged. Real model generation during an outage, SSH network blackholes, machine sleep/wake and sustained connection/resource usage remain separate acceptance work; none is implied by these local regression results.

## Process-mode regression results

- Default host PIDs and explicit private PIDs: host processes are visible only in host mode; user-namespace restrictions still deny direct access to the host fixture's `fdinfo`.
- In both modes, real local SSH carries proxy HTTP while direct IPv4/IPv6/UDP/DNS and host loopback remain blocked, including proxy overrides. Child tools inherit the isolated network.
- A real host inotify watcher appears in the read-only diagnostic from the isolated child, with the host's actual `max_user_watches`. Strict PID mode refuses the host operation. Invalid command/path requests are rejected; socket permissions, shutdown and unavailable IPC are checked. No SSH or account is required for the host maintenance command.
- Host and isolated modes both clean detached, double-forked tools on normal exit, SIGTERM and launcher SIGKILL. The fixture ignores SIGTERM to exercise escalation. An unrelated host peer survives. Exit status is preserved. Killing the host supervisor itself and uninterruptible kernel tasks are outside this guarantee.
- Missing Python blocks default startup without fallback; explicit PID isolation does not require Python. Setup persists process mode, one-time overrides do not alter it, invalid modes/combinations fail before SSH, and the VS Code duplex/cancellation tests exercise the new default.
- Proxy, gateway and host-diagnostic IPC work with custom `TMPDIR` under `/tmp`, `/dev/shm` and `/run/user/<uid>`. Installed-package validation checks the shipped supervisor's path and execution.

The results above use WSL/local fixtures. Separate real Claude Code 2.1.310 tests subsequently passed against the packed beta.6 candidate on WSL and a native NVIDIA Linux server, using independent candidate entry points and existing Pro logins. Existing daily installations and preferences were retained. See the [real process-mode report](PROCESS-MODE-LIVE-REPORT.md).

The [development log](DEVELOPMENT-LOG.md) records initial planning, completed real acceptance and the remaining scope. The [initial local evidence](evidence/process-mode-local-2026-10-25.json) preserves the pre-release implementation run; [beta.6 live evidence](evidence/process-mode-live-2026-10-25.json) records the packaged candidate. SDK transport passed; rendered desktop panel interactions were not retested. No real-account network fault injection was performed. Historical live results below still apply only to their recorded versions.

## Automated coverage

- Updater: numeric beta ordering, stable-channel preservation, pagination, check-only/current/newer versions, release URL validation and SHA-256/asset digest failures.
- Real staged npm upgrades in a temporary custom prefix: retained executable links and profile, old-package backup, running-process continuity, disabled lifecycle scripts, engine/metadata/probe failures, concurrency, cancellation and activation rollback.
- Verified HTTPS download fixture: redirects, rejection of HTTP downgrades and self-signed certificates, bounded/truncated responses, rate limits, aborts and no direct fallback when a host proxy fails.
- VS Code wrapper: extension-supplied executable, duplex stdin/stdout, EOF, literal SDK arguments, profile/cwd preservation, cancellation, detached-child cleanup and exit status.
- GPU character-device identity inside isolation; hardware-independent fixtures for hyphenated NVIDIA UVM/modeset names, existing bind-mounted devices, WSL/AMD/DRM names and mount arguments; exclusion of ordinary files, symlinks, symlinked device directories and unrelated device names. Real WSL CUDA compute is recorded in the [SDK/GPU report](VSCODE-LIVE-REPORT.md); native NVIDIA initialization/discovery in the [native GPU report](GPU-LIVE-REPORT.md).
- Rootless network isolation: HTTP through real SSH, blocked direct IPv4/IPv6/UDP/DNS/host loopback, shared namespace for child tools, and no fallback when isolation is unavailable.
- Private Unix bridge response draining and large-upload backpressure; cancellation during connection establishment.
- Isolated gateway preserves model/tool payloads, beta/auth headers, streamed responses and 429/Retry-After without replay.
- Both process modes clean their detached tools on exit and launcher SIGTERM/SIGKILL; SSH retains separate PID supervision.
- Ordinary HTTP forwarding and hop-by-hop header removal.

- CONNECT byte streams, 2 MiB transfers, backpressure, pipelined payloads and complete response draining to slow clients.
- Invalid authorities, malformed HTTP URLs, upstream failure and cancellation while a connection is pending.
- Fragmented SOCKS negotiation, remote-DNS requests, coalesced payloads, refusals, truncation and establishment timeouts.
- Verified-host SSH options, keepalives, missing executables, startup cancellation and child cleanup.
- Real SSH forwarding of a TLS/SSE response; no idle cutoff after establishment; new connections recover after killing SSH, without replaying the interrupted request.
- Literal Claude arguments, caller working directory, proxy variable scope, exit status and npm-style executable links.
- One-time setup followed by launch using saved preferences and doctor; failed setup and one-time overrides preserve existing settings.
- Preferences validation, private file permissions and atomic replacement without leftover temporary files.

`npm test` runs the strict TypeScript build and transport/CLI/settings/adapter/updater/diagnostic tests. `npm run test:package` packs the actual distributable, installs it into a temporary npm prefix, invokes its three executable entry points, and checks the version and included source files. It runs the installed host-supervision prerequisite check, including the packaged Python helper. It then exercises the shipped updater with that same real tarball, substituting only release discovery/download, and rechecks the installed entry points.

A separate WSL smoke test used real public GitHub downloads, redirects, checksum manifests and asset digests to upgrade a disposable beta.2 installation to beta.3 with the new updater. It left personal profiles and active installations alone. This checks the download/install path independently of synthetic release metadata; it does not add a model request or change previous Claude compatibility claims.

## Validation boundaries

Local CLI substitutes verify the launch contract, not Claude's authentication, billing, model behavior or retry policy. A [0.3 isolated-mode validation](ISOLATED-LIVE-REPORT.md) and the earlier [WSL2/VPS/Pro validation](LIVE-TEST-REPORT.md) exercised official Claude Code 2.1.267, real model calls, native tools and session behavior. Long-duration/poor-network behavior, macOS and Windows native remain unverified. Three controlled SSH interruptions verified recovery of new HTTPS connections; they did not verify seamless continuation of an interrupted model stream.

The local upgrade from the previous architecture exposed stale `dist` tests: TypeScript compilation does not remove outputs whose sources were deleted. The build now clears `dist` before compiling. After installing the documented OpenSSH server test dependency, all current tests and the packed installation check passed on WSL2 as well.

Earlier tool-bridge tests belonged to a replaced architecture. Their historical results are not counted as beta validation.
