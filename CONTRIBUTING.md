# Contributing

Tether is an early beta focused on a small, dependable launch and transport layer. Please open an issue before adding a major capability, a runtime dependency or a server-side component.

## Development environment

Use Node.js from `.nvmrc`. On Ubuntu/Debian, integration tests also need:

```bash
sudo apt-get install openssh-client openssh-server openssl bubblewrap
sudo mkdir -p /run/sshd
npm ci
npm test
npm run test:package
npm audit --omit=dev
```

The tests start their own unprivileged loopback sshd with temporary credentials. A system-wide SSH service does not need to be running. Package tests use a temporary npm prefix and clean it up afterward.

Read [START.md](START.md) for module boundaries and reliability rules. Keep changes focused, preserve official CLI behavior, and add regression coverage for observable failures. Network tests should use local fixtures rather than public services or personal accounts.

## Pull requests

Describe the problem, changed behavior and relevant validation. Keep source, documentation and the supported-platform claims consistent. Do not include credentials, real server addresses, account details or captured model requests. Contributions are submitted under this repository's GPL-3.0-only license.

## Beta releases

1. Update `package.json`, the lockfile, `CHANGELOG.md` and `docs/releases/<tag>.md`.
2. Run the tests, package installation check and dependency audit.
3. Merge the validated version change into `main`. A `package.json` change triggers the release workflow, which creates a matching `vX.Y.Z-beta.N` tag only after validation. Tag pushes and manual dispatch on `main` are also supported.

The disposable GitHub runner enables unprivileged user namespaces for isolation tests; this does not change a user machine's policy.

The release workflow checks that the tag matches the package version, repeats validation, creates a prebuilt npm tarball and SHA-256 manifest, and publishes a GitHub prerelease. It does not publish to npm. Release tags should not be moved or reused; fixes belong in the next beta.

The tarball includes the source and build configuration under the same license. GitHub also provides the complete source snapshot for each tag.
