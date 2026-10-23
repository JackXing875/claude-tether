# Security policy

Only the latest beta receives security fixes. This is an early-stage project; it has not undergone an independent security audit.

## Reporting

Use the repository's **Security → Report a vulnerability** option when private reporting is available. Otherwise, open an issue requesting a private reporting channel without including exploit details, credentials, private hostnames or account information. Do not post tokens, private keys, model request bodies or raw credential files.

Include the affected version, operating system, a minimal reproduction using disposable local services, and the observed impact. A maintainer will arrange follow-up; no response-time guarantee is currently offered.

## Boundaries

The local proxy binds only to loopback. OpenSSH authenticates the server and user; TLS remains end to end. Tether does not store Claude or SSH credentials, bypass host/certificate checks, replay requests, or expose a public proxy.

Local processes that can reach the loopback listener may use its tunnel while it is running. Tether is intended for a trusted single-user machine, not as an isolation boundary between untrusted local users. A VPS operator can observe connection metadata and destinations; TLS content is not decrypted by Tether.
