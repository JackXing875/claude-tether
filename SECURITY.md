# Security policy

This is a development alpha with no production support or security-response SLA. Only the current main branch and newest alpha are maintained. A green CI run does not certify a secure sandbox or a verified Claude integration.

## Report a vulnerability

Use the repository's private **Report a vulnerability** interface if it is available on the [Security page](https://github.com/JackXing875/claude-tether/security). If private reporting is not enabled, open an issue with a minimal request for a private reporting channel; do not include exploit details, credentials or private data until a channel is established. No private reporting configuration is assumed to be enabled by this file.

Include the affected commit/version, environment, minimal reproduction using disposable data, expected behavior and impact. Never attach device files, SQLite state, raw Claude transcripts, environment dumps or subscription tokens.

## Boundaries

- The relay sees prompts, requested file contents and tool results. State databases and official transcripts may contain source code.
- Device credentials authenticate to your relay only; official Claude login belongs on the VPS's dedicated account.
- Local approval is the final authority for writes and commands. Approved commands have the local user's privileges; a cwd is not a sandbox.
- File tools reject symlinks and stale revisions. They do not promise isolation from another hostile process with the same local user privileges.
- A crash with uncertain effects blocks further mutations. Deleting state to bypass `UNKNOWN` is unsafe recovery.
- Plaintext WS is restricted to explicit numeric loopback use. Public transport requires verified TLS.

If a device file is exposed, stop the relay, revoke its device ID with `tether device revoke --id ID`, and provision a fresh credential. Subscription credential incidents must be handled through the official account controls as well. See the [runbook](docs/RUNBOOK.md) for operational details.
