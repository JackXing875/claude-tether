# Roadmap and release gates

The project is a development alpha. “Open-source engineering foundation” and “daily-use Claude relay” have separate acceptance criteria. The [original design](../START.md) remains background; current behavior is documented in the README, CLI help, compatibility table and tests.

## Foundation

- Unified CLI, explicit runtime selection, private state defaults and device commands.
- Authenticated session discovery for the exact saved workspace, with status metadata and explicit resume selection.
- Core modules with an enforced dependency graph and public typed exports.
- Reproducible source build, source-inclusive tarball, clean production-install smoke test.
- Linux/Node 24 CI, type/lint/format/docs checks, recovery and permission tests, coverage artifacts.
- Contribution/security/release instructions and issue/PR templates.
- GitHub workflow results must be checked for the actual proposed commit, not inferred from local tests.

## Real Claude integration — controlled alpha verified

The owner's official Pro login and the pinned 2.1.267 VPS-to-WSL path passed the [live acceptance](LIVE-TEST-REPORT.md). Public `--runtime claude`, managed SSH transport and a dedicated-user systemd template are available. No credentials belong in issues, chat, CI or git.

- Completed the two-turn fresh MCP challenge and explicit conversation recall.
- Verified official CLI → MCP → relay → local read/search/edit/test, with a checked tool allowlist and no remote project copy.
- Verified service restart/resume, denial, edit conflict, cancellation, disconnect cleanup, reconciliation and command deduplication.
- Recorded observed text latency and memory; long-context/long-duration capacity remains untested.

The report retains a transient reconnect failure and distinguishes synthetic fixtures from official results. Stable publication still requires wider use, resource/upgrade tests and the beta work below.

## Daily-use beta

- Reliable worker supervision and restart with a recovery UI for unknown operations.
- Build on session listing and explicit ID selection with reconnect UX, local project context and clear permission presentation.
- Foreground task UX, file-edit review/undo, resource soak tests and upgrade/migration procedures.
- Cross-platform support only after native tests: Windows requires process/job, path and file-identity work; macOS requires its own execution/cancellation coverage.
- Hooks/skills, local MCP extensions, IDE integration, PTY and background work only with explicit trust and lifecycle contracts.

Multi-user subscription resale, arbitrary remote execution of local hooks, account sharing and an API-key gateway are outside the personal-use design.
