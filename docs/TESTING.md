# Testing and evidence

Run tests on Linux/WSL2 with Node >=24.14.0 <25, npm, ripgrep and openssl. No Claude login, SSH key, API key or external model service is needed.

| Command                      | What it verifies                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `npm run check`              | Strict TypeScript, including tests                                                 |
| `npm run lint`               | ESLint and typed promise rules                                                     |
| `npm run format:check`       | Shared source/config/documentation formatting                                      |
| `npm run check:architecture` | Import boundaries, core independence and acyclic modules                           |
| `npm run check:docs`         | Relative Markdown link destinations (not remote URL availability or anchors)       |
| `npm test`                   | Clean build plus functional, protocol, recovery and CLI tests                      |
| `npm run test:coverage`      | Same tests with Node coverage and `coverage/lcov.info`                             |
| `npm run test:package`       | Real npm tarball, production-only install, exported modules and installed CLI demo |
| `npm run verify`             | All source checks plus the functional suite                                        |

Tests use actual temporary files, child processes, SQLite, authenticated loopback WS/WSS and the MCP SDK. They cover permissions/timeout/default denial, revision conflicts, symlinks and encoding, command output/process-group limits, duplicate deliveries, crash uncertainty, lost replies, session binding, TLS and revocation. CLI tests start separate relay/client processes and test explicit resume, private credentials and graceful shutdown. Runtime decoder fixtures are **synthetic**, not recordings of an authenticated Claude run.

CI tests the minimum supported Node and current Node 24.x on Ubuntu 24.04. WSL behavior is also checked locally; GitHub's Ubuntu runner does not emulate WSL or native Windows. A stable `CI / required` aggregate job is suitable for a branch protection rule if the maintainer chooses to enable one; adding the workflow does not itself enable branch protection.

Coverage includes core packages. It is a diagnostic artifact, not a maturity score. The supervisor subprocess paths are exercised with a synthetic CLI; the official CLI remains a separate real-account gate. An aggregate percentage cannot replace permission/recovery regression tests; do not add implementation-mirroring tests just to raise it.

`test:package` needs registry access to install dependencies. It writes a tarball and checksum under ignored `artifacts/`, then removes its temporary installation and demo directories. There are no install/postinstall hooks in the distributable. CI produces artifacts but does not publish to npm or contact Claude.

The [first prototype report](TEST-REPORT.md) and [network smoke JSON](evidence/p1-network-smoke.json) are historical snapshots. They prove that particular fake-runtime experiment, not today's real-runtime compatibility. Current checks are visible on the exact commit's [GitHub Actions page](https://github.com/JackXing875/claude-tether/actions/workflows/ci.yml).

Candidate-runtime tests launch a synthetic CLI executable, the actual MCP worker subprocess, the authenticated relay and the real local host. They verify local read/edit/test effects, transcript UUID mapping across supervisor restarts, explicit recovery after interruptions, credential-source rejection, invalid remote tool sets, cancellation of an active local process, timeout, and capability cleanup. Runtime-channel tests reject wrong secrets, stale bindings/turns, pre-initialization calls and extra connections, and prove dropped in-flight calls do not reconnect or replay.

Client regressions cover multiple observers of the same turn, independent wait deadlines, disconnection/close settlement and bounded outstanding waits. The completion, timeout-isolation and close regressions reproduced failures against the previous implementation before the fix.

Session discovery tests cover device/workspace/policy isolation, attached and interrupted sessions, retained UNKNOWN effects, absence of transcript/tool content, and repeated queries without turns or epoch changes. CLI tests list sessions while the local journal lease is held, verify JSON/text output and explicit resume, and check that an unused workspace creates no state. Identity tests reject replaced projects, wrong devices/policies, symlinks, public files and FIFOs.

P0 probe tests use a separate synthetic CLI and the real single-tool MCP subprocess. They require a fresh challenge across fragmented text events, the same explicit session UUID and recall without another tool call. Successful exits with a forgotten marker, a different session, extra tools or missing MCP evidence fail. Tests also verify authentication rejection, signal cancellation of CLI/MCP processes, temporary-file cleanup and refusal to change a public directory's permissions. These tests validate the probe's acceptance logic; they are not official account evidence.
