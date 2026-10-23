# Beta validation record

Target: `0.2.0-beta.1`. Recorded on 2026-10-23 (Asia/Shanghai).

Validation uses Linux x64, Node.js 24.14.0, TypeScript 7.0.2 and OpenSSH 10.0p2. Tests create temporary loopback sshd and TLS services with isolated keys; they do not access personal SSH configuration, a real VPS or a Claude account.

Current local results: **20 tests passed, 0 failed, 0 cancelled, 0 skipped**, including the TypeScript build. The actual packed tarball installed and ran successfully without access to the checkout's TypeScript toolchain. The production dependency audit reported **0 vulnerabilities**. Documentation links and package/lockfile version and license consistency were also checked.

## Automated coverage

- CONNECT byte streams, 2 MiB transfers, backpressure, pipelined payloads and complete response draining to slow clients.
- Invalid authorities, unsupported HTTP, upstream failure and cancellation while a connection is pending.
- Fragmented SOCKS negotiation, remote-DNS requests, coalesced payloads, refusals, truncation and establishment timeouts.
- Verified-host SSH options, keepalives, missing executables, startup cancellation and child cleanup.
- Real SSH forwarding of a TLS/SSE response; no idle cutoff after establishment; new connections recover after killing SSH, without replaying the interrupted request.
- Literal Claude arguments, caller working directory, proxy variable scope, exit status and npm-style executable links.
- One-time setup followed by launch using saved preferences and doctor; failed setup and one-time overrides preserve existing settings.
- Preferences validation, private file permissions and atomic replacement without leftover temporary files.

`npm test` runs the strict TypeScript build and transport/CLI/settings tests. `npm run test:package` packs the actual distributable, installs it into a temporary npm prefix, invokes its executable, and checks the version and included source files.

## Validation boundaries

Local CLI substitutes verify the launch contract, not Claude's authentication, billing, model behavior or retry policy. Live account requests, a user's VPS deployment, long-duration/poor-network behavior, macOS and Windows native remain unverified. WSL uses the Linux workflow but was not independently exercised in this cloud run.

Earlier tool-bridge tests belonged to a replaced architecture. Their historical results are not counted as beta validation.
