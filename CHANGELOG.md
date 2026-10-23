# Changelog

## 0.1.0-alpha.1 — Unreleased

- Introduce the installed `tether` CLI, help/version, explicit runtime selection, device create/revoke, automatic private client state and single-prompt mode.
- Separate the client, relay, local host and MCP bridge into core modules with typed package exports and enforced dependency boundaries.
- Encapsulate the event inbox and recover completed turn results from durable local events.
- Add CLI process integration tests, configuration tests, coverage reports and a clean production-install smoke test.
- Add supported-Node CI, quality checks, dependency updates, source-inclusive release artifacts and contributor/security documentation.
- Align package metadata with the repository's existing GPL-3.0 license. Pin TypeScript 6.0.3 to match the supported typed ESLint parser.
- Add a candidate official CLI supervisor with per-turn MCP capabilities, persistent explicit runtime session IDs, process-group teardown and synthetic subprocess integration tests. The public CLI remains fake-only pending official P0 verification.
- Fix concurrent `BridgeClient.waitTurn` observers losing completion/disconnection results. Each observer now has an independent deadline; closing the client rejects all pending observers immediately. Validate deadlines and cap outstanding observers at 64 per client.

### Compatibility

- Development alpha: only Linux/WSL2 and Node >=24.14.0 <25 are supported.
- The server now requires `--runtime fake`; device administration uses `tether device create/revoke`. Direct execution of old compiled application files is replaced by `bin/tether.mjs` and npm script aliases.
- Client `--config` remains an alias for `--credential`; explicit `--state` directories still work. Original source import locations retain compatibility re-exports.
- No automatic migration or deletion of earlier state. The schema remains compatible with the initial operation/event tables; use a stopped, backed-up state directory when upgrading.
- Official Claude runtime compatibility, subscription end-to-end verification, native Windows, automatic reconnect and full TUI remain pending. No stable release is claimed.
