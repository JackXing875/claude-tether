# Security policy

Only the latest beta receives security fixes. This is an early-stage project; it has not undergone an independent security audit.

## Reporting

Use the repository's **Security → Report a vulnerability** option when private reporting is available. Otherwise, open an issue requesting a private reporting channel without including exploit details, credentials, private hostnames or account information. Do not post tokens, private keys, model request bodies or raw credential files.

Include the affected version, operating system, a minimal reproduction using disposable local services, and the observed impact. A maintainer will arrange follow-up; no response-time guarantee is currently offered.

## Boundaries

The default Linux/WSL isolated mode has no external IP route. Ordinary Claude descendants cannot regain direct IP egress by changing proxy settings. Proxy-unaware traffic is blocked. Explicit `--network proxy` mode only supplies environment variables and can be bypassed by settings. See [network boundaries](docs/NETWORK.md).

Starting in beta.6, the default process mode is `host`, sharing the host PID view while retaining user/network/mount restrictions. Claude can see host processes and signal them where the user's permissions allow. Host procfs internals may still be denied; there is no host ptrace privilege grant. `--processes isolated` restores a private PID namespace. Host-mode descendant cleanup uses a subreaper and parent-death signal; forcibly killing that supervisor can prevent cleanup, unlike kernel PID namespace teardown.

Host-mode inotify diagnostics expose a fixed read-only operation over a mode-0600 socket in the private IPC directory. They scan only the launcher's UID, return process names rather than command lines/environment, report incomplete reads and bound scan duration, response size and clients. This is not a general command bridge or an authority escalation.

Local TCP listeners bind only to loopback, and namespace bridges use a private temporary directory. OpenSSH authenticates the server and user; HTTPS remains end to end on the default transport. Ordinary HTTP is plaintext at its destination. Tether does not store Claude or SSH credentials, bypass host/certificate checks, replay requests, or expose a public proxy.

Local processes that can reach the loopback listener may use its tunnel while it is running. Tether is intended for a trusted single-user machine, not as an isolation boundary between untrusted local users. A VPS operator can observe connection metadata and destinations; TLS content is not decrypted by Tether.

The filesystem remains accessible to Claude. Filesystem Unix sockets, cooperating host programs and privileged processes are outside the IP egress guarantee. This is not a hostile-code sandbox or an identity mask. No account-safety guarantee is provided.

Enabling the experimental ccproxy connector sends authorization and plaintext API content to that separately trusted gateway. Current upstream key-log, capture and listener concerns are documented in [CCPROXY.md](docs/CCPROXY.md); synthetic compatibility tests do not establish suitability for real account credentials.
