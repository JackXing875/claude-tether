# Experimental ccproxy connector

The optional `--ccproxy-port` connects a local loopback gateway to **127.0.0.1 on the VPS through SSH**. It sets `ANTHROPIC_BASE_URL` only for the launched Claude process. Other HTTP(S) requests still use the normal SSH proxy. No additional public port or copied OAuth credential is required by the connector.

```bash
# Requires an independently configured and reviewed gateway on VPS loopback.
tether doctor --ccproxy-port 4000
tether --ccproxy-port 4000
# Save only when ready to use it routinely:
tether setup my-vps --ccproxy-port 4000
# Temporarily bypass a saved gateway while retaining SSH/network isolation:
tether --no-ccproxy
```

The SSH key must permit `127.0.0.1:4000` in addition to the destinations used by ordinary HTTPS. A key restricted to `*:443` will reject this connection. `doctor` checks TCP reachability only, not gateway identity, authentication or model compatibility.

The gateway receives the client's authorization header and plaintext API request. It is a separate trusted component. The default direct SSH transport keeps HTTPS end to end; enabling a gateway changes that trust boundary.

## What was tested

The reviewed project is [starbaser/ccproxy](https://github.com/starbaser/ccproxy), source commit [`f2c47695b0835da023257aee0ac2a3dffd9fe570`](https://github.com/starbaser/ccproxy/tree/f2c47695b0835da023257aee0ac2a3dffd9fe570), package `ai-ccproxy` 2.0.0, Python 3.13+, AGPL-3.0-or-later. Do not mix its current configuration with the older `claude-ccproxy` package/release instructions. Tether does not bundle or modify its code.

The connector's automated fixtures exercise actual SSH, the isolated namespace, model values, beta/auth headers, SSE tool argument deltas and 429/Retry-After responses. The pinned upstream was also installed separately and tested against a local synthetic server inside a network namespace without an external route. Two model names, SSE bytes, tools, metadata, bearer headers, `/v1/messages/count_tokens`, and a 429 error passed unchanged. No real credential was used. This is protocol evidence, not a real Pro-account gateway test.

## Why it remains disabled by default

The current upstream has properties that do not yet fit Tether's default stability/privacy goal:

- [`MitmproxyOptions.ssl_insecure`](https://github.com/starbaser/ccproxy/blob/f2c47695b0835da023257aee0ac2a3dffd9fe570/src/ccproxy/config.py) defaults to `true`. Explicitly setting `inspector.mitmproxy.ssl_insecure: false` is required for upstream certificate verification.
- [`_run_inspect`](https://github.com/starbaser/ccproxy/blob/f2c47695b0835da023257aee0ac2a3dffd9fe570/src/ccproxy/cli.py) assigns TLS key-log paths and exports WireGuard keys. The synthetic run created `tls.keylog` and `wg.keylog` even with ordinary file logging disabled. `log_file: null` does not disable those exports.
- The [inspector](https://github.com/starbaser/ccproxy/blob/f2c47695b0835da023257aee0ac2a3dffd9fe570/src/ccproxy/inspector/addon.py) keeps request/response snapshots, including headers and bodies, in memory for inspection/export. This must not be described as a no-capture gateway.
- The [listener builder](https://github.com/starbaser/ccproxy/blob/f2c47695b0835da023257aee0ac2a3dffd9fe570/src/ccproxy/inspector/process.py) constructs listeners without applying the top-level `host` field as `listen_host`. Merely putting `host: 127.0.0.1` in YAML is insufficient evidence of loopback-only exposure; verify actual sockets or use a separate network boundary.
- Its dependency ranges are broad. Pinning source alone does not freeze its Python dependencies. Record and validate the resolved environment before deployment.

The test disabled shaping, configured no provider-managed authentication and routed to a synthetic destination. Startup readiness had to be disabled through `CCPROXY_VERIFY_READINESS_ON_STARTUP=false`; that field in YAML alone was not loaded by this revision. The test namespace prevented any external request or listener exposure.

To reproduce only the synthetic compatibility test from a Tether checkout, install the pinned upstream in a disposable Python 3.13 environment using the [recorded dependency constraints](evidence/ccproxy-synthetic-constraints.txt), then run:

```bash
CCPROXY_TEST_BINARY=/absolute/path/to/venv/bin/ccproxy \
  bwrap --unshare-user --unshare-net --unshare-pid --bind / / \
  --proc /proc --dev /dev --tmpfs /run --die-with-parent \
  -- node scripts/test-ccproxy.mjs
```

The harness refuses a namespace with any non-loopback interface, creates a separate HOME/config directory, uses only synthetic credentials and removes its generated keys after the run. It is separate from `npm test`; Python/ccproxy are not Tether runtime or CI dependencies.

No ccproxy daemon was installed on the user's VPS and no real Pro credential was sent through it for this release. Before enabling routine use, resolve key-log/capture policy and listener exposure, pin dependencies, then validate real official-client authentication, cancellation, long streams and upgrades. The connector is available for that work without making the upstream a mandatory dependency.

## Identity shaping

ccproxy has request shaping and explicit transport fingerprint profiles. Those mechanisms alter some request characteristics; they do not prove that an account cannot be identified or restricted. The official local client already supplies its own protocol, tools, model menu and OAuth flow. Tether therefore does not enable captured-identity replay, token substitution or fingerprint spoofing. Its implemented improvements are route enforcement, reconnection, lifecycle cleanup and protocol preservation.
