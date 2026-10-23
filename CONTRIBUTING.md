# Contributing

Tether is a personal remote-agent/local-tool bridge in development alpha. Start with the [architecture](docs/ARCHITECTURE.md), [compatibility boundary](docs/COMPATIBILITY.md) and [roadmap](docs/ROADMAP.md). The fake runtime lets contributors work without a subscription or VPS.

## Local setup

Use Linux/WSL2 with the Node version in `.nvmrc`, npm, ripgrep and openssl. Clone the repository, then run:

```bash
npm ci
npm run verify
npm run test:coverage
npm run test:package
```

`verify` checks types, lint, formatting, module boundaries, local Markdown links and the test suite. `test:package` builds a tarball, installs production dependencies in a temporary prefix, then runs the installed CLI outside the checkout. It needs npm registry access. `npm run format` applies the shared style. Do not edit generated `dist/` output.

## Changes and tests

- Keep core behavior in `packages/`; CLI argument parsing and lifecycle belong in `apps/`. Update the architecture check deliberately when adding a module.
- Permission, protocol, persistence, task and transport changes need a regression test for the behavior they change, including relevant failure paths. Cosmetic/documentation changes do not need artificial tests.
- Use `node:test`, real temporary directories, loopback sockets and child processes where the boundary matters. All resources must have teardown; avoid timing-only assertions when an observable event is available.
- Synthetic Claude events must be labeled synthetic. Do not check in raw transcripts, credentials, real host identifiers or private project data.
- No implicit API-key fallback, remote project tools, automatic retry of uncertain effects, disabling TLS validation or broad automatic approval.
- Update the README/help/quick start when changing an entrypoint, and the compatibility table when adding or removing support.

TypeScript is pinned to 6.0.3 because the current typed ESLint parser supports `<6.1`. Upgrade the compiler and parser together after checking their compatibility. Exact direct dependencies and the lockfile are intentional.

## Pull requests

Use a focused branch and describe the user-visible problem, resulting behavior and actual validation. State whether model calls were used. CI must pass on the proposed head; a local run alone is not GitHub CI evidence. Changes to storage/protocol contracts need migration or explicit incompatibility notes. Do not include generated installation bundles in git.

Contributions are made under the repository's existing [GPL-3.0 license](LICENSE). Do not copy proprietary Claude source or redistribute its binary. Maintainer publishing and supported-release policy are in [RELEASING.md](docs/RELEASING.md). Security issues should use [SECURITY.md](SECURITY.md).
