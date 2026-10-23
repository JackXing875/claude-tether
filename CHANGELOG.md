# Changelog

## 0.1.0-alpha.1 — Unreleased

- Introduce the installed `tether` CLI, help/version, explicit runtime selection, device create/revoke, automatic private client state and single-prompt mode.
- Separate the client, relay, local host and MCP bridge into core modules with typed package exports and enforced dependency boundaries.
- Encapsulate the event inbox and recover completed turn results from durable local events.
- Add CLI process integration tests, configuration tests, coverage reports and a clean production-install smoke test.
- Add supported-Node CI, quality checks, dependency updates, source-inclusive release artifacts and contributor/security documentation.
- Align package metadata with the repository's existing GPL-3.0 license. Pin TypeScript 6.0.3 to match the supported typed ESLint parser.
- Add a candidate official CLI supervisor with per-turn MCP capabilities, persistent explicit runtime session IDs, process-group teardown and synthetic subprocess integration tests. The same pinned official path has now passed a separate live acceptance run.
- Fix concurrent `BridgeClient.waitTurn` observers losing completion/disconnection results. Each observer now has an independent deadline; closing the client rejects all pending observers immediately. Validate deadlines and cap outstanding observers at 64 per client.
- Add `tether sessions` and `BridgeClient.listSessions` for authenticated discovery scoped to the exact saved workspace. Queries return status metadata without creating sessions, running tools, advancing epochs or modifying the local journal. Share private workspace identity validation with `connect`.
- Strengthen the two-turn P0 probe with a fresh MCP challenge, exact session/tool checks and recall without a second tool call. Handle fragmented marker output, cancel CLI/MCP children on signals, clean private per-run files and reject public probe directories without changing their permissions.

- Enable the official `--runtime claude` server after live Pro/MCP/local-project acceptance, with explicit runtime state and turn deadline. Close runtime storage when the server stops.
- Add managed SSH connections for `connect`/`sessions`, preserving workspace identity across ephemeral local ports, with no private-key copying or remote shell. Include a dedicated-user systemd unit.

### Compatibility

- Development alpha: only Linux/WSL2 and Node >=24.14.0 <25 are supported.
- The server requires explicit `--runtime fake` or `--runtime claude`; device administration uses `tether device create/revoke`. Direct execution of old compiled application files is replaced by `bin/tether.mjs` and npm script aliases.
- Client `--config` remains an alias for `--credential`; explicit `--state` directories still work. Original source import locations retain compatibility re-exports.
- No automatic migration or deletion of earlier state. The schema remains compatible with the initial operation/event tables; use a stopped, backed-up state directory when upgrading.
- Session discovery adds an optional `session.list` RPC without a database migration. Upgrade both ends to use it; older relays reject the unsupported method explicitly.
- Official CLI 2.1.267 / Pro compatibility is recorded in the live report. Native Windows, automatic reconnect, long-duration stability and full TUI remain pending. No stable release is claimed.
