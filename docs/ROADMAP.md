# Roadmap and release gates

The project is a development alpha. “Open-source engineering foundation” and “daily-use Claude relay” have separate acceptance criteria. The [original design](../START.md) remains background; current behavior is documented in the README, CLI help, compatibility table and tests.

## Foundation

- Unified CLI, explicit runtime selection, private state defaults and device commands.
- Core modules with an enforced dependency graph and public typed exports.
- Reproducible source build, source-inclusive tarball, clean production-install smoke test.
- Linux/Node 24 CI, type/lint/format/docs checks, recovery and permission tests, coverage artifacts.
- Contribution/security/release instructions and issue/PR templates.
- GitHub workflow results must be checked for the actual proposed commit, not inferred from local tests.

## Real Claude integration — next gate

This gate requires the owner's official subscription login on the dedicated VPS account. No credentials should be pasted into issues, chat, CI or git.

- Record the pinned official CLI's initialization, stream, tool and terminal behavior using the existing two-turn probe.
- Candidate authenticated per-turn MCP-to-supervisor IPC is implemented and tested with a synthetic CLI and real MCP subprocess. Verify the same boundary with official Claude before enabling the public runtime.
- Runtime session mapping and explicit resume survive restart in synthetic subprocess tests. Confirm the pinned official CLI uses the same intended conversation and transcript semantics.
- Verify a real model reads, edits and tests only the local project; confirm remote built-in tools remain unavailable.
- Test denial, disconnect during tool execution, cancellation and restart without duplicated effects.
- Measure real CLI memory/latency on the VPS. The previously inspected ~1 GiB server is below Claude's documented 4 GiB baseline; the offline transport result is not evidence of real-runtime capacity.

Do not enable `--runtime claude`, publish a stable release or describe the system as production-ready before these checks pass. Mock fixtures validate contracts, not the current official CLI or subscription entitlement.

## Daily-use beta

- Reliable worker supervision and restart with a recovery UI for unknown operations.
- Session listing and selection, reconnect UX, local project context and clear permission presentation.
- Foreground task UX, file-edit review/undo, resource soak tests and upgrade/migration procedures.
- Cross-platform support only after native tests: Windows requires process/job, path and file-identity work; macOS requires its own execution/cancellation coverage.
- Hooks/skills, local MCP extensions, IDE integration, PTY and background work only with explicit trust and lifecycle contracts.

Multi-user subscription resale, arbitrary remote execution of local hooks, account sharing and an API-key gateway are outside the personal-use design.
