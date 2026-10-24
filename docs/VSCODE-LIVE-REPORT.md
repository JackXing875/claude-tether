# VS Code adapter and GPU validation

Recorded on 2026-10-24 (Asia/Shanghai) for Tether `0.3.0-beta.3` on WSL2 Linux x64, Node.js 24.14.0 and bubblewrap 0.9.0.

## Real Claude / SDK transport

The test used the installed official VS Code extension's **Claude 2.1.309 binary**, passed as argument one to `tether-vscode`, through a verified SSH connection to a real VPS. A separate official Pro profile reported `loggedIn: true`, `authMethod: claude.ai`, `apiProvider: firstParty` and `subscriptionType: pro`. No credentials were copied into the project or test reports.

The official Agent SDK `0.3.309` drove the same bidirectional stdin/stdout transport used by the panel. Dependencies for this live harness were installed only in an ignored artifact directory; Tether still has zero npm runtime dependencies.

Passed:

- SDK initialization and supported-model discovery through the adapter.
- A real Sonnet response reading a local fixture, invoking a host-side in-process MCP diagnostics fixture, running a local Python GPU probe through Bash, and writing an output file.
- Permission requests for MCP, Bash and Write returned to the SDK host and were approved individually for those fixture operations. No permission bypass mode was used.
- PreToolUse callbacks for Read, MCP, Bash and Write crossed the bidirectional protocol successfully.
- `setModel('opus')` was acknowledged; the next turn in the same session produced a real Opus response. Assistant response metadata identified Sonnet and Opus respectively.
- The generated output file contained the expected marker; the diagnostics fixture was called once.
- Tether reported isolated networking, and the Python tool's direct connection to an external IP failed with `ENETUNREACH`.

The diagnostics server was a controlled SDK fixture, **not a running VS Code Problems panel**. These tests validate real Claude, SDK callbacks and wrapper transport, not clicks, rendered diffs, editor selection, or every desktop extension action.

After installing the published beta.3 artifact and configuring Remote WSL, the user reloaded VS Code and confirmed that a new conversation in the official native panel replied normally. This is user-reported acceptance of basic panel chat. Rendered diffs, editor selection, notebook integration and other desktop interactions were not independently verified. See [setup and boundaries](VSCODE.md).

## GPU access

The host had an NVIDIA GeForce RTX 4060 Laptop GPU with driver 617.42. Before the change, `nvidia-smi` inside the old namespace failed with “GPU access blocked by the operating system”. Mounting only the WSL GPU character device `/dev/dxg` restored detection without restoring external IP routes or Windows interop.

After the change, both a direct namespace probe and the real Claude Bash tool successfully ran **PyTorch 2.9.1+cu128 / CUDA 12.8** on that GPU. A 4×4 matrix multiplication completed on CUDA; its sum was **3920**, matching the CPU result. The real Claude tool also verified that direct IP access stayed blocked.

Native Linux NVIDIA, AMD/ROCm and DRM hardware paths are supported by explicit device discovery but were not tested on physical hardware here. Driver installation, host device permissions, CPU-only Python packages, multi-GPU collectives and the official CLI's separate optional Bash sandbox have their own requirements.

## Automated and package coverage

All **34 automated tests** passed on the WSL host. Added coverage exercises the wrapper with real SSH and bubblewrap: bundled executable selection over a saved default, spaces in executable paths, literal SDK arguments, duplex stdin/stdout and EOF, profile/working-directory preservation, exit status, cancellation and detached-child cleanup. GPU checks verify device identity after mounting and reject ordinary files and symlinks.

Existing tests still cover blocked direct IPv4, IPv6, UDP, DNS and host-loopback connections, SSH recovery, streaming, cancellation and missing-isolation failure. The packed-installation test checks all three executable entry points. Hardware evidence above is separate from CPU-only CI runners.

The wrapper does not isolate the VS Code extension host or its own account/Web/dictation/telemetry requests. This release makes no claim that all VS Code traffic exits through the VPS, or that network isolation prevents account restrictions.
