# Roadmap and release gates

The [product direction](PRODUCT.md) is personal, self-hosted access and operations for local official Claude Code through VPS ccproxy. Account continuity is the first design priority, followed by native usability and maintenance cost. Engineering tests can establish compatibility and failure behavior; they cannot establish immunity from account suspension.

The existing remote-agent prototype remains runnable. Its tests and live report do not validate the new route. No ccproxy dependency, deployment or native launcher is included yet.

## N0 — Pin and audit the ccproxy path

Status: [source/document research](NATIVE-CLAUDE-RESEARCH.md) is recorded; executable integration checks are pending.

- Select an exact upstream commit/release and dependency set. Distinguish the 2.0 development implementation from older LiteLLM releases and record license obligations before integration or redistribution.
- Use synthetic requests and dummy credentials to check model fields, messages, tool events, metadata, capability headers, streaming completion and cancellation.
- Document every enabled transform, authentication override and request-shaping step. Begin with one official upstream and the user's official client login flow.
- Verify request logs, HAR, TLS keylogs and error outputs against synthetic sensitive markers; a setting called redaction is not sufficient evidence.
- Check 401, 403, 429, timeouts and partial streams. Respect rate limits, bound retries and avoid introducing launcher-level replay of model tasks.

Exit: reproducible fixtures, a reviewed minimal configuration and a written list of fields/routes changed or preserved. No production subscription credentials in fixtures or CI.

## N1 — Native client connection and deployment

- Launch the installed official local CLI with an isolated connection profile and a managed SSH tunnel to VPS loopback.
- Preserve the user's ordinary CLI installation and configuration; record which environment/settings the profile changes.
- Keep host verification, process cleanup, explicit error reporting and upgrade/rollback paths. Reuse existing SSH code only after confirming its contract fits this path.
- Inspect inference, login/refresh, auxiliary checks and optional telemetry separately. Changing a base URL alone does not prove that all traffic follows the VPS route.
- Verify failure behavior when the tunnel or proxy stops, including unexpected direct egress or fallback.
- Add pinned deployment and health-check instructions. Keep the existing relay and its private state independent.

Exit: clean installation and removal, synthetic end-to-end connection tests, documented credential/logging boundaries and a tested rollback. Publish a new CLI entrypoint only when it actually exists.

## N2 — Official client acceptance

Use a disposable local project and the account owner's official login. Record exact client/proxy versions and distinguish real calls from synthetic evidence.

- Native TUI and conversation; `/model` selection must change the actual upstream model as expected.
- Read/search/edit/Bash, local approval and denial, cancellation and explicit native session resume.
- Local `CLAUDE.md`, one MCP server and one hook, with verified local paths and permissions.
- Observed network route, disconnect handling, authentication failure and rate-limit behavior. Do not deliberately provoke account enforcement.
- No secrets or private transcripts in the public report.

Exit: a sanitized acceptance report, a compatibility table and working user instructions. The prototype's remote session IDs are not assumed to migrate into official local sessions.

## N3 — Daily use and maintenance

- Long-session/resource tests and bounded failure recovery.
- Reproducible proxy/client upgrades, rollback and diagnostics that omit credentials and conversation bodies.
- Multiple self-owned device profiles with explicit scope; no account pooling or credential distribution.
- Native Windows/macOS only after platform-specific process, path, authentication and shutdown tests.

Exit: documented operating limits and repeatable upgrade/recovery checks. A short successful run or an account remaining active is not evidence that a proxy prevents suspension.

## Existing prototype — retained and maintained

The remote-agent/local-tool bridge provides:

- Unified CLI, explicit fake/Claude runtime selection, device management and private state defaults.
- Scoped session discovery, explicit resume, durable operation receipts and unknown-outcome safeguards.
- Typed core modules, module-boundary checks, source-inclusive tarballs and clean installation tests.
- Linux/Node 24 CI, permission/recovery tests, contribution/security/release documentation.
- Controlled official Claude 2.1.267 / Pro VPS-to-WSL [live acceptance](LIVE-TEST-REPORT.md), including the retained transient reconnect failure.

Maintain correctness and security fixes for this code while the new path is evaluated. Building a replacement TUI, slash-command implementation or hooks/skills compatibility layer is no longer the main product roadmap. Existing deployment/state is not automatically removed or migrated.

General-purpose VPN service, commercial multi-tenancy, subscription resale, account sharing and claims of undetectability or guaranteed account safety are outside the [product scope](PRODUCT.md). No npm or stable release is implied by this roadmap.
