# Release procedure

Releases remain alpha. The remote-agent prototype and the planned native-client/ccproxy route have separate [acceptance gates](ROADMAP.md); identify which one a release actually implements. The existing GPL license is retained. npm registry publishing is intentionally disabled by `private: true`; no publishing token is required by CI.

1. Update package version, lockfile, changelog and versioned quick-start examples together. Record supported Node/Claude versions and storage/protocol compatibility changes.
2. Run `npm ci`, `npm run verify`, `npm run test:coverage`, `npm run test:package` and the appropriate real-account checks if runtime behavior changed. Verify the proposed GitHub head is green.
3. Review `artifacts/` and `SHA256SUMS`. The package must contain its JS, type declarations, corresponding original TypeScript and license, and no credentials, private state or Claude binary.
4. After maintainer review, create a version tag matching `v` plus `package.json` version. The release workflow repeats checks and creates downloadable package/source/checksum artifacts; it does not automatically publish a GitHub Release or npm package.
5. Publish a GitHub prerelease manually from the reviewed artifacts with supported platforms, exact evidence and remaining limitations. Attach the source archive and checksums with the tarball. Do not mark a fake-runtime-only build stable.

The workflow is also manually runnable to inspect a candidate. A tagged build rejects a version mismatch. Third-party Actions are pinned by commit and dependency updates are proposed through Dependabot; review their release notes before merging.

For an installed client or relay, stop active processes before upgrading. Back up private state after shutdown, keep the previous tarball, and use the documented rollback path. If a future release changes the schema, it must supply a tested migration and rollback/restore instructions before publication. Never apply a downgrade directly to an unknown newer schema.

Reference: npm documents the meaning of `bin`, `files`, lifecycle scripts and `private` in its [package manifest reference](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/). Typed lint configuration follows the [typescript-eslint documentation](https://typescript-eslint.io/getting-started/typed-linting/).
