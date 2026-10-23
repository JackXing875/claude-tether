# Beta validation record

Target: `0.3.0-beta.1`. Recorded on 2026-10-23 (Asia/Shanghai).

Validation uses Linux x64, Node.js 24.14.0, TypeScript 7.0.2 and OpenSSH 10.0p2. Tests create temporary loopback sshd and TLS services with isolated keys and bubblewrap namespaces; they do not access personal SSH configuration, a real VPS or a Claude account.

Current local results: **29 tests passed, 0 failed, 0 cancelled, 0 skipped**, including the TypeScript build. The actual packed tarball installed and ran successfully without access to the checkout's TypeScript toolchain. The production dependency audit reported **0 vulnerabilities**. Documentation links and package/lockfile version and license consistency were also checked.

## Automated coverage

- Rootless network isolation: HTTP through real SSH, blocked direct IPv4/IPv6/UDP/DNS/host loopback, shared namespace for child tools, and no fallback when isolation is unavailable.
- Private Unix bridge response draining and large-upload backpressure; cancellation during connection establishment.
- Isolated gateway preserves model/tool payloads, beta/auth headers, streamed responses and 429/Retry-After without replay.
- Isolated launcher SIGTERM/SIGKILL closes detached tools and SSH.
- Ordinary HTTP forwarding and hop-by-hop header removal.

- CONNECT byte streams, 2 MiB transfers, backpressure, pipelined payloads and complete response draining to slow clients.
- Invalid authorities, malformed HTTP URLs, upstream failure and cancellation while a connection is pending.
- Fragmented SOCKS negotiation, remote-DNS requests, coalesced payloads, refusals, truncation and establishment timeouts.
- Verified-host SSH options, keepalives, missing executables, startup cancellation and child cleanup.
- Real SSH forwarding of a TLS/SSE response; no idle cutoff after establishment; new connections recover after killing SSH, without replaying the interrupted request.
- Literal Claude arguments, caller working directory, proxy variable scope, exit status and npm-style executable links.
- One-time setup followed by launch using saved preferences and doctor; failed setup and one-time overrides preserve existing settings.
- Preferences validation, private file permissions and atomic replacement without leftover temporary files.

`npm test` runs the strict TypeScript build and transport/CLI/settings tests. `npm run test:package` packs the actual distributable, installs it into a temporary npm prefix, invokes its executable, and checks the version and included source files.

## Validation boundaries

Local CLI substitutes verify the launch contract, not Claude's authentication, billing, model behavior or retry policy. A [0.3 isolated-mode validation](ISOLATED-LIVE-REPORT.md) and the earlier [WSL2/VPS/Pro validation](LIVE-TEST-REPORT.md) exercised official Claude Code 2.1.267, real model calls, native tools and session behavior. Long-duration/poor-network behavior, macOS and Windows native remain unverified. Three controlled SSH interruptions verified recovery of new HTTPS connections; they did not verify seamless continuation of an interrupted model stream.

The local upgrade from the previous architecture exposed stale `dist` tests: TypeScript compilation does not remove outputs whose sources were deleted. The build now clears `dist` before compiling. After installing the documented OpenSSH server test dependency, all current tests and the packed installation check passed on WSL2 as well.

Earlier tool-bridge tests belonged to a replaced architecture. Their historical results are not counted as beta validation.
